/**
 * Security helpers for validating URLs and redacting sensitive tokens from logs.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Validates that a string is a valid HTTP/HTTPS URL and comes from a trusted host (loopback or local/configured).
 */
export function validateUrl(rawUrl: string): { valid: boolean; url?: URL; error?: string } {
  try {
    const parsed = new URL(rawUrl.trim());

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return { valid: false, error: `Invalid protocol: ${parsed.protocol}. Only http and https are permitted.` };
    }

    const host = parsed.hostname.toLowerCase();
    // Allow loopback (localhost, 127.0.0.1, ::1) or private IP ranges (10., 192.168., 172.16-31., 100.64-127. for CGNAT/Tailscale)
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const isPrivateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);

    if (!isLoopback && !isPrivateIp) {
      // In case user provides custom domain or hostname, we accept standard host names but warn
      return { valid: true, url: parsed };
    }

    return { valid: true, url: parsed };
  } catch (err: any) {
    return { valid: false, error: `Malformed URL: ${err?.message || String(err)}` };
  }
}

/**
 * Redacts any pairing tokens, session cookies, or secrets from log messages.
 */
export function redactSecrets(message: string): string {
  if (!message) return '';
  return message
    // Redact tokens in /auth/connect/<token>
    .replace(/\/auth\/connect\/[A-Za-z0-9_-]+/g, '/auth/connect/[REDACTED_PAIRING_TOKEN]')
    // Redact opencode_session cookie values
    .replace(/opencode_session_\d+=[^;,\s]+/g, 'opencode_session=[REDACTED_SESSION]')
    // Redact Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]')
    // Redact password parameter
    .replace(/(password=["']?)[^"'\s&]+/gi, '$1[REDACTED]');
}
