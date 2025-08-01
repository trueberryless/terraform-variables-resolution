import * as vscode from "vscode";

export class ConfigurationManager {
  private configSection = "terraformResolver";
  private config: vscode.WorkspaceConfiguration;

  constructor() {
    this.config = vscode.workspace.getConfiguration(this.configSection);
  }

  // Lädt die Konfiguration neu (z.B. bei onDidChangeConfiguration)
  reload() {
    this.config = vscode.workspace.getConfiguration(this.configSection);
  }

  // Prüft, ob die Inlay-Hints aktiviert sind
  isEnabled(): boolean {
    return this.config.get<boolean>("enabled", true);
  }

  // Aktiviert/deaktiviert Inlay-Hints (Speicherung in den Workspace oder User settings)
  async setEnabled(enabled: boolean): Promise<void> {
    // Hier z.B. Workspace-Einstellung (kann auch global geändert werden)
    await this.config.update(
      "enabled",
      enabled,
      vscode.ConfigurationTarget.Workspace
    );
    this.reload();
  }
}
