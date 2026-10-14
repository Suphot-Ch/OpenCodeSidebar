import { execFile } from 'node:child_process';
import { validateUrl, redactSecrets } from './security';

export interface PairingResult {
  success: boolean;
  pairingUrl?: string;
  baseUrl?: URL;
  connectPath?: string;
  sessionCookie?: string;
  error?: string;
}

export class PairingController {
  private executablePath: string;
  private logger: (msg: string) => void;

  constructor(executablePath = 'opencode', logger: (msg: string) => void = console.log) {
    this.executablePath = executablePath;
    this.logger = logger;
  }

  public setExecutablePath(path: string): void {
    this.executablePath = path;
  }

  /**
   * Queries `opencode service status` to find the running service URL without generating pairing links.
   */
  public async getServiceStatusUrl(): Promise<URL | null> {
    return new Promise((resolve) => {
      execFile(
        this.executablePath,
        ['service', 'status'],
        { timeout: 5000, windowsHide: true, shell: process.platform === 'win32' },
        (error, stdout) => {
          if (error) {
            return resolve(null);
          }
          const text = (stdout || '').trim();
          const match = text.match(/https?:\/\/[^\s\r\n]+/);
          if (match) {
            const v = validateUrl(match[0]);
            if (v.valid && v.url) {
              return resolve(v.url);
            }
          }
          resolve(null);
        }
      );
    });
  }

  /**
   * Verifies if a given session cookie is authenticated with the OpenCode service.
   * OpenCode returns 200 on /api/info with valid auth, and 401 without valid auth.
   */
  public async verifySession(baseUrl: URL, cookie: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${baseUrl.origin}/api/info`, {
        headers: { cookie },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Fully automated pair flow:
   * 1. Runs `opencode pair`.
   * 2. Programmatically fetches the pairing URL with Accept: text/html.
   * 3. Extracts the new `opencode_session_` cookie from Set-Cookie.
   * 4. Verifies the cookie against `/api/info`.
   */
  public async autoPair(): Promise<PairingResult> {
    this.logger('[AutoPair] Starting automatic pairing flow...');
    const pairResult = await this.getPairingUrl();
    if (!pairResult.success || !pairResult.pairingUrl || !pairResult.baseUrl) {
      return pairResult;
    }

    try {
      this.logger('[AutoPair] Exchanging pairing token for session cookie...');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(pairResult.pairingUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const setCookie = resp.headers.get('set-cookie');
      if (!setCookie) {
        return {
          success: false,
          error: 'OpenCode pairing endpoint did not return Set-Cookie',
        };
      }

      const match = setCookie.match(/opencode_session_\d+=[^;]+/);
      if (!match) {
        return {
          success: false,
          error: 'No opencode_session cookie found in pairing response',
        };
      }

      const sessionCookie = match[0];
      const verified = await this.verifySession(pairResult.baseUrl, sessionCookie);
      if (!verified) {
        return {
          success: false,
          error: 'Failed to verify acquired session cookie against OpenCode server',
        };
      }

      this.logger('[AutoPair] Successfully authenticated and verified session cookie.');
      return {
        success: true,
        baseUrl: pairResult.baseUrl,
        pairingUrl: pairResult.pairingUrl,
        connectPath: '/',
        sessionCookie,
      };
    } catch (err: any) {
      const msg = redactSecrets(err.message || String(err));
      this.logger(`[AutoPair] Exchange failed: ${msg}`);
      return {
        success: false,
        error: `AutoPair exchange failed: ${msg}`,
      };
    }
  }

  /**
   * Runs `opencode pair` to obtain a fresh one-time connect URL.
   */
  public async getPairingUrl(): Promise<PairingResult> {
    return new Promise((resolve) => {
      this.logger(`[Pairing] Running '${this.executablePath} pair'...`);

      // Use execFile without shell to prevent command injection
      execFile(
        this.executablePath,
        ['pair'],
        { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' },
        (error, stdout, stderr) => {
          if (error) {
            const sanitizedErr = redactSecrets(error.message);
            this.logger(`[Pairing] Command failed: ${sanitizedErr}`);
            return resolve({
              success: false,
              error: `Failed to execute '${this.executablePath} pair': ${sanitizedErr}. Ensure OpenCode is installed and running.`,
            });
          }

          const output = `${stdout || ''}\n${stderr || ''}`;
          // Look for http(s)://... URL
          const urlMatch = output.match(/https?:\/\/[^\s\r\n]+/);

          if (!urlMatch) {
            this.logger(`[Pairing] No URL found in output.`);
            return resolve({
              success: false,
              error: `No pairing link detected from '${this.executablePath} pair'. Output was: ${redactSecrets(output.slice(0, 300))}`,
            });
          }

          const rawUrl = urlMatch[0];
          const validation = validateUrl(rawUrl);
          if (!validation.valid || !validation.url) {
            this.logger(`[Pairing] Invalid URL extracted: ${validation.error}`);
            return resolve({
              success: false,
              error: validation.error || 'Extracted URL is not valid',
            });
          }

          const parsedUrl = validation.url;
          const baseUrl = new URL(`${parsedUrl.protocol}//${parsedUrl.host}`);
          const connectPath = `${parsedUrl.pathname}${parsedUrl.search}`;

          this.logger(`[Pairing] Got valid pairing link on ${baseUrl.origin} (path: /auth/connect/...)`);
          resolve({
            success: true,
            pairingUrl: rawUrl,
            baseUrl,
            connectPath,
          });
        }
      );
    });
  }

  /**
   * Accepts a user-pasted pairing link or server URL and validates it.
   */
  public parseCustomUrl(rawUrl: string): PairingResult {
    const trimmed = rawUrl.trim();
    const validation = validateUrl(trimmed);
    if (!validation.valid || !validation.url) {
      return {
        success: false,
        error: validation.error || 'The provided URL is invalid.',
      };
    }

    const parsed = validation.url;
    const baseUrl = new URL(`${parsed.protocol}//${parsed.host}`);
    const connectPath = `${parsed.pathname}${parsed.search}`;

    return {
      success: true,
      pairingUrl: trimmed,
      baseUrl,
      connectPath: connectPath === '/' ? undefined : connectPath,
    };
  }

  /**
   * Checks if an OpenCode service is currently responding at the given base URL.
   */
  public async checkHealth(baseUrl: URL): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(baseUrl.origin, { signal: controller.signal });
      clearTimeout(timeout);
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }
}
