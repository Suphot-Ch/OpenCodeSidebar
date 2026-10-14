import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import stream from 'node:stream';
import { redactSecrets } from './security';

const BRIDGE_PROTOCOL_VERSION = 2;

export interface BridgeInfo {
  port: number;
  proxyUrl: string;
  reused?: boolean;
}

export class LocalBridge {
  private server: http.Server | null = null;
  private port = 0;
  private targetUrl: URL | null = null;
  private sessionCookie = '';
  private logger: (msg: string) => void;
  private readonly sockets = new Set<stream.Duplex>();
  public onCookieCaptured?: (cookie: string) => void;
  public onUnauthorized?: () => void;

  constructor(logger: (msg: string) => void = console.log) {
    this.logger = logger;
  }

  public getSessionCookie(): string {
    return this.sessionCookie;
  }

  public setSessionCookie(cookie: string): void {
    this.sessionCookie = cookie;
    this.logger('[Bridge] Session cookie updated.');
  }

  public getTargetUrl(): URL | null {
    return this.targetUrl;
  }

  public async start(target: URL, preferredPort = 49375): Promise<BridgeInfo> {
    // Authentication refresh must not close an active SSE/WebSocket connection.
    if (this.server && this.targetUrl?.origin === target.origin) {
      this.logger('[Bridge] Keeping existing bridge during authentication refresh.');
      return { port: this.port, proxyUrl: this.getProxyUrl()!, reused: true };
    }
    if (this.server) {
      await this.stop();
    }

    this.targetUrl = target;

    // First, try listening on preferredPort
    try {
      const info = await this.tryListen(target, preferredPort);
      return info;
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        // Port is in use, check if it is our bridge running in another VS Code window
        this.logger(`[Bridge] Port ${preferredPort} is in use. Checking if another workspace bridge is alive...`);
        try {
          const check = await fetch(`http://127.0.0.1:${preferredPort}/bridge/info`, {
            signal: AbortSignal.timeout(3000),
          });
          const metadata = await check.json() as { name?: string; version?: number; target?: string };
          if (check.ok && metadata.name === 'opencode-sidebar' &&
              metadata.version === BRIDGE_PROTOCOL_VERSION && metadata.target === target.origin) {
            this.port = preferredPort;
            const proxyUrl = `http://127.0.0.1:${this.port}`;
            this.logger(`[Bridge] Existing bridge found on ${proxyUrl}. Reusing shared bridge.`);

            // Sync session cookie to the existing bridge if we have one
            if (this.sessionCookie) {
              await fetch(`http://127.0.0.1:${this.port}/bridge/sync-cookie`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookie: this.sessionCookie }),
                signal: AbortSignal.timeout(3000),
              }).then(async response => {
                if (!response.ok) throw new Error('Shared bridge authentication update failed');
                await response.body?.cancel();
              });
            }

            return { port: this.port, proxyUrl, reused: true };
          }
        } catch {
          // Fall through to dynamic port
        }
        this.logger(`[Bridge] Port ${preferredPort} occupied by other service. Falling back to dynamic port.`);
        return this.tryListen(target, 0);
      }
      throw err;
    }
  }

  private tryListen(target: URL, portToBind: number): Promise<BridgeInfo> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });
      srv.on('connection', socket => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });

      srv.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(req, socket, head);
      });

      srv.once('error', (err) => {
        reject(err);
      });

      srv.listen(portToBind, '127.0.0.1', () => {
        const addr = srv.address();
        if (typeof addr === 'object' && addr) {
          this.port = addr.port;
          this.server = srv;
          const proxyUrl = `http://127.0.0.1:${this.port}`;
          this.logger(`[Bridge] Proxy listening on ${proxyUrl} -> ${target.origin}`);
          resolve({ port: this.port, proxyUrl, reused: false });
        } else {
          reject(new Error('Failed to obtain bridge server port'));
        }
      });
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (server) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      // server.close() alone waits forever for live event streams and upgrades.
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      server.closeAllConnections();
      await closed;
      this.logger('[Bridge] Proxy stopped.');
    }
  }

  public isRunning(): boolean {
    return this.port > 0;
  }

  public getProxyUrl(): string | null {
    return this.port > 0 ? `http://127.0.0.1:${this.port}` : null;
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.isTrustedRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Untrusted bridge host or browser origin');
      return;
    }
    const clientUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);

    if (clientUrl.pathname === '/bridge/info' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ name: 'opencode-sidebar', version: BRIDGE_PROTOCOL_VERSION, target: this.targetUrl?.origin }));
      return;
    }

    // Internal endpoint for syncing cookies between windows
    if (clientUrl.pathname === '/bridge/sync-cookie' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.cookie === 'string') {
            this.setSessionCookie(parsed.cookie);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
        } catch {}
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
      });
      return;
    }

    if (!this.targetUrl) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('OpenCode target server not configured');
      return;
    }

    const targetPath = `${clientUrl.pathname}${clientUrl.search}`;
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;

    headers.cookie = this.authenticatedCookie(String(headers.cookie || ''));
    this.rewriteBrowserHeaders(headers);

    const targetPort = this.targetUrl.port ? parseInt(this.targetUrl.port, 10) : (this.targetUrl.protocol === 'https:' ? 443 : 80);

    const transport = this.targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      {
        protocol: this.targetUrl.protocol,
        hostname: this.targetUrl.hostname,
        port: targetPort,
        method: req.method,
        path: targetPath,
        headers,
      },
      (proxyRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };

        // Check if Set-Cookie was returned
        const setCookie = proxyRes.headers['set-cookie'];
        if (setCookie) {
          const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
          for (const item of cookieList) {
            const match = item.match(/opencode_session_\d+=[^;]+/);
            if (match) {
              this.sessionCookie = match[0];
              this.logger('[Bridge] Captured session cookie from server response.');
              if (this.onCookieCaptured) {
                this.onCookieCaptured(this.sessionCookie);
              }
            }
          }
          // Do NOT add Secure on loopback HTTP, as Chromium will drop it!
          // Keep cookie compatible with local loopback iframe
          responseHeaders['set-cookie'] = cookieList.map((c) =>
            c.replace(/;\s*Secure/gi, '').replace(/;\s*SameSite=None/gi, '; SameSite=Lax')
          );
        }

        // Notify if 401 Unauthorized occurs on an API call
        if (proxyRes.statusCode === 401 && targetPath.startsWith('/api/')) {
          this.logger(`[Bridge] Received 401 Unauthorized from OpenCode on ${targetPath}`);
          if (this.onUnauthorized) {
            this.onUnauthorized();
          }
        }

        // Remove frame-blocking headers
        delete responseHeaders['x-frame-options'];
        if (typeof responseHeaders['content-security-policy'] === 'string') {
          responseHeaders['content-security-policy'] = (responseHeaders['content-security-policy'] as string)
            .replace(/frame-ancestors[^;]+;?/gi, '');
        }

        // The browser talks same-origin to the bridge. Do not expose its
        // authenticated responses to arbitrary websites with permissive CORS.
        delete responseHeaders['access-control-allow-origin'];
        delete responseHeaders['access-control-allow-credentials'];

        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      this.logger(`[Bridge] Proxy request error: ${redactSecrets(err.message)}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`OpenCode Service Gateway Error: ${err.message}`);
      }
    });
    // Release the upstream event stream when the webview closes its connection.
    res.once('close', () => proxyReq.destroy());

    req.pipe(proxyReq);
  }

  private handleUpgrade(req: http.IncomingMessage, clientSocket: stream.Duplex, head: Buffer): void {
    if (!this.targetUrl || !this.isTrustedRequest(req)) {
      clientSocket.destroy();
      return;
    }

    const clientUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const targetPort = this.targetUrl.port ? parseInt(this.targetUrl.port, 10) : 80;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() !== 'host' && v !== undefined) {
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
    }
    headers['host'] = `${this.targetUrl.hostname}:${targetPort}`;
    headers.cookie = this.authenticatedCookie(headers.cookie || '');
    this.rewriteBrowserHeaders(headers);

    const headerLines = [
      `${req.method} ${clientUrl.pathname}${clientUrl.search} HTTP/${req.httpVersion}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ].join('\r\n');

    const targetSocket = net.connect(targetPort, this.targetUrl.hostname, () => {
      targetSocket.write(headerLines);
      if (head.length > 0) {
        targetSocket.write(head);
      }
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    this.sockets.add(targetSocket);
    targetSocket.once('close', () => {
      this.sockets.delete(targetSocket);
      clientSocket.destroy();
    });
    clientSocket.once('close', () => targetSocket.destroy());

    targetSocket.on('error', (err) => {
      this.logger(`[Bridge] WebSocket target error: ${redactSecrets(err.message)}`);
      clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
      this.logger(`[Bridge] WebSocket client error: ${redactSecrets(err.message)}`);
      targetSocket.destroy();
    });
  }

  private authenticatedCookie(incoming: string): string {
    if (!this.sessionCookie) return incoming;
    const otherCookies = incoming.split(';').map(part => part.trim())
      .filter(part => part && !/^opencode_session_\d+=/.test(part));
    return [...otherCookies, this.sessionCookie].join('; ');
  }

  private isTrustedRequest(req: http.IncomingMessage): boolean {
    if (req.headers.host !== `127.0.0.1:${this.port}`) return false;
    const origin = req.headers.origin;
    return origin === undefined || origin === this.getProxyUrl();
  }

  private rewriteBrowserHeaders(headers: http.OutgoingHttpHeaders): void {
    // Only called after validating the original browser Origin against this
    // bridge. Preserve OpenCode's own cookie/CSRF checks rather than disabling them.
    if (headers.origin) headers.origin = this.targetUrl!.origin;
    if (typeof headers.referer === 'string') {
      try {
        const referer = new URL(headers.referer);
        if (referer.origin === this.getProxyUrl()) {
          headers.referer = `${this.targetUrl!.origin}${referer.pathname}${referer.search}`;
        } else {
          delete headers.referer;
        }
      } catch {
        delete headers.referer;
      }
    }
  }
}
