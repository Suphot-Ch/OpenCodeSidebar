import * as vscode from 'vscode';
import { PairingController } from './pairingController';
import { LocalBridge } from './localBridge';
import { redactSecrets, validateUrl } from './security';

export class OpenCodeSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode.sidebarView';

  private view?: vscode.WebviewView;
  private pairingController: PairingController;
  private localBridge: LocalBridge;
  private outputChannel: vscode.OutputChannel;
  private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private statusMessage = 'Disconnected';
  private activeIframeUrl = '';
  private activeTargetUrl = '';
  private isAutoPairing = false;
  private lastAutomaticPairAt = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    pairingController: PairingController,
    localBridge: LocalBridge,
    outputChannel: vscode.OutputChannel
  ) {
    this.pairingController = pairingController;
    this.localBridge = localBridge;
    this.outputChannel = outputChannel;

    // Whenever bridge captures or refreshes a session cookie, persist to VS Code User Settings globally
    this.localBridge.onCookieCaptured = async (cookie: string) => {
      await this.saveCookieToSettings(cookie);
    };

    // Auto re-pair if bridge detects 401 Unauthorized during active usage
    this.localBridge.onUnauthorized = async () => {
      if (this.isAutoPairing) return;
      // A broken connection must not create an endless pairing/reload loop.
      if (Date.now() - this.lastAutomaticPairAt < 30000) {
        this.outputChannel.appendLine('[Sidebar] Authentication still failing after refresh; automatic retry paused. Use Auto Pair to retry manually.');
        return;
      }
      this.lastAutomaticPairAt = Date.now();
      this.outputChannel.appendLine('[Sidebar] Session expired or unauthorized. Performing automatic re-pairing...');
      await this.performAutoPair(true);
    };
  }

  private async saveCookieToSettings(cookie: string): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('opencode');
      const existing = config.get<string>('savedCookie', '');
      if (existing !== cookie) {
        await config.update('savedCookie', cookie, vscode.ConfigurationTarget.Global);
        this.outputChannel.appendLine('[Sidebar] Session cookie saved to VS Code Global Settings.');
      }
    } catch (err: any) {
      this.outputChannel.appendLine(`[Sidebar] Failed to save cookie to settings: ${err.message}`);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'ready':
          this.sendStatus();
          const config = vscode.workspace.getConfiguration('opencode');
          if (config.get<boolean>('autoConnect', true) && this.currentStatus === 'disconnected') {
            await this.connect();
          }
          break;
        case 'connect':
        case 'autoPair':
          await this.performAutoPair();
          break;
        case 'pasteLink':
          await this.promptPasteLink();
          break;
        case 'reload':
          await this.reload();
          break;
        case 'openBrowser':
          this.openInBrowser();
          break;
        case 'showOutput':
          this.outputChannel.show(true);
          break;
        case 'syncWorkspace':
          await this.syncCurrentWorkspace();
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendStatus();
        this.syncCurrentWorkspace().catch(() => null);
      }
    });
  }

  /**
   * Registers current VS Code workspace folder into OpenCode server project catalog.
   */
  public async syncCurrentWorkspace(): Promise<void> {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders || wsFolders.length === 0 || !this.activeTargetUrl) return;

    const currentDir = wsFolders[0].uri.fsPath;
    try {
      const cookie = this.localBridge.getSessionCookie();
      const locUrl = new URL(`${this.activeTargetUrl}/api/location`);
      locUrl.searchParams.set('location[directory]', currentDir);

      const res = await fetch(locUrl.toString(), {
        headers: cookie ? { cookie } : {},
        signal: AbortSignal.timeout(5000),
      });
      await res.body?.cancel();
      if (res.status === 200) {
        this.outputChannel.appendLine(`[Sidebar] Registered workspace project in OpenCode: ${currentDir}`);
      }
    } catch (err: any) {
      this.outputChannel.appendLine(`[Sidebar] Failed to sync workspace project: ${err.message}`);
    }
  }

  /**
   * Fully automated pairing routine without needing manual token copying.
   */
  public async performAutoPair(silent = false): Promise<void> {
    if (this.isAutoPairing) return;
    this.isAutoPairing = true;

    try {
      this.updateStatus('connecting', 'Auto-pairing with OpenCode...');
      const config = vscode.workspace.getConfiguration('opencode');
      const bridgePort = config.get<number>('bridgePort', 49375);

      const result = await this.pairingController.autoPair();
      if (!result.success || !result.baseUrl || !result.sessionCookie) {
        throw new Error(result.error || 'AutoPair could not acquire session cookie');
      }

      this.localBridge.setSessionCookie(result.sessionCookie);
      this.updateStatus('connecting', 'Saving authenticated session...');
      await this.bounded(this.saveCookieToSettings(result.sessionCookie), 5000, 'Saving session settings');
      this.updateStatus('connecting', 'Connecting sidebar bridge...');
      await this.attachAndOpen(result.baseUrl, bridgePort, '/');
      // A refresh can keep the same URL; explicitly reload to recover failed UI requests.
      this.view?.webview.postMessage({ type: 'reload' });

      // Auto-register current workspace folder
      void this.syncCurrentWorkspace();

      if (!silent) {
        vscode.window.showInformationMessage('OpenCode: Auto-Paired successfully!');
      }
    } catch (err: any) {
      const msg = redactSecrets(err?.message || String(err));
      this.outputChannel.appendLine(`[Sidebar] AutoPair failed: ${msg}`);
      this.updateStatus('error', `AutoPair failed: ${msg}`);
    } finally {
      this.isAutoPairing = false;
    }
  }

  public async connect(customUrl?: string): Promise<void> {
    this.updateStatus('connecting', 'Connecting to OpenCode service...');

    try {
      const config = vscode.workspace.getConfiguration('opencode');
      const bridgePort = config.get<number>('bridgePort', 49375);
      const savedCookie = config.get<string>('savedCookie', '');
      const configuredServerUrl = config.get<string>('serverUrl', '');

      // 1. If user supplied a custom URL, parse it directly
      if (customUrl) {
        const result = this.pairingController.parseCustomUrl(customUrl);
        if (!result.success || !result.baseUrl) {
          throw new Error(result.error || 'Invalid custom URL');
        }
        await this.attachAndOpen(result.baseUrl, bridgePort, result.connectPath);
        return;
      }

      // 2. Discover running OpenCode service URL
      let targetUrl: URL | null = null;
      if (configuredServerUrl) {
        const v = validateUrl(configuredServerUrl);
        if (v.valid && v.url) {
          targetUrl = v.url;
        }
      }
      if (!targetUrl) {
        targetUrl = await this.pairingController.getServiceStatusUrl();
      }

      // 3. If targetUrl and savedCookie exist, verify if session is still alive
      if (targetUrl && savedCookie) {
        this.outputChannel.appendLine(`[Sidebar] Found saved cookie. Verifying session on ${targetUrl.origin}...`);
        const isValid = await this.pairingController.verifySession(targetUrl, savedCookie);
        if (isValid) {
          this.outputChannel.appendLine('[Sidebar] Saved session is valid! Reconnecting without pairing...');
          this.localBridge.setSessionCookie(savedCookie);
          await this.attachAndOpen(targetUrl, bridgePort, '/');
          void this.syncCurrentWorkspace();
          return;
        } else {
          this.outputChannel.appendLine('[Sidebar] Saved session has expired. Running AutoPair...');
        }
      }

      // 4. Session not present or expired -> Run AutoPair directly!
      await this.performAutoPair(true);
    } catch (err: any) {
      const msg = redactSecrets(err?.message || String(err));
      this.outputChannel.appendLine(`[Sidebar] Connection error: ${msg}`);
      this.updateStatus('error', msg);
    }
  }

  private async attachAndOpen(targetBaseUrl: URL, bridgePort: number, connectPath?: string): Promise<void> {
    this.activeTargetUrl = targetBaseUrl.origin;

    const bridge = await this.bounded(this.localBridge.start(targetBaseUrl, bridgePort), 10000, 'Connecting sidebar bridge');

    const initialPath = connectPath || '/';
    this.activeIframeUrl = `${bridge.proxyUrl}${initialPath}`;

    this.outputChannel.appendLine(`[Sidebar] Connected. Bridge: ${bridge.proxyUrl} (reused: ${!!bridge.reused}) -> Target: ${targetBaseUrl.origin}`);
    this.updateStatus('connected', `Connected (${targetBaseUrl.host})`, this.activeIframeUrl);
  }

  public async promptPasteLink(): Promise<void> {
    const input = await vscode.window.showInputBox({
      title: 'Paste OpenCode Pairing URL',
      prompt: 'Enter the URL printed by "opencode pair" (e.g., http://127.0.0.1:49374/auth/connect/...)',
      placeHolder: 'http://127.0.0.1:49374/auth/connect/...',
      ignoreFocusOut: true,
    });

    if (input) {
      await this.connect(input);
    }
  }

  public async reload(): Promise<void> {
    if (this.view) {
      if (this.currentStatus === 'connected' && this.localBridge.isRunning()) {
        this.view.webview.postMessage({ type: 'reload' });
        this.outputChannel.appendLine('[Sidebar] Reloaded webview.');
      } else {
        await this.connect();
      }
    }
  }

  public openInBrowser(): void {
    if (this.activeTargetUrl) {
      vscode.env.openExternal(vscode.Uri.parse(this.activeTargetUrl));
    } else {
      vscode.window.showInformationMessage('No active OpenCode connection to open.');
    }
  }

  public disconnect(): void {
    this.localBridge.stop();
    this.activeIframeUrl = '';
    this.activeTargetUrl = '';
    this.updateStatus('disconnected', 'Disconnected');
    this.outputChannel.appendLine('[Sidebar] Disconnected.');
  }

  private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error', message: string, iframeUrl?: string): void {
    this.currentStatus = status;
    this.statusMessage = message;
    this.sendStatus(iframeUrl);
  }

  private async bounded<T>(operation: Promise<T>, milliseconds: number, stage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${stage} timed out. Please retry Auto Pair.`)), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private sendStatus(iframeUrl?: string): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'status',
        status: this.currentStatus,
        message: this.statusMessage,
        iframeUrl: iframeUrl || this.activeIframeUrl,
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.js'));

    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${cspSource} 'unsafe-inline';
    script-src ${cspSource} 'unsafe-inline';
    img-src ${cspSource} data: https: http:;
    frame-src http://127.0.0.1:* http://localhost:* https:;
    connect-src ${cspSource} http://127.0.0.1:* http://localhost:*;
  ">
  <link rel="stylesheet" href="${styleUri}">
  <title>OpenCode</title>
</head>
<body>
  <div id="container">
    <div id="top-bar">
      <div class="status-group">
        <span id="status-dot" class="status-dot"></span>
        <span id="status-label" class="status-label">Disconnected</span>
      </div>
      <div class="actions-group">
        <button id="btn-autopair" class="icon-btn" title="Auto Pair / Refresh Auth">⚡</button>
        <button id="btn-reload" class="icon-btn" title="Reload View">↻</button>
        <button id="btn-browser" class="icon-btn" title="Open in Browser">↗</button>
        <button id="btn-paste" class="icon-btn" title="Paste Pairing Link">🔗</button>
        <button id="btn-logs" class="icon-btn" title="Show Output Logs">📄</button>
      </div>
    </div>

    <!-- Embedded OpenCode Web UI Frame -->
    <iframe
      id="frame-view"
      src=""
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
    ></iframe>

    <!-- Disconnected / Status Card View -->
    <div id="card-view">
      <div id="card-content">
        <!-- Injected via sidebar.js -->
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
