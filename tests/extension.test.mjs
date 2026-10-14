import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateUrl, redactSecrets } from '../dist/lib/security.js';
import { PairingController } from '../dist/lib/pairingController.js';
import { LocalBridge } from '../dist/lib/localBridge.js';

test('localBridge: browser POST forwards trusted origin as upstream origin', async t => {
  const backend = http.createServer((req, res) => {
    if (req.headers.origin !== `http://${req.headers.host}`) {
      res.writeHead(401);
      res.end('Authentication required');
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cookie: req.headers.cookie, body }));
    });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const bridge = new LocalBridge(() => {});
  t.after(async () => { await bridge.stop(); backend.close(); });
  const info = await bridge.start(new URL(`http://127.0.0.1:${backend.address().port}`), 0);
  bridge.setSessionCookie('opencode_session_9999=valid');
  const response = await fetch(`${info.proxyUrl}/api/session/example/prompt`, {
    method: 'POST',
    headers: { origin: info.proxyUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'mock-only prompt' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.cookie, 'opencode_session_9999=valid');
  assert.deepEqual(JSON.parse(result.body), { text: 'mock-only prompt' });
});

test('localBridge: rejects foreign browser origins before forwarding requests', async t => {
  let forwarded = 0;
  const backend = http.createServer((_req, res) => { forwarded++; res.end('ok'); });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const bridge = new LocalBridge(() => {});
  t.after(async () => { await bridge.stop(); backend.close(); });
  const info = await bridge.start(new URL(`http://127.0.0.1:${backend.address().port}`), 0);
  for (const path of ['/api/session/example/prompt', '/bridge/sync-cookie']) {
    const response = await fetch(`${info.proxyUrl}${path}`, {
      method: 'POST', headers: { origin: 'https://untrusted.example' }, body: '{}',
    });
    assert.equal(response.status, 403);
    await response.body.cancel();
  }
  assert.equal(forwarded, 0);
});

test('localBridge: reuses compatible bridges but never legacy or different-target bridges', async t => {
  const backend = http.createServer((_req, res) => res.end('ok'));
  const legacy = http.createServer((_req, res) => res.end('{"version":"old"}'));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => legacy.listen(0, '127.0.0.1', resolve));
  const bridges = Array.from({ length: 4 }, () => new LocalBridge(() => {}));
  t.after(async () => {
    for (const bridge of bridges.reverse()) await bridge.stop();
    backend.close();
    legacy.close();
  });
  const target = new URL(`http://127.0.0.1:${backend.address().port}`);
  const first = await bridges[0].start(target, 0);
  const shared = await bridges[1].start(target, first.port);
  assert.equal(shared.reused, true);
  assert.equal(shared.port, first.port);
  const wrongTarget = await bridges[2].start(new URL('http://127.0.0.1:1'), first.port);
  assert.notEqual(wrongTarget.port, first.port);
  const old = await bridges[3].start(target, legacy.address().port);
  assert.notEqual(old.port, legacy.address().port);
});

test('localBridge: restarting and stopping with an open SSE stream completes', { timeout: 4000 }, async (t) => {
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: connected\n\n');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const bridge = new LocalBridge(() => {});
  t.after(async () => {
    backend.closeAllConnections();
    backend.close();
    await bridge.stop();
  });
  const target = new URL(`http://127.0.0.1:${backend.address().port}`);
  const info = await bridge.start(target, 0);
  const response = await fetch(`${info.proxyUrl}/api/event`);
  const next = await bridge.start(target, info.port);
  assert.equal(next.port, info.port);
  await bridge.stop();
  await response.body.cancel().catch(() => {});
  assert.equal(bridge.isRunning(), false);
});

