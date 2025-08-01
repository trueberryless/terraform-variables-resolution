import * as path from "path";
import * as vscode from "vscode";

import { TerraformVariableResolver } from "../resolvers/variableResolver";
import { ConfigurationManager } from "../utils/configurationManager";
import { Logger } from "../utils/logger";
import { PerformanceMonitor } from "../utils/performanceMonitor";

interface InlayHintWithPosition {
  hint: vscode.InlayHint;
  variableName: string;
  resolvedValue: string;
  position: vscode.Position;
}

export class TerraformInlayProvider implements vscode.InlayHintsProvider {
  private resolver: TerraformVariableResolver;
  private disposables: vscode.Disposable[] = [];
  private performanceMonitor: PerformanceMonitor;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private workspaceRoot: string,
    private logger: Logger,
    private configManager: ConfigurationManager
  ) {
    this.resolver = new TerraformVariableResolver(workspaceRoot, logger);
    this.performanceMonitor = new PerformanceMonitor(logger);
    this.logger.info(
      `TerraformInlayProvider initialized for workspace: ${workspaceRoot}`
    );
  }

  async dispose(): Promise<void> {
    this.logger.info("Disposing TerraformInlayProvider...");

    try {
      await this.resolver.dispose();
      this.disposables.forEach((d) => d.dispose());
      this.disposables = [];
      this.performanceMonitor.dispose();
    } catch (error) {
      this.logger.error("Error during provider disposal", error);
    }
  }

  async refresh(): Promise<void> {
    this.logger.info("Refreshing provider...");
    try {
      await this.resolver.clearCache();
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.logger.info("Provider refreshed successfully");
    } catch (error) {
      this.logger.error("Failed to refresh provider", error);
      throw error;
    }
  }

  clearCache(): void {
    this.resolver.clearCache();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  getCacheSize(): number {
    return this.resolver.getCacheSize();
  }

  getCacheHitRate(): number {
    const total = this.cacheHits + this.cacheMisses;
    return total > 0 ? Math.round((this.cacheHits / total) * 100) : 0;
  }

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    if (!this.configManager.isEnabled()) {
      return [];
    }

    if (!document.fileName.endsWith(".tf")) {
      return [];
    }

    const stopwatch = this.performanceMonitor.startTimer(
      `provideInlayHints-${path.basename(document.fileName)}`
    );

    try {
      const hints = await this.generateInlayHints(document, range, token);
      stopwatch.stop();

      this.logger.debug(
        `Generated ${hints.length} hints for ${document.fileName} in ${stopwatch.getDuration()}ms`
      );
      return hints;
    } catch (error) {
      stopwatch.stop();
      this.logger.error(
        `Failed to provide inlay hints for ${document.fileName}`,
        error
      );
      return [];
    }
  }

  private async generateInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    const hints: vscode.InlayHint[] = [];
    const text = document.getText(range);
    const currentDir = path.dirname(document.fileName);
    const processedPositions = new Set<string>();

    // Enhanced patterns for better variable detection
    const patterns = [
      {
        regex: /\bvar\.(\w+)\.(\w+)/g, // NEW: var.object.property access
        type: "variable_property" as const,
        prefix: "var.",
      },
      {
        regex: /\bvar\.(\w+)/g,
        type: "variable" as const,
        prefix: "var.",
      },
      {
        regex: /\blocal\.(\w+)\.(\w+)/g, // NEW: local.object.property access
        type: "local_property" as const,
        prefix: "local.",
      },
      {
        regex: /\blocal\.(\w+)/g,
        type: "local" as const,
        prefix: "local.",
      },
      {
        regex: /\bmodule\.([\w.]+)/g,
        type: "module" as const,
        prefix: "module.",
      },
      {
        regex: /\bdata\.([\w.]+)\.([\w.]+)/g,
        type: "data" as const,
        prefix: "data.",
      },
    ];

    for (const pattern of patterns) {
      let match;
      pattern.regex.lastIndex = 0; // Reset regex state

      while ((match = pattern.regex.exec(text)) !== null) {
        if (token.isCancellationRequested) {
          this.logger.debug("Inlay hint generation cancelled");
          return hints;
        }

        try {
          let variableName: string;
          let propertyName: string | null = null;

          // FIXED: Handle object property access
          if (
            pattern.type === "variable_property" ||
            pattern.type === "local_property"
          ) {
            variableName = match[1]; // The object name
            propertyName = match[2]; // The property being accessed
          } else {
            variableName = match[1] || match[0];
          }

          const fullMatch = match[0];
          const matchStart = range.start.character + match.index;
          const matchEnd = matchStart + fullMatch.length;

          // Calculate precise position at the end of the variable reference
          const endPosition = document.positionAt(
            document.offsetAt(range.start) + match.index + fullMatch.length
          );

          // Avoid duplicate hints at the same position
          const positionKey = `${endPosition.line}:${endPosition.character}:${fullMatch}`;
          if (processedPositions.has(positionKey)) {
            continue;
          }
          processedPositions.add(positionKey);

          // Ensure we're not inside a string or comment
          if (this.isInStringOrComment(document, endPosition)) {
            continue;
          }

          // FIXED: Resolve with property access support
          const allResolvedValues =
            await this.resolveVariableAllContextsWithProperty(
              variableName,
              propertyName,
              currentDir,
              pattern.type
            );

          if (allResolvedValues.length > 0) {
            const hint = this.createInlayHintWithMultipleValues(
              endPosition,
              allResolvedValues,
              propertyName ? `${variableName}.${propertyName}` : variableName
            );
            hints.push(hint);
          }
        } catch (error) {
          this.logger.error(
            `Error processing variable match: ${match[0]}`,
            error
          );
          continue; // Continue with other matches
        }
      }
    }

    return hints;
  }

  private async resolveVariableAllContextsWithProperty(
    variableName: string,
    propertyName: string | null,
    currentDir: string,
    type: string
  ): Promise<Array<{ value: string; context: string; source: string }>> {
    const resolvedValues: Array<{
      value: string;
      context: string;
      source: string;
    }> = [];
    const searchPaths = new Set<string>();

    // Add current directory
    searchPaths.add(currentDir);

    // Add workspace root and common environment directories
    const workspaceRoot = this.workspaceRoot;
    searchPaths.add(workspaceRoot);

    // Look for common environment patterns
    const commonEnvPaths = [
      "environments/dev",
      "environments/test",
      "environments/production",
      "environments/staging",
      "env/dev",
      "env/test",
      "env/production",
      "env/staging",
      "dev",
      "test",
      "production",
      "staging",
    ];

    for (const envPath of commonEnvPaths) {
      const fullPath = path.join(workspaceRoot, envPath);
      searchPaths.add(fullPath);
    }

    // Search in all paths
    for (const searchPath of searchPaths) {
      try {
        let resolvedValue: string | null = null;

        if (propertyName) {
          // FIXED: Resolve object property access
          resolvedValue = await this.resolveObjectProperty(
            variableName,
            propertyName,
            searchPath
          );
        } else {
          // Regular variable resolution with enhanced recursion
          resolvedValue = await this.resolver.resolveVariableValueEnhanced(
            variableName,
            searchPath
          );
        }

        if (resolvedValue && resolvedValue.trim() !== "") {
          const contextName = this.getContextName(searchPath, workspaceRoot);
          const existingValue = resolvedValues.find(
            (rv) => rv.value === resolvedValue
          );

          if (existingValue) {
            // Same value, different context - merge contexts
            existingValue.context += `, ${contextName}`;
          } else {
            resolvedValues.push({
              value: resolvedValue,
              context: contextName,
              source: searchPath,
            });
          }
        }
      } catch (error) {
        this.logger.debug(
          `Could not resolve ${variableName}${propertyName ? "." + propertyName : ""} in ${searchPath}`
        );
      }
    }

    return resolvedValues;
  }

  // NEW: Resolve object property access
  private async resolveObjectProperty(
    objectName: string,
    propertyName: string,
    searchPath: string
  ): Promise<string | null> {
    try {
      // First resolve the object
      const objectValue = await this.resolver.resolveVariableValueEnhanced(
        objectName,
        searchPath
      );

      if (!objectValue) {
        return null;
      }

      // Parse the object and extract the property
      return this.extractPropertyFromObject(objectValue, propertyName);
    } catch (error) {
      this.logger.error(
        `Error resolving object property ${objectName}.${propertyName}`,
        error
      );
      return null;
    }
  }

  // NEW: Extract property from resolved object
  private extractPropertyFromObject(
    objectValue: string,
    propertyName: string
  ): string | null {
    try {
      const trimmed = objectValue.trim();

      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
        return null;
      }

      // Try JSON parsing first
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed[propertyName] !== undefined) {
          return typeof parsed[propertyName] === "string"
            ? `"${parsed[propertyName]}"`
            : String(parsed[propertyName]);
        }
      } catch {
        // Not JSON, try HCL parsing
      }

      // HCL property extraction
      const propertyRegex = new RegExp(
        `${this.escapeRegex(propertyName)}\\s*=\\s*"([^"]*)"`,
        "i"
      );
      const quotedMatch = propertyRegex.exec(trimmed);
      if (quotedMatch) {
        return `"${quotedMatch[1]}"`;
      }

      // Unquoted values
      const unquotedRegex = new RegExp(
        `${this.escapeRegex(propertyName)}\\s*=\\s*([^\\s,}]+)`,
        "i"
      );
      const unquotedMatch = unquotedRegex.exec(trimmed);
      if (unquotedMatch) {
        return unquotedMatch[1];
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Error extracting property ${propertyName} from object`,
        error
      );
      return null;
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // NEW: Get context name from path
  private getContextName(searchPath: string, workspaceRoot: string): string {
    const relativePath = path.relative(workspaceRoot, searchPath);
    if (relativePath === "" || relativePath === ".") {
      return "root";
    }

    const parts = relativePath.split(path.sep);
    const lastPart = parts[parts.length - 1];

    // Check for environment patterns
    if (["dev", "test", "prod", "staging"].includes(lastPart)) {
      return lastPart;
    }

    return relativePath;
  }

  private async resolveVariableWithCache(
    variableName: string,
    currentDir: string,
    type: "variable" | "local" | "module" | "data"
  ): Promise<string | null> {
    const cacheKey = `${type}:${variableName}:${currentDir}`;

    try {
      const cached = this.resolver.getFromCache(cacheKey);
      if (cached !== null) {
        this.cacheHits++;
        return cached;
      }

      this.cacheMisses++;
      const resolved = await this.resolver.resolveVariableValue(
        variableName,
        currentDir
      );

      if (resolved !== null) {
        this.resolver.setCache(cacheKey, resolved);
      }

      return resolved;
    } catch (error) {
      this.logger.error(`Failed to resolve variable ${variableName}`, error);
      return null;
    }
  }

  private formatResolvedValue(value: string): string {
    if (!value || value.trim() === "") {
      return "";
    }

    // Handle complex objects
    if (value.trim().startsWith("{") && value.trim().endsWith("}")) {
      const content = value.trim().slice(1, -1).trim();
      if (content.length > 50 || content.includes("\n")) {
        return "complex object";
      }
      return `{ ${content} }`;
    }

    // Handle arrays
    if (value.trim().startsWith("[") && value.trim().endsWith("]")) {
      const content = value.trim().slice(1, -1).trim();
      if (content.length > 50 || content.includes("\n")) {
        return "array";
      }
      return `[${content}]`;
    }

    // Handle long strings
    if (value.length > 80) {
      return `"${value.substring(0, 75)}..."`;
    }

    // Handle strings without quotes
    if (
      !value.startsWith('"') &&
      !value.startsWith("'") &&
      !value.match(/^[\d.]+$/) &&
      !value.match(/^(true|false)$/)
    ) {
      return `"${value}"`;
    }

    return value;
  }

  private createInlayHintWithMultipleValues(
    position: vscode.Position,
    resolvedValues: Array<{ value: string; context: string; source: string }>,
    variableName: string
  ): vscode.InlayHint {
    let displayText: string;
    let tooltipContent: string;

    if (resolvedValues.length === 1) {
      const singleValue = resolvedValues[0];
      const formattedValue = this.formatResolvedValue(singleValue.value);

      // Check if it's a complex object
      if (this.isComplexObject(singleValue.value)) {
        displayText = " → complex object";
        tooltipContent = this.createComplexObjectTooltip(
          variableName,
          singleValue.value,
          singleValue.context
        );
      } else {
        displayText = ` → ${formattedValue}`;
        tooltipContent = this.createSingleValueTooltip(
          variableName,
          formattedValue,
          singleValue.context
        );
      }
    } else {
      // Multiple values
      displayText = " → multiple values";
      tooltipContent = this.createMultipleValuesTooltip(
        variableName,
        resolvedValues
      );
    }

    const hint = new vscode.InlayHint(
      position,
      displayText,
      vscode.InlayHintKind.Parameter
    );

    hint.tooltip = new vscode.MarkdownString(tooltipContent);
    hint.paddingLeft = true;
    hint.paddingRight = false;

    return hint;
  }

  // NEW: Check if value is a complex object
  private isComplexObject(value: string): boolean {
    if (!value) return false;

    const trimmed = value.trim();

    // Check for object notation
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const content = trimmed.slice(1, -1).trim();
      // Consider it complex if it has multiple key-value pairs or nested structures
      return (
        content.length > 50 ||
        content.includes("\n") ||
        content.split("=").length > 2 ||
        content.includes("{") ||
        content.includes("[")
      );
    }

    // Check for array notation
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const content = trimmed.slice(1, -1).trim();
      return (
        content.length > 50 ||
        content.includes("\n") ||
        content.includes("{") ||
        content.split(",").length > 3
      );
    }

    return false;
  }

  // NEW: Create tooltip for complex objects
  private createComplexObjectTooltip(
    variableName: string,
    value: string,
    context: string
  ): string {
    return (
      `**Terraform Variable:** \`${variableName}\`\n\n` +
      `**Context:** \`${context}\`\n\n` +
      `**Complex Object Value:**\n\n` +
      "```json\n" +
      this.formatComplexObjectForTooltip(value) +
      "\n```"
    );
  }

  // NEW: Create tooltip for single values
  private createSingleValueTooltip(
    variableName: string,
    value: string,
    context: string
  ): string {
    return (
      `**Terraform Variable:** \`${variableName}\`\n\n` +
      `**Context:** \`${context}\`\n\n` +
      `**Resolved Value:** \`${value}\``
    );
  }

  // NEW: Create tooltip for multiple values
  private createMultipleValuesTooltip(
    variableName: string,
    resolvedValues: Array<{ value: string; context: string; source: string }>
  ): string {
    const jsonData = this.createJsonFromResolvedValues(resolvedValues);

    return (
      `**Terraform Variable:** \`${variableName}\`\n\n` +
      `**Multiple Values Found (${resolvedValues.length}):**\n\n` +
      "```json\n" +
      jsonData +
      "\n```"
    );
  }

  // NEW: Create JSON from resolved values
  private createJsonFromResolvedValues(
    resolvedValues: Array<{ value: string; context: string; source: string }>
  ): string {
    const jsonObject: any = {};

    for (const resolved of resolvedValues) {
      try {
        // Try to parse the value as JSON if it looks like an object/array
        let parsedValue = resolved.value;
        if (
          (resolved.value.trim().startsWith("{") &&
            resolved.value.trim().endsWith("}")) ||
          (resolved.value.trim().startsWith("[") &&
            resolved.value.trim().endsWith("]"))
        ) {
          try {
            // Convert HCL-like syntax to JSON
            const jsonString = this.convertHclToJson(resolved.value);
            parsedValue = JSON.parse(jsonString);
          } catch {
            // Keep as string if parsing fails
            parsedValue = resolved.value;
          }
        }

        jsonObject[resolved.context] = parsedValue;
      } catch (error) {
        jsonObject[resolved.context] = resolved.value;
      }
    }

    return JSON.stringify(jsonObject, null, 2);
  }

  // NEW: Format complex object for tooltip display
  private formatComplexObjectForTooltip(value: string): string {
    try {
      // Try to convert HCL to JSON for better display
      const jsonString = this.convertHclToJson(value);
      const parsed = JSON.parse(jsonString);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // If conversion fails, return formatted HCL
      return value
        .split("\n")
        .map((line) => "  " + line.trim())
        .join("\n");
    }
  }

  // NEW: Convert HCL-like syntax to JSON
  private convertHclToJson(hclValue: string): string {
    if (!hclValue) return "{}";

    let jsonString = hclValue.trim();

    // Convert HCL object syntax to JSON
    if (jsonString.startsWith("{") && jsonString.endsWith("}")) {
      jsonString = jsonString
        .replace(/(\w+)\s*=/g, '"$1":') // Convert key = value to "key": value
        .replace(/:\s*"([^"]*)"(\s*[,}])/g, ': "$1"$2') // Ensure strings are quoted
        .replace(/:\s*([^",}\s]+)(\s*[,}])/g, ': "$1"$2') // Quote unquoted values
        .replace(/,(\s*})/g, "$1"); // Remove trailing commas
    }

    return jsonString;
  }

  private isInStringOrComment(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    try {
      const line = document.lineAt(position.line);
      const lineText = line.text;
      const charIndex = position.character;

      // Check if we're in a comment
      const commentIndex = lineText.indexOf("#");
      if (commentIndex !== -1 && charIndex > commentIndex) {
        return true;
      }

      // Check if we're inside a string
      let inString = false;
      let stringChar = "";
      let escaped = false;

      for (let i = 0; i < Math.min(charIndex, lineText.length); i++) {
        const char = lineText[i];

        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if ((char === '"' || char === "'") && !inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar && inString) {
          inString = false;
          stringChar = "";
        }
      }

      return inString;
    } catch (error) {
      this.logger.error(
        "Error checking if position is in string or comment",
        error
      );
      return false;
    }
  }
}
