import * as vscode from 'vscode';
import { OpenCodeSidebarProvider } from './sidebarProvider';
import { PairingController } from './pairingController';
import { LocalBridge } from './localBridge';

let localBridge: LocalBridge | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('OpenCode Sidebar');
  outputChannel.appendLine('[Extension] OpenCode Sidebar activating...');

  const config = vscode.workspace.getConfiguration('opencode');
  const executablePath = config.get<string>('executablePath', 'opencode');

  const pairingController = new PairingController(executablePath, (msg) => {
    outputChannel.appendLine(msg);
  });

  localBridge = new LocalBridge((msg) => {
    outputChannel.appendLine(msg);
  });

  const sidebarProvider = new OpenCodeSidebarProvider(
    context.extensionUri,
    pairingController,
    localBridge,
    outputChannel
  );

  // Register WebviewViewProvider for the Activity Bar view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OpenCodeSidebarProvider.viewType,
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.autoPair', async () => {
      await sidebarProvider.performAutoPair();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.syncWorkspace', async () => {
      await sidebarProvider.syncCurrentWorkspace();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.connect', async () => {
      await sidebarProvider.connect();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.disconnect', () => {
      sidebarProvider.disconnect();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.reload', async () => {
      await sidebarProvider.reload();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.pastePairingUrl', async () => {
      await sidebarProvider.promptPasteLink();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.openInBrowser', () => {
      sidebarProvider.openInBrowser();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('opencode.showOutput', () => {
      outputChannel.show(true);
    })
  );

  // Listen to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('opencode.executablePath')) {
        const newPath = vscode.workspace.getConfiguration('opencode').get<string>('executablePath', 'opencode');
        pairingController.setExecutablePath(newPath);
        outputChannel.appendLine(`[Extension] Updated executablePath to: ${newPath}`);
      }
    })
  );

  outputChannel.appendLine('[Extension] OpenCode Sidebar activated.');
}

export async function deactivate(): Promise<void> {
  if (localBridge) {
    await localBridge.stop();
    localBridge = null;
  }
}

export { validateUrl, redactSecrets } from './security';
export { PairingController } from './pairingController';
export { LocalBridge } from './localBridge';
