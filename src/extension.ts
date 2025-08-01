import * as vscode from "vscode";

import { TerraformInlayProvider } from "./providers/inlayProvider";
import { TerraformVariableResolver } from "./resolvers/variableResolver";
import { ConfigurationManager } from "./utils/configurationManager";
import { Logger } from "./utils/logger";

let logger: Logger;
let configManager: ConfigurationManager;
let inlayProviders: Map<string, TerraformInlayProvider> = new Map();
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  // Initialize logger
  logger = new Logger("TerraformVariableResolver");
  configManager = new ConfigurationManager();

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "terraform-resolver.toggle";
  updateStatusBar();
  statusBarItem.show();

  logger.info("Terraform Variable Resolver activating...");

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    logger.warn("No workspace folders found, extension will not activate");
    vscode.window.showWarningMessage(
      "Terraform Variable Resolver: No workspace folder found"
    );
    return;
  }

  // Initialize providers for each workspace folder
  for (const folder of workspaceFolders) {
    try {
      const workspaceRoot = folder.uri.fsPath;
      const provider = new TerraformInlayProvider(
        workspaceRoot,
        logger,
        configManager
      );
      inlayProviders.set(workspaceRoot, provider);

      // Register inlay hints provider
      const inlayProviderDisposable =
        vscode.languages.registerInlayHintsProvider(
          {
            scheme: "file",
            language: "terraform",
            pattern: `${workspaceRoot}/**/*.tf`,
          },
          provider
        );

      context.subscriptions.push(inlayProviderDisposable);
      logger.info(`Inlay provider registered for workspace: ${folder.name}`);
    } catch (error) {
      logger.error(
        `Failed to initialize provider for workspace ${folder.name}`,
        error
      );
      vscode.window.showErrorMessage(
        `Terraform Variable Resolver: Failed to initialize for workspace ${folder.name}`
      );
    }
  }

  // Register commands
  registerCommands(context);

  // Register configuration change handler
  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (event.affectsConfiguration("terraformResolver")) {
        configManager.reload();
        refreshAllProviders();
        updateStatusBar();
        logger.info("Configuration changed, providers refreshed");
      }
    }
  );

  // Register workspace folder changes
  const workspaceFolderChangeDisposable =
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      handleWorkspaceFolderChanges(event, context);
    });

  context.subscriptions.push(
    configChangeDisposable,
    workspaceFolderChangeDisposable,
    statusBarItem
  );

  logger.info("Terraform Variable Resolver activated successfully");
  vscode.window.showInformationMessage(
    "Terraform Variable Resolver activated!"
  );
}

function registerCommands(context: vscode.ExtensionContext) {
  const commands = [
    vscode.commands.registerCommand("terraform-resolver.refresh", async () => {
      try {
        await refreshAllProviders();
        vscode.window.showInformationMessage(
          "Terraform variable cache refreshed successfully"
        );
        logger.info("Manual refresh completed");
      } catch (error) {
        logger.error("Failed to refresh cache", error);
        vscode.window.showErrorMessage("Failed to refresh Terraform cache");
      }
    }),

    vscode.commands.registerCommand("terraform-resolver.toggle", async () => {
      try {
        const enabled = configManager.isEnabled();
        await configManager.setEnabled(!enabled);
        updateStatusBar();

        const message = `Terraform inlay hints ${!enabled ? "enabled" : "disabled"}`;
        vscode.window.showInformationMessage(message);
        logger.info(message);
      } catch (error) {
        logger.error("Failed to toggle inlay hints", error);
        vscode.window.showErrorMessage(
          "Failed to toggle Terraform inlay hints"
        );
      }
    }),

    vscode.commands.registerCommand(
      "terraform-resolver.clearCache",
      async () => {
        try {
          for (const provider of inlayProviders.values()) {
            provider.clearCache();
          }
          vscode.window.showInformationMessage(
            "Terraform cache cleared successfully"
          );
          logger.info("Cache cleared manually");
        } catch (error) {
          logger.error("Failed to clear cache", error);
          vscode.window.showErrorMessage("Failed to clear Terraform cache");
        }
      }
    ),

    vscode.commands.registerCommand("terraform-resolver.showLogs", () => {
      logger.show();
    }),

    vscode.commands.registerCommand(
      "terraform-resolver.diagnostics",
      async () => {
        try {
          await showDiagnostics();
        } catch (error) {
          logger.error("Failed to show diagnostics", error);
          vscode.window.showErrorMessage("Failed to show diagnostics");
        }
      }
    ),
  ];

  context.subscriptions.push(...commands);
}

