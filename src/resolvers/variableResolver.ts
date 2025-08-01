import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from '../utils/logger';
import { TerraformParser } from '../parsers/terraformParser';
import { TerraformCache } from '../utils/cache';

const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const access = promisify(fs.access);

interface VariableDefinition {
    name: string;
    value: any;
    type: 'variable' | 'local' | 'output' | 'module_output';
    source: string;
    line?: number;
}

interface ModuleCall {
    name: string;
    source: string;
    variables: { [key: string]: string };
    location: vscode.Range;
    resolvedPath?: string;
}

export class TerraformVariableResolver {
    private cache: TerraformCache;
    private parser: TerraformParser;
    private fileWatcher: vscode.FileSystemWatcher | null = null;
    private readonly maxRecursionDepth = 10;
    private resolvedModulePaths = new Map<string, string>();

    constructor(
        private workspaceRoot: string,
        private logger: Logger
    ) {
        this.cache = new TerraformCache(this.logger);
        this.parser = new TerraformParser(this.logger);
        this.setupFileWatcher();
        this.logger.info(`TerraformVariableResolver initialized for: ${workspaceRoot}`);
    }

    async dispose(): Promise<void> {
        this.logger.info('Disposing TerraformVariableResolver...');
        
        try {
            if (this.fileWatcher) {
                this.fileWatcher.dispose();
                this.fileWatcher = null;
            }
            
            this.cache.dispose();
            this.resolvedModulePaths.clear();
        } catch (error) {
            this.logger.error('Error disposing variable resolver', error);
        }
    }

    async clearCache(): Promise<void> {
        this.cache.clear();
        this.resolvedModulePaths.clear();
        this.logger.info('Variable resolver cache cleared');
    }

    getCacheSize(): number {
        return this.cache.size();
    }

    getFromCache(key: string): string | null {
        return this.cache.get(key);
    }

    setCache(key: string, value: string): void {
        this.cache.set(key, value);
    }

    private setupFileWatcher(): void {
        try {
            this.fileWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceRoot, '**/*.{tf,tfvars,tfvars.json}')
            );

            this.fileWatcher.onDidChange((uri) => {
                this.handleFileChange(uri.fsPath, 'changed');
            });

            this.fileWatcher.onDidCreate((uri) => {
                this.handleFileChange(uri.fsPath, 'created');
            });

            this.fileWatcher.onDidDelete((uri) => {
                this.handleFileChange(uri.fsPath, 'deleted');
            });

