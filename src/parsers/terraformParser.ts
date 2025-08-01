import { Logger } from "../utils/logger";

interface ModuleCall {
  name: string;
  source: string;
  variables: { [key: string]: string };
  location: any; // vscode.Range would be imported in actual implementation
}

export class TerraformParser {
  constructor(private logger: Logger) {}

  parseJsonVariable(content: string, variableName: string): string | null {
    try {
      const json = JSON.parse(content);
      if (json[variableName] !== undefined) {
        return this.formatValue(json[variableName]);
      }
      return null;
    } catch (error) {
      this.logger.error("Error parsing JSON tfvars", error);
      return null;
    }
  }

  parseHclVariable(content: string, variableName: string): string | null {
    try {
      // Enhanced HCL parsing patterns with better object support
      const patterns = [
        // Simple string assignment: variable_name = "value"
        new RegExp(
          `^\\s*${this.escapeRegex(variableName)}\\s*=\\s*"([^"]*)"\\s*$`,
          "m"
        ),

        // Unquoted value: variable_name = value
        new RegExp(
          `^\\s*${this.escapeRegex(variableName)}\\s*=\\s*([^\\s\\n#\\{\\[]+)\\s*(?:#.*)?$`,
          "m"
        ),

        // Array assignment: variable_name = ["value1", "value2"]
        new RegExp(
          `^\\s*${this.escapeRegex(variableName)}\\s*=\\s*(\\[[^\\]]*\\])\\s*$`,
          "m"
        ),

        // FIXED: Multi-line object assignment with proper brace matching
        new RegExp(
          `^\\s*${this.escapeRegex(variableName)}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*(?:\\n|$)`,
          "gm"
        ),

        // Boolean values
        new RegExp(
          `^\\s*${this.escapeRegex(variableName)}\\s*=\\s*(true|false)\\s*$`,
          "m"
        ),

        // Numeric values
        new RegExp(
          `^\\s*${this.escapeRegex(variableName)}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*$`,
          "m"
        ),

        // Heredoc strings
        new RegExp(
          `^\\s*${this.escapeRegex(variableName)}\\s*=\\s*<<-?\\s*(\\w+)\\s*\\n([\\s\\S]*?)^\\s*\\1\\s*$`,
          "gm"
        ),
      ];

      for (const pattern of patterns) {
        const match = pattern.exec(content);
        if (match) {
          let value = match[1];

          // Handle heredoc
          if (match[2] !== undefined) {
            value = match[2];
          }

          // FIXED: Proper object parsing with brace matching
          if (value.trim().startsWith("{")) {
            return this.parseComplexObject(value, content, variableName);
          }

          return this.cleanValue(value);
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Error parsing HCL variable ${variableName}`, error);
      return null;
    }
  }

  // NEW: Proper complex object parsing with brace matching
  private parseComplexObject(
    objectValue: string,
    fullContent: string,
    variableName: string
  ): string {
    try {
      // If we only got the opening brace, find the complete object
      if (objectValue.trim() === "{") {
        return this.extractCompleteObject(fullContent, variableName);
      }

      // Verify we have a complete object by counting braces
      if (!this.hasMatchingBraces(objectValue)) {
        return this.extractCompleteObject(fullContent, variableName);
      }

      // Clean and format the object
      return this.formatComplexObject(objectValue);
    } catch (error) {
      this.logger.error(
        `Error parsing complex object for ${variableName}`,
        error
      );
      return objectValue; // Return as-is if parsing fails
    }
  }

  // NEW: Extract complete object from content using brace matching
  private extractCompleteObject(content: string, variableName: string): string {
    try {
      const lines = content.split("\n");
      let objectStart = -1;
      let braceCount = 0;
      let objectLines: string[] = [];
      let inObject = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Find the start of our variable assignment
        if (
          !inObject &&
          line.match(
            new RegExp(`^\\s*${this.escapeRegex(variableName)}\\s*=\\s*\\{`)
          )
        ) {
          inObject = true;
          objectStart = i;
          braceCount =
            (line.match(/\\{/g) || []).length -
            (line.match(/\\}/g) || []).length;

          // Extract the part after the = sign
          const afterEquals = line.substring(line.indexOf("=") + 1).trim();
          objectLines.push(afterEquals);

          if (braceCount === 0) {
            // Single line object
            break;
          }
          continue;
        }

        if (inObject) {
          objectLines.push(line);
          braceCount +=
            (line.match(/\\{/g) || []).length -
            (line.match(/\\}/g) || []).length;

          if (braceCount <= 0) {
            break;
          }
        }
      }

      if (objectLines.length > 0) {
        const completeObject = objectLines.join("\n");
        return this.formatComplexObject(completeObject);
      }

      return "{}";
    } catch (error) {
      this.logger.error(
        `Error extracting complete object for ${variableName}`,
        error
      );
      return "{}";
    }
  }

  // NEW: Check if braces are properly matched
  private hasMatchingBraces(str: string): boolean {
    let braceCount = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"' && !escaped) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === "{") {
          braceCount++;
        } else if (char === "}") {
          braceCount--;
        }
      }
    }

    return braceCount === 0;
  }

  // NEW: Format complex object for better display
  private formatComplexObject(objectStr: string): string {
    try {
      const trimmed = objectStr.trim();

      // Try to convert to JSON for consistent formatting
      const jsonStr = this.convertHclObjectToJson(trimmed);
      const parsed = JSON.parse(jsonStr);
      return JSON.stringify(parsed, null, 2);
    } catch (error) {
      // If JSON conversion fails, format as HCL
      return this.formatHclObject(objectStr);
    }
  }

  // NEW: Convert HCL object syntax to JSON
  private convertHclObjectToJson(hclObj: string): string {
    let jsonStr = hclObj.trim();

    if (!jsonStr.startsWith("{")) {
      jsonStr = "{" + jsonStr + "}";
    }

    // Convert HCL syntax to JSON
    jsonStr = jsonStr
      // Convert key = value to "key": value
      .replace(/(\w+)\s*=\s*/g, '"$1": ')
      // Ensure string values are quoted
      .replace(
        /:\s*([^",\\{\\[\\n\\r]+)(\s*[,\\}\\n\\r])/g,
        (match, value, suffix) => {
          const trimmedValue = value.trim();
          if (
            trimmedValue === "true" ||
            trimmedValue === "false" ||
            /^\\d+(\\.\\d+)?$/.test(trimmedValue)
          ) {
            return `: ${trimmedValue}${suffix}`;
          }
          return `: "${trimmedValue}"${suffix}`;
        }
      )
      // Fix trailing commas
      .replace(/,(\s*[\\}\\]])/g, "$1");

    return jsonStr;
  }

  // NEW: Format HCL object when JSON conversion fails
  private formatHclObject(hclObj: string): string {
    const lines = hclObj.split("\n");
    let indentLevel = 0;
    const formatted: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.includes("}")) {
        indentLevel = Math.max(0, indentLevel - 1);
      }

      formatted.push("  ".repeat(indentLevel) + trimmed);

      if (trimmed.includes("{")) {
        indentLevel++;
      }
    }

    return formatted.join("\n");
  }

  parseLocalsBlock(content: string, variableName: string): string | null {
    try {
      // Match locals blocks
      const localsRegex = /locals\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
      let match;

      while ((match = localsRegex.exec(content)) !== null) {
        const localsContent = match[1];
        const value = this.parseHclVariable(localsContent, variableName);
        if (value !== null) {
          return value;
        }
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Error parsing locals block for ${variableName}`,
        error
      );
      return null;
    }
  }

  parseOutputBlock(content: string, outputName: string): string | null {
    try {
      // Match output blocks with the specific name
      const outputRegex = new RegExp(
        `output\\s+"${this.escapeRegex(outputName)}"\\s*\\{([^}]*(?:\\{[^}]*\\}[^}]*)*)\\}`,
        "gs"
      );

      const match = outputRegex.exec(content);
      if (match) {
        const outputContent = match[1];

        // Extract the value from the output block
        const valueMatch = /value\s*=\s*([^\n]*)/g.exec(outputContent);
        if (valueMatch) {
          return this.cleanValue(valueMatch[1]);
        }

        // Handle multi-line values
        const multiLineValueMatch =
          /value\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs.exec(outputContent);
        if (multiLineValueMatch) {
          return `{${multiLineValueMatch[1]}}`;
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Error parsing output block for ${outputName}`, error);
      return null;
    }
  }

  parseModuleBlock(content: string, moduleName: string): ModuleCall | null {
    try {
      const moduleRegex = new RegExp(
        `module\\s+"${this.escapeRegex(moduleName)}"\\s*\\{([^}]*(?:\\{[^}]*\\}[^}]*)*)\\}`,
        "gs"
      );

      const match = moduleRegex.exec(content);
      if (match) {
        const moduleContent = match[1];

        // Extract source
        const sourceMatch = /source\s*=\s*"([^"]*)"/.exec(moduleContent);
        if (!sourceMatch) {
          return null;
        }

        return {
          name: moduleName,
          source: sourceMatch[1],
          variables: this.parseModuleVariables(moduleContent),
          location: null, // Would be calculated in actual implementation
        };
      }

      return null;
    } catch (error) {
      this.logger.error(`Error parsing module block for ${moduleName}`, error);
      return null;
    }
  }

  extractVariableReferences(value: string): string[] {
    try {
      const references: string[] = [];
      const patterns = [
        /\bvar\.(\w+)/g,
        /\blocal\.(\w+)/g,
        /\bmodule\.([\w.]+)/g,
        /\bdata\.([\w.]+)\.([\w.]+)/g,
      ];

      for (const pattern of patterns) {
        let match;
        pattern.lastIndex = 0; // Reset regex state

        while ((match = pattern.exec(value)) !== null) {
          if (pattern.source.includes("data")) {
            references.push(`data.${match[1]}.${match[2]}`);
          } else {
            references.push(match[0]);
          }
        }
      }

      return [...new Set(references)]; // Remove duplicates
    } catch (error) {
      this.logger.error("Error extracting variable references", error);
      return [];
    }
  }

  parseModuleVariables(moduleContent: string): { [key: string]: string } {
    const variables: { [key: string]: string } = {};

    try {
      const lines = moduleContent.split("\n");

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (
          trimmedLine.startsWith("source") ||
          trimmedLine.startsWith("#") ||
          !trimmedLine.includes("=")
        ) {
          continue;
        }

        const match = /^\s*(\w+)\s*=\s*(.+)$/.exec(trimmedLine);
        if (match) {
          const key = match[1];
          const value = this.cleanValue(match[2]);
          variables[key] = value;
        }
      }
    } catch (error) {
      this.logger.error("Error parsing module variables", error);
    }

    return variables;
  }

  private cleanValue(value: string): string {
    if (!value) return "";

    let cleaned = value.trim();

    // Remove trailing comments
    const commentIndex = cleaned.indexOf("#");
    if (commentIndex !== -1) {
      cleaned = cleaned.substring(0, commentIndex).trim();
    }

    // Remove trailing commas
    if (cleaned.endsWith(",")) {
      cleaned = cleaned.slice(0, -1).trim();
    }

    return cleaned;
  }

  private formatValue(value: any): string {
    if (value === null || value === undefined) {
      return "null";
    }

    if (typeof value === "string") {
      return `"${value}"`;
    }

    if (typeof value === "boolean") {
      return value.toString();
    }

    if (typeof value === "number") {
      return value.toString();
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "[]";
      }

      if (value.length > 3) {
        return `[${value
          .slice(0, 3)
          .map((v) => this.formatValue(v))
          .join(", ")}, ...]`;
      }

      return `[${value.map((v) => this.formatValue(v)).join(", ")}]`;
    }

    if (typeof value === "object") {
      const entries = Object.entries(value);

      if (entries.length === 0) {
        return "{}";
      }

      if (entries.length > 3) {
        const preview = entries
          .slice(0, 2)
          .map(([k, v]) => `${k} = ${this.formatValue(v)}`)
          .join(", ");
        return `{ ${preview}, ... }`;
      }

      const formatted = entries
        .map(([k, v]) => `${k} = ${this.formatValue(v)}`)
        .join(", ");
      return `{ ${formatted} }`;
    }

    return String(value);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