test('localBridge: refreshed server session overrides stale browser cookie', async (t) => {
  const backend = http.createServer((req, res) => {
    res.end(req.headers.cookie || '');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const bridge = new LocalBridge(() => {});
  t.after(async () => { await bridge.stop(); backend.close(); });
  bridge.setSessionCookie('opencode_session_9999=fresh');
  const info = await bridge.start(new URL(`http://127.0.0.1:${backend.address().port}`), 0);
  const response = await fetch(info.proxyUrl, {
    headers: { cookie: 'theme=dark; opencode_session_9999=expired' },
  });
  assert.equal(await response.text(), 'theme=dark; opencode_session_9999=fresh');
});

test('localBridge: stalled shared bridge probe falls back within timeout', { timeout: 6000 }, async t => {
  const stalled = http.createServer(() => {});
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  const bridge = new LocalBridge(() => {});
  t.after(async () => {
    await bridge.stop();
    stalled.closeAllConnections();
    stalled.close();
  });
  const occupiedPort = stalled.address().port;
  const info = await bridge.start(new URL('http://127.0.0.1:1'), occupiedPort);
  assert.notEqual(info.port, occupiedPort);
  assert.equal(info.reused, false);
});

test('security: validateUrl handles valid and invalid urls', () => {
  assert.equal(validateUrl('http://127.0.0.1:49374/auth/connect/abc').valid, true);
  assert.equal(validateUrl('http://localhost:3000').valid, true);
  assert.equal(validateUrl('http://100.64.0.5:49374/').valid, true);
  assert.equal(validateUrl('https://app.opencode.ai').valid, true);
  assert.equal(validateUrl('javascript:alert(1)').valid, false);
  assert.equal(validateUrl('file:///etc/passwd').valid, false);
  assert.equal(validateUrl('not a url').valid, false);
});

test('security: redactSecrets cleans tokens and passwords', () => {
  const raw = 'Error on http://127.0.0.1:49374/auth/connect/example-pairing-token with cookie opencode_session_49374=secret123 and Bearer abc-xyz';
  const cleaned = redactSecrets(raw);
  assert.ok(!cleaned.includes('example-pairing-token'));
  assert.ok(!cleaned.includes('secret123'));
  assert.ok(!cleaned.includes('abc-xyz'));
  assert.ok(cleaned.includes('[REDACTED_PAIRING_TOKEN]'));
  assert.ok(cleaned.includes('[REDACTED_SESSION]'));
  assert.ok(cleaned.includes('[REDACTED_TOKEN]'));
});

test('pairingController: parseCustomUrl handles various formats', () => {
  const controller = new PairingController();
  const res1 = controller.parseCustomUrl('http://127.0.0.1:49374/auth/connect/testToken');
  assert.equal(res1.success, true);
  assert.equal(res1.baseUrl?.origin, 'http://127.0.0.1:49374');
  assert.equal(res1.connectPath, '/auth/connect/testToken');

  const res2 = controller.parseCustomUrl('not-a-valid-url');
  assert.equal(res2.success, false);
});

test('pairingController: verifySession checks authentication on /api/info', async () => {
  const mockServer = http.createServer((req, res) => {
    if (req.url === '/api/info') {
      const cookie = req.headers['cookie'] || '';
      if (cookie.includes('valid-session')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  const mockUrl = new URL(`http://127.0.0.1:${mockPort}`);

  const controller = new PairingController();
  assert.equal(await controller.verifySession(mockUrl, 'opencode_session_1=valid-session'), true);
  assert.equal(await controller.verifySession(mockUrl, 'opencode_session_1=expired-session'), false);

  mockServer.close();
});

test('localBridge: proxies requests, captures cookies and relaxed headers', async () => {
  // 1. Create a mock OpenCode backend server
  const mockServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/auth/connect/')) {
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': 'opencode_session_9999=token-abc-123; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax',
        'X-Frame-Options': 'DENY'
      });
      res.end();
      return;
    }

    if (req.url === '/') {
      const incomingCookie = req.headers['cookie'] || '';
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({
        hasSessionCookie: incomingCookie.includes('opencode_session_9999=token-abc-123')
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  const mockUrl = new URL(`http://127.0.0.1:${mockPort}`);

  let capturedCallbackCookie = '';
  // 2. Start LocalBridge pointing to mock backend
  const bridge = new LocalBridge(() => {});
  bridge.onCookieCaptured = (c) => {
    capturedCallbackCookie = c;
  };

  const info = await bridge.start(mockUrl, 0);
  assert.ok(info.port > 0);

  // 3. Connect via pairing link through bridge
  const authRes = await fetch(`${info.proxyUrl}/auth/connect/test-token`, { redirect: 'manual' });
  assert.equal(authRes.status, 302);
  // Verify bridge captured the cookie
  assert.ok(bridge.getSessionCookie().includes('opencode_session_9999=token-abc-123'));
  assert.ok(capturedCallbackCookie.includes('opencode_session_9999=token-abc-123'));
  // Verify bridge removed X-Frame-Options
  assert.equal(authRes.headers.get('x-frame-options'), null);

  // 4. Request root through bridge without sending cookie from client
  const rootRes = await fetch(`${info.proxyUrl}/`);
  assert.equal(rootRes.status, 200);
  const data = await rootRes.json();
  assert.equal(data.hasSessionCookie, true);

  await bridge.stop();
  mockServer.close();
});