            this.logger.debug('File watcher setup completed');
        } catch (error) {
            this.logger.error('Failed to setup file watcher', error);
        }
    }

    private handleFileChange(filePath: string, changeType: string): void {
        try {
            this.cache.invalidateFile(filePath);
            this.logger.debug(`File ${changeType}: ${filePath}, cache invalidated`);
        } catch (error) {
            this.logger.error(`Error handling file change: ${filePath}`, error);
        }
    }

    async resolveVariableValue(
        variableName: string,
        currentDir: string,
        visited: Set<string> = new Set(),
        depth: number = 0
    ): Promise<string | null> {
        if (depth > this.maxRecursionDepth) {
            this.logger.warn(`Maximum recursion depth reached for variable: ${variableName}`);
            return null;
        }

        const cacheKey = `resolve:${variableName}:${currentDir}:${depth}`;
        const cached = this.cache.get(cacheKey);
        if (cached !== null) {
            return cached;
        }

        // Prevent infinite recursion
        const visitKey = `${currentDir}:${variableName}:${depth}`;
        if (visited.has(visitKey)) {
            this.logger.debug(`Circular reference detected for: ${variableName} in ${currentDir}`);
            return null;
        }
        visited.add(visitKey);

        try {
            let resolvedValue: string | null = null;

            // Resolution order: tfvars -> locals -> outputs -> module outputs -> parent directories
            resolvedValue = await this.findInTfvarsFiles(variableName, currentDir);
            if (resolvedValue !== null) {
                this.cache.set(cacheKey, resolvedValue);
                return resolvedValue;
            }

            resolvedValue = await this.findInLocals(variableName, currentDir);
            if (resolvedValue !== null) {
                this.cache.set(cacheKey, resolvedValue);
                return resolvedValue;
            }

            resolvedValue = await this.findInOutputs(variableName, currentDir);
            if (resolvedValue !== null) {
                this.cache.set(cacheKey, resolvedValue);
                return resolvedValue;
            }

            // Handle module output references
            if (variableName.startsWith('module.')) {
                resolvedValue = await this.resolveModuleOutput(variableName, currentDir, visited, depth + 1);
                if (resolvedValue !== null) {
                    this.cache.set(cacheKey, resolvedValue);
                    return resolvedValue;
                }
            }

            // Search in parent directory
            const parentDir = path.dirname(currentDir);
            if (parentDir !== currentDir && this.isWithinWorkspace(parentDir)) {
                resolvedValue = await this.resolveVariableValue(variableName, parentDir, visited, depth + 1);
                if (resolvedValue !== null) {
                    this.cache.set(cacheKey, resolvedValue);
                    return resolvedValue;
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error resolving variable ${variableName} in ${currentDir}`, error);
            return null;
        } finally {
            visited.delete(visitKey);
        }
    }

    private isWithinWorkspace(dirPath: string): boolean {
        const normalizedDir = path.normalize(dirPath);
        const normalizedWorkspace = path.normalize(this.workspaceRoot);
        return normalizedDir.startsWith(normalizedWorkspace);
    }

    async resolveVariableInMultipleContexts(
        variableName: string,
        searchDirectories: string[]
    ): Promise<Array<{value: string, directory: string}>> {
        const results: Array<{value: string, directory: string}> = [];
        const promises = searchDirectories.map(async (dir) => {
            try {
                const value = await this.resolveVariableValue(variableName, dir);
                if (value && value.trim() !== '') {
                    return { value, directory: dir };
                }
            } catch (error) {
                this.logger.debug(`Failed to resolve ${variableName} in ${dir}`, error);
            }
            return null;
        });

        const resolvedResults = await Promise.all(promises);
        
        for (const result of resolvedResults) {
            if (result) {
                results.push(result);
            }
        }

        return results;
    }

    // MODIFIED: Enhanced findInTfvarsFiles to handle complex objects better
    private async findInTfvarsFiles(variableName: string, dir: string): Promise<string | null> {
        try {
            const cacheKey = `tfvars:${variableName}:${dir}`;
            const cached = this.cache.get(cacheKey);
            if (cached !== null) return cached;

            if (!(await this.directoryExists(dir))) {
                return null;
            }

            const files = await readdir(dir);
            const tfvarsFiles = files.filter(f => 
                f.endsWith('.tfvars') || f.endsWith('.tfvars.json')
            );

            for (const file of tfvarsFiles) {
                const filePath = path.join(dir, file);
                
                try {
                    const content = await readFile(filePath, 'utf8');
                    let value: string | null = null;

                    if (file.endsWith('.json')) {
                        value = this.parser.parseJsonVariable(content, variableName);
                    } else {
                        value = this.parser.parseHclVariable(content, variableName);
                    }

                    if (value !== null) {
                        // Enhanced: Preserve complex objects in their original form
                        const preservedValue = this.preserveComplexStructure(value);
                        this.cache.set(cacheKey, preservedValue);
                        this.logger.debug(`Found variable ${variableName} in ${filePath}`);
                        return preservedValue;
                    }
                } catch (error) {
                    this.logger.error(`Error reading tfvars file: ${filePath}`, error);
                    continue;
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error searching tfvars files in ${dir}`, error);
            return null;
        }
    }

    // NEW: Enhanced recursive resolution that follows module variable chains
    async resolveVariableValueEnhanced(
        variableName: string,
        currentDir: string,
        visited: Set<string> = new Set(),
        depth: number = 0,
        moduleContext: string[] = []
    ): Promise<string | null> {
        if (depth > this.maxRecursionDepth) {
            this.logger.warn(`Maximum recursion depth reached for variable: ${variableName}`);
            return null;
        }

        const cacheKey = `enhanced:${variableName}:${currentDir}:${depth}:${moduleContext.join(',')}`;
        const cached = this.cache.get(cacheKey);
        if (cached !== null) {
            return cached;
        }

        // Prevent infinite recursion
        const visitKey = `${currentDir}:${variableName}:${depth}`;
        if (visited.has(visitKey)) {
            this.logger.debug(`Circular reference detected for: ${variableName} in ${currentDir}`);
            return null;
        }
        visited.add(visitKey);

        try {
            let resolvedValue: string | null = null;

            // FIXED: Enhanced resolution order with module context awareness
            
            // 1. First, try direct resolution in current directory
            resolvedValue = await this.findInTfvarsFiles(variableName, currentDir);
            if (resolvedValue !== null) {
                const finalValue = await this.resolveNestedReferences(resolvedValue, currentDir, visited, depth + 1);
                this.cache.set(cacheKey, finalValue);
                return finalValue;
            }

            resolvedValue = await this.findInLocals(variableName, currentDir);
            if (resolvedValue !== null) {
                const finalValue = await this.resolveNestedReferences(resolvedValue, currentDir, visited, depth + 1);
                this.cache.set(cacheKey, finalValue);
                return finalValue;
            }

            resolvedValue = await this.findInOutputs(variableName, currentDir);
            if (resolvedValue !== null) {
                const finalValue = await this.resolveNestedReferences(resolvedValue, currentDir, visited, depth + 1);
                this.cache.set(cacheKey, finalValue);
                return finalValue;
            }

            // 2. FIXED: Check if we're in a module and the variable might be passed from parent
            if (moduleContext.length === 0) {
                const moduleVariable = await this.resolveAsModuleInput(variableName, currentDir, visited, depth + 1);
                if (moduleVariable !== null) {
                    this.cache.set(cacheKey, moduleVariable);
                    return moduleVariable;
                }
            }

            // 3. Handle module output references
            if (variableName.startsWith('module.')) {
                resolvedValue = await this.resolveModuleOutput(variableName, currentDir, visited, depth + 1);
                if (resolvedValue !== null) {
                    const finalValue = await this.resolveNestedReferences(resolvedValue, currentDir, visited, depth + 1);
                    this.cache.set(cacheKey, finalValue);
                    return finalValue;
                }
            }

            // 4. FIXED: Search in parent directories with enhanced logic
            const parentDir = path.dirname(currentDir);
            if (parentDir !== currentDir && this.isWithinWorkspace(parentDir)) {
                // Check if parent has a module that might be calling our current directory
                const parentModuleValue = await this.findVariableInParentModule(variableName, currentDir, parentDir, visited, depth + 1);
                if (parentModuleValue !== null) {
                    this.cache.set(cacheKey, parentModuleValue);
                    return parentModuleValue;
                }
                
                // Regular parent directory search
                resolvedValue = await this.resolveVariableValueEnhanced(variableName, parentDir, visited, depth + 1, moduleContext);
                if (resolvedValue !== null) {
                    this.cache.set(cacheKey, resolvedValue);
                    return resolvedValue;
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error in enhanced resolution for ${variableName} in ${currentDir}`, error);
            return null;
        } finally {
            visited.delete(visitKey);
        }
    }

    // NEW: Resolve variable as module input from parent
    private async resolveAsModuleInput(
        variableName: string,
        moduleDir: string,
        visited: Set<string>,
        depth: number
    ): Promise<string | null> {
        try {
            const parentDir = path.dirname(moduleDir);
            if (!this.isWithinWorkspace(parentDir)) {
                return null;
            }

            // Find modules in parent that reference our current directory
            const moduleCalls = await this.findModuleCallsToDirectory(parentDir, moduleDir);
            
            for (const moduleCall of moduleCalls) {
                // Check if this module call passes our variable
                if (moduleCall.variables[variableName]) {
                    const variableReference = moduleCall.variables[variableName];
                    
                    // Resolve the variable reference in the parent context
                    const resolvedRef = await this.resolveVariableReference(variableReference, parentDir, visited, depth);
                    if (resolvedRef !== null) {
                        this.logger.debug(`Resolved ${variableName} via module input: ${variableReference} -> ${resolvedRef}`);
                        return resolvedRef;
                    }
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error resolving module input for ${variableName}`, error);
            return null;
        }
    }

    // NEW: Find module calls that point to a specific directory
    private async findModuleCallsToDirectory(searchDir: string, targetDir: string): Promise<Array<{
        name: string;
        source: string;
        variables: { [key: string]: string };
    }>> {
        const moduleCalls: Array<{name: string; source: string; variables: { [key: string]: string }}> = [];
        
        try {
            if (!(await this.directoryExists(searchDir))) {
                return moduleCalls;
            }

            const files = await readdir(searchDir);
            const tfFiles = files.filter(f => f.endsWith('.tf'));

            for (const file of tfFiles) {
                const filePath = path.join(searchDir, file);
                const content = await readFile(filePath, 'utf8');
                
                // Find all module blocks
                const moduleRegex = /module\s+"(\w+)"\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
                let match;
                
                while ((match = moduleRegex.exec(content)) !== null) {
                    const moduleName = match[1];
                    const moduleContent = match[2];
                    
                    // Extract source
                    const sourceMatch = /source\s*=\s*"([^"]*)"/.exec(moduleContent);
                    if (!sourceMatch) continue;
                    
                    // Check if source points to our target directory
                    const resolvedSource = await this.resolveModulePath(sourceMatch[1], searchDir);
                    if (resolvedSource === targetDir) {
                        moduleCalls.push({
                            name: moduleName,
                            source: sourceMatch[1],
                            variables: this.parser.parseModuleVariables(moduleContent)
                        });
                    }
                }
            }
        } catch (error) {
            this.logger.error(`Error finding module calls to ${targetDir}`, error);
        }

        return moduleCalls;
    }

    // NEW: Resolve a variable reference (like var.something) in a specific context
    private async resolveVariableReference(
        reference: string,
        contextDir: string,
        visited: Set<string>,
        depth: number
    ): Promise<string | null> {
        try {
            // Clean the reference (remove quotes, etc.)
            const cleanRef = reference.replace(/['"]/g, '').trim();
            
            // Handle different reference types
            if (cleanRef.startsWith('var.')) {
                const varName = cleanRef.substring(4);
                return await this.resolveVariableValueEnhanced(varName, contextDir, visited, depth);
            } else if (cleanRef.startsWith('local.')) {
                const localName = cleanRef.substring(6);
                return await this.findInLocals(localName, contextDir);
            } else if (cleanRef.startsWith('module.')) {
                return await this.resolveModuleOutput(cleanRef, contextDir, visited, depth);
            } else {
                // Direct value
                return cleanRef;
            }
        } catch (error) {
            this.logger.error(`Error resolving variable reference: ${reference}`, error);
            return null;
        }
    }

    // NEW: Find variable in parent module that calls current directory
    private async findVariableInParentModule(
        variableName: string,
        currentDir: string,
        parentDir: string,
        visited: Set<string>,
        depth: number
    ): Promise<string | null> {
        try {
            // Find modules in parent that call our current directory
            const moduleCalls = await this.findModuleCallsToDirectory(parentDir, currentDir);
            
            for (const moduleCall of moduleCalls) {
                // Look for variable assignments in the module call
                if (moduleCall.variables[variableName]) {
                    const variableRef = moduleCall.variables[variableName];
                    const resolved = await this.resolveVariableReference(variableRef, parentDir, visited, depth);
                    if (resolved !== null) {
                        return resolved;
                    }
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error finding variable in parent module`, error);
            return null;
        }
    }

    // NEW: Resolve nested references within a resolved value
    private async resolveNestedReferences(
        value: string,
        contextDir: string,
        visited: Set<string>,
        depth: number
    ): Promise<string> {
        if (!value || typeof value !== 'string') {
            return value;
        }

        try {
            let resolvedValue = value;
            
            // Find and resolve all variable references in the value
            const varRefs = this.parser.extractVariableReferences(value);
            
            for (const varRef of varRefs) {
                const resolved = await this.resolveVariableReference(varRef, contextDir, visited, depth);
                if (resolved !== null && resolved !== varRef) {
                    // Replace the reference with the resolved value
                    const refPattern = new RegExp(`\\b${varRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
                    resolvedValue = resolvedValue.replace(refPattern, resolved);
                }
            }

            return resolvedValue;
        } catch (error) {
            this.logger.error('Error resolving nested references', error);
            return value;
        }
    }

    // NEW: Preserve complex structure formatting
    private preserveComplexStructure(value: string): string {
        if (!value) return value;
        
        const trimmed = value.trim();
        
        // If it's a complex object or array, preserve formatting
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            
            // Try to format it nicely
            try {
                // If it's JSON-like, parse and re-stringify with formatting
                if (this.looksLikeJson(trimmed)) {
                    const parsed = JSON.parse(trimmed);
                    return JSON.stringify(parsed, null, 2);
                }
                
                // If it's HCL-like, preserve the structure but clean it up
                return this.formatHclStructure(trimmed);
            } catch {
                // If formatting fails, return as-is
                return trimmed;
            }
        }
        
        return trimmed;
    }

    // NEW: Check if string looks like JSON
    private looksLikeJson(str: string): boolean {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    }

    // NEW: Format HCL structure for better display
    private formatHclStructure(hclStr: string): string {
        if (!hclStr) return hclStr;
        
        // Basic HCL formatting
        let formatted = hclStr;
        
        // Add proper line breaks after commas in objects
        formatted = formatted.replace(/,\s*(?=[^"]*(?:"[^"]*"[^"]*)*$)/g, ',\n  ');
        
        // Add proper indentation
        const lines = formatted.split('\n');
        let indentLevel = 0;
        const indentedLines = lines.map(line => {
            const trimmedLine = line.trim();
            
            if (trimmedLine.includes('}') || trimmedLine.includes(']')) {
                indentLevel = Math.max(0, indentLevel - 1);
            }
            
            const indentedLine = '  '.repeat(indentLevel) + trimmedLine;
            
            if (trimmedLine.includes('{') || trimmedLine.includes('[')) {
                indentLevel++;
            }
            
            return indentedLine;
        });
        
        return indentedLines.join('\n');
    }

    private async findInOutputs(variableName: string, dir: string): Promise<string | null> {
        try {
            const cacheKey = `outputs:${variableName}:${dir}`;
            const cached = this.cache.get(cacheKey);
            if (cached !== null) return cached;

            if (!(await this.directoryExists(dir))) {
                return null;
            }

            const files = await readdir(dir);
            const tfFiles = files.filter(f => f.endsWith('.tf'));

            for (const file of tfFiles) {
                const filePath = path.join(dir, file);
                
                try {
                    const content = await readFile(filePath, 'utf8');
                    const value = this.parser.parseOutputBlock(content, variableName);
                    
                    if (value !== null) {
                        this.cache.set(cacheKey, value);
                        this.logger.debug(`Found output ${variableName} in ${filePath}`);
                        return value;
                    }
                } catch (error) {
                    this.logger.error(`Error reading tf file: ${filePath}`, error);
                    continue;
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error searching outputs in ${dir}`, error);
            return null;
        }
    }

    private async resolveModuleOutput(
        variableRef: string,
        currentDir: string,
        visited: Set<string>,
        depth: number
    ): Promise<string | null> {
        try {
            // Parse module.module_name.output_name
            const parts = variableRef.split('.');
            if (parts.length < 3 || parts[0] !== 'module') {
                return null;
            }

            const moduleName = parts[1];
            const outputName = parts.slice(2).join('.');

            // Find the module definition
            const moduleCall = await this.findModuleCall(moduleName, currentDir);
            if (!moduleCall) {
                this.logger.debug(`Module call not found: ${moduleName} in ${currentDir}`);
                return null;
            }

            // Resolve module source path
            const modulePath = await this.resolveModulePath(moduleCall.source, currentDir);
            if (!modulePath) {
                this.logger.debug(`Module path could not be resolved: ${moduleCall.source}`);
                return null;
            }

            // Look for the output in the module
            const outputValue = await this.findInOutputs(outputName, modulePath);
            if (outputValue !== null) {
                // If output references other variables, resolve them recursively
                return await this.resolveReferencesInValue(outputValue, modulePath, visited, depth + 1);
            }

            return null;
        } catch (error) {
            this.logger.error(`Error resolving module output: ${variableRef}`, error);
            return null;
        }
    }

    private async resolveReferencesInValue(
        value: string,
        contextDir: string,
        visited: Set<string>,
        depth: number
    ): Promise<string> {
        if (!value || typeof value !== 'string') {
            return value;
        }

        try {
            // Find variable references in the value
            const varRefs = this.parser.extractVariableReferences(value);
            let resolvedValue = value;

            for (const varRef of varRefs) {
                const resolvedRef = await this.resolveVariableValue(varRef, contextDir, visited, depth);
                if (resolvedRef !== null) {
                    // Replace the variable reference with resolved value
                    const refPattern = new RegExp(`\\b${varRef.replace('.', '\\.')}\\b`, 'g');
                    resolvedValue = resolvedValue.replace(refPattern, resolvedRef);
                }
            }

            return resolvedValue;
        } catch (error) {
            this.logger.error('Error resolving references in value', error);
            return value;
        }
    }

    private async findModuleCall(moduleName: string, dir: string): Promise<ModuleCall | null> {
        try {
            const cacheKey = `module:${moduleName}:${dir}`;
            const cached = this.cache.get(cacheKey);
            if (cached !== null) {
                return JSON.parse(cached);
            }

            if (!(await this.directoryExists(dir))) {
                return null;
            }

            const files = await readdir(dir);
            const tfFiles = files.filter(f => f.endsWith('.tf'));

            for (const file of tfFiles) {
                const filePath = path.join(dir, file);
                
                try {
                    const content = await readFile(filePath, 'utf8');
                    const moduleCall = this.parser.parseModuleBlock(content, moduleName);
                    
                    if (moduleCall) {
                        this.cache.set(cacheKey, JSON.stringify(moduleCall));
                        this.logger.debug(`Found module call ${moduleName} in ${filePath}`);
                        return moduleCall;
                    }
                } catch (error) {
                    this.logger.error(`Error reading tf file: ${filePath}`, error);
                    continue;
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error finding module call: ${moduleName} in ${dir}`, error);
            return null;
        }
    }

    private async resolveModulePath(source: string, currentDir: string): Promise<string | null> {
        try {
            const cacheKey = `modulePath:${source}:${currentDir}`;
            const cached = this.resolvedModulePaths.get(cacheKey);
            if (cached) {
                return cached;
            }

            let resolvedPath: string | null = null;

            // Handle relative paths
            if (source.startsWith('./') || source.startsWith('../')) {
                const candidatePath = path.resolve(currentDir, source);
                if (await this.directoryExists(candidatePath)) {
                    resolvedPath = candidatePath;
                }
            }
            // Handle absolute paths within workspace
            else if (source.startsWith('/')) {
                const candidatePath = path.join(this.workspaceRoot, source);
                if (await this.directoryExists(candidatePath)) {
                    resolvedPath = candidatePath;
                }
            }
            // Handle registry modules (not supported for local resolution)
            else if (source.includes('terraform.io') || source.includes('github.com')) {
                this.logger.debug(`Registry module not supported for local resolution: ${source}`);
                return null;
            }
            // Handle other relative paths
            else {
                const candidatePath = path.resolve(currentDir, source);
                if (await this.directoryExists(candidatePath)) {
                    resolvedPath = candidatePath;
                }
            }

            if (resolvedPath && this.isWithinWorkspace(resolvedPath)) {
                this.resolvedModulePaths.set(cacheKey, resolvedPath);
                this.logger.debug(`Resolved module path: ${source} -> ${resolvedPath}`);
                return resolvedPath;
            }

            return null;
        } catch (error) {
            this.logger.error(`Error resolving module path: ${source}`, error);
            return null;
        }
    }

    private async directoryExists(dirPath: string): Promise<boolean> {
        try {
            await access(dirPath, fs.constants.F_OK);
            const stats = await stat(dirPath);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    private async findInLocals(variableName: string, dir: string): Promise<string | null> {
        try {
            const cacheKey = `locals:${variableName}:${dir}`;
            const cached = this.cache.get(cacheKey);
            if (cached !== null) return cached;

            if (!(await this.directoryExists(dir))) {
                return null;
            }

            const files = await readdir(dir);
            const tfFiles = files.filter(f => f.endsWith('.tf'));

            for (const file of tfFiles) {
                const filePath = path.join(dir, file);
                
                try {
                    const content = await readFile(filePath, 'utf8');
                    const value = this.parser.parseLocalsBlock(content, variableName);
                    
                    if (value !== null) {
                        this.cache.set(cacheKey, value);
                        this.logger.debug(`Found local ${variableName} in ${filePath}`);
                        return value;
                    }
                } catch (error) {
                    this.logger.error(`Error reading locale file: ${filePath}`, error);
                    continue;
                }
            }

            return null;
        } catch (error) {
            this.logger.error(`Error searching locale files in ${dir}`, error);
            return null;
        }
    }
}