async function refreshAllProviders(): Promise<void> {
  const promises = Array.from(inlayProviders.values()).map(async (provider) => {
    try {
      await provider.refresh();
    } catch (error) {
      logger.error("Failed to refresh provider", error);
      throw error;
    }
  });

  await Promise.all(promises);
}

function updateStatusBar() {
  const enabled = configManager.isEnabled();
  statusBarItem.text = `$(symbol-variable) TF${enabled ? "" : " (disabled)"}`;
  statusBarItem.tooltip = enabled
    ? "Terraform Variable Resolver is active. Click to disable."
    : "Terraform Variable Resolver is disabled. Click to enable.";
}

function handleWorkspaceFolderChanges(
  event: vscode.WorkspaceFoldersChangeEvent,
  context: vscode.ExtensionContext
) {
  // Handle removed folders
  for (const folder of event.removed) {
    const provider = inlayProviders.get(folder.uri.fsPath);
    if (provider) {
      provider.dispose();
      inlayProviders.delete(folder.uri.fsPath);
      logger.info(`Provider disposed for removed workspace: ${folder.name}`);
    }
  }

  // Handle added folders
  for (const folder of event.added) {
    try {
      const workspaceRoot = folder.uri.fsPath;
      const provider = new TerraformInlayProvider(
        workspaceRoot,
        logger,
        configManager
      );
      inlayProviders.set(workspaceRoot, provider);

      const inlayProviderDisposable =
        vscode.languages.registerInlayHintsProvider(
          {
            scheme: "file",
            language: "terraform",
            pattern: `${workspaceRoot}/**/*.tf`,
          },
          provider
        );

      context.subscriptions.push(inlayProviderDisposable);
      logger.info(`Provider registered for new workspace: ${folder.name}`);
    } catch (error) {
      logger.error(
        `Failed to initialize provider for new workspace ${folder.name}`,
        error
      );
      vscode.window.showErrorMessage(
        `Failed to initialize Terraform resolver for workspace ${folder.name}`
      );
    }
  }
}

async function showDiagnostics(): Promise<void> {
  const diagnostics: string[] = [];

  diagnostics.push("=== Terraform Variable Resolver Diagnostics ===");
  diagnostics.push(`Enabled: ${configManager.isEnabled()}`);
  diagnostics.push(`Active Workspaces: ${inlayProviders.size}`);

  for (const [workspace, provider] of inlayProviders) {
    diagnostics.push(`\nWorkspace: ${workspace}`);
    diagnostics.push(`Cache Size: ${provider.getCacheSize()}`);
    diagnostics.push(`Cache Hit Rate: ${provider.getCacheHitRate()}%`);
  }

  const doc = await vscode.workspace.openTextDocument({
    content: diagnostics.join("\n"),
    language: "plaintext",
  });

  await vscode.window.showTextDocument(doc);
}

export async function deactivate(): Promise<void> {
  logger?.info("Terraform Variable Resolver deactivating...");

  try {
    // Dispose all providers
    const disposePromises = Array.from(inlayProviders.values()).map(
      async (provider) => {
        try {
          await provider.dispose();
        } catch (error) {
          logger?.error("Error disposing provider", error);
        }
      }
    );

    await Promise.all(disposePromises);
    inlayProviders.clear();

    // Dispose status bar
    statusBarItem?.dispose();

    logger?.info("Terraform Variable Resolver deactivated successfully");
    logger?.dispose();
  } catch (error) {
    console.error("Error during deactivation:", error);
  }
}
