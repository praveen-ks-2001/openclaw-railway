import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { log } from '../src/utils/log.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-fourth-server-test-'));
process.env.OPENCLAW_DATA_DIR = directory;
process.env.WRAPPER_ADMIN_PASSWORD = 'synthetic-server-admin';
process.env.OPENCLAW_GATEWAY_TOKEN = 'synthetic-server-gateway';
const { createApp } = await import('../src/server.js');
const { gatewayManager } = await import('../src/services/gatewayManager.js');
const { setAuthCookie } = await import('../src/middleware/auth.js');
const { withExclusiveOperation, setBootFailure } = await import('../src/services/operations.js');
const { getActiveSessionCount, stopAllTerminalSessions } = await import('../src/services/terminalService.js');
await fs.mkdir(path.join(directory, '.openclaw', 'workspace'), { recursive: true });
await fs.writeFile(path.join(directory, '.openclaw', 'openclaw.json'), '{}');

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('base64') }));
  });
});
const websocketGateway = new WebSocketServer({ noServer: true });
let lastUpgrade;
upstream.on('upgrade', (req, socket, head) => {
  lastUpgrade = { path: req.url, headers: req.headers };
  websocketGateway.handleUpgrade(req, socket, head, ws => {
    websocketGateway.emit('connection', ws, req);
    ws.on('message', raw => ws.send(`echo:${raw.toString()}`));
  });
});
await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
const upstreamPort = upstream.address().port;
const originalConnect = net.connect;
net.connect = function (port, host, ...args) {
  // The adapter's production loopback port is redirected only inside this test.
  if (port === 18789 && host === '127.0.0.1') return originalConnect.call(net, upstreamPort, host, ...args);
  return originalConnect.call(net, port, host, ...args);
};
const originalCore = gatewayManager._core;
gatewayManager._core = { isReady: () => true, isStarting: () => false };
const proxy = gatewayManager.getHttpProxy();
const originalTarget = proxy.options.target;
proxy.options.target = { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: upstreamPort };
const { httpServer } = createApp();
await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${httpServer.address().port}`;
const wsOrigin = origin.replace('http:', 'ws:');
let cookie;
setAuthCookie({ setHeader(name, value) { if (name === 'Set-Cookie') cookie = value.split(';')[0]; } }, process.env.WRAPPER_ADMIN_PASSWORD);
const browserHeaders = () => ({ cookie: cookie + '; native_preference=keep', origin });
const clients = new Set();
const tick = () => new Promise(resolve => setImmediate(resolve));
function socketAt(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsOrigin + route, { headers, handshakeTimeout: 1500 });
    clients.add(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, response) => {
      response.resume();
      reject(Object.assign(new Error(`Handshake refused: ${response.statusCode}`), { status: response.statusCode }));
      ws.terminate();
    });
    ws.once('close', () => clients.delete(ws));
  });
}
async function echo(ws, message) {
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket echo timed out')), 1500);
    ws.once('message', data => { clearTimeout(timer); resolve(data.toString()); });
  });
  ws.send(message);
  return received;
}
test.after(async () => {
  setBootFailure(null);
  for (const ws of clients) ws.terminate();
  for (const ws of websocketGateway.clients) ws.terminate();
  await stopAllTerminalSessions();
  for (const socket of gatewayManager._sockets) socket.destroy();
  net.connect = originalConnect;
  gatewayManager._core = originalCore;
  proxy.options.target = originalTarget;
  proxy.close();
  httpServer.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => httpServer.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  websocketGateway.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test('actual native HTTP proxy preserves original path/body and never grants anonymous Gateway credentials', async () => {
  const body = '{\n  "message": "naïve 🦞", "n": 1\n}\n';
  const response = await fetch(origin + '/tools/invoke?probe=original', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(response.status, 200);
  const received = await response.json();
  assert.equal(received.path, '/tools/invoke?probe=original');
  assert.equal(Buffer.from(received.body, 'base64').toString(), body);
  assert.equal(received.headers.authorization, undefined);
});

test('malformed management JSON never echoes a credential in diagnostics or the response', async () => {
  const secret = 'SYNTHETIC_SENSITIVE_KEY';
  const original = log.error;
  const diagnostics = [];
  log.error = (...values) => diagnostics.push(values.join(' '));
  try {
    const response = await fetch(origin + '/setup/save', {
      method:'POST', headers:{'content-type':'application/json'}, body:`{"apiKey":"${secret}", INVALID}`,
    });
    assert.equal(response.status,400);
    assert.equal((await response.text()).includes(secret),false);
    assert.equal(diagnostics.join('\n').includes(secret),false);
  } finally { log.error = original; }
});

test('authenticated native HTTP bridge strips wrapper cookie, replaces forged attribution, and preserves body bytes', async () => {
  const body = '{\n"messages":[{"role":"user","content":"hello 世界"}]\n}';
  const response = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers: { ...browserHeaders(), 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'forged', forwarded: 'for=127.0.0.1' }, body });
  const received = await response.json();
  assert.equal(response.status, 200);
  assert.equal(received.headers.authorization, `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`);
  assert.equal(received.headers.cookie.trim(), 'native_preference=keep');
  assert.equal(received.headers['x-forwarded-for'], '192.0.2.1');
  assert.equal(received.headers['x-forwarded-host'], undefined);
  assert.equal(received.headers.forwarded, undefined);
  assert.equal(Buffer.from(received.body, 'base64').toString(), body);
});

test('native API JSON passes untouched without losing or reserializing bytes', async () => {
  const body = ' { "unicode": "こんにちは",\n "number": 1.00 }\n';
  const response = await fetch(origin + '/api/native-fallback?exact=1', { method: 'POST', headers: { ...browserHeaders(), 'content-type': 'application/json' }, body });
  const received = await response.json();
  assert.equal(response.status, 200);
  assert.equal(received.path, '/api/native-fallback?exact=1');
  assert.equal(Buffer.from(received.body, 'base64').toString(), body);
  assert.equal(Number(received.headers['content-length']), Buffer.byteLength(body));
});

test('native API uploads bypass wrapper management JSON limits and preserve independent client credentials', async () => {
  const body = JSON.stringify({ payload: 'x'.repeat(2 * 1024 * 1024 + 10), unicode: 'こんにちは' });
  const response = await fetch(origin + '/api/channels/native-upload?ticket=synthetic-capability', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer native-client-token', origin: 'https://native-client.example' }, body,
  });
  assert.equal(response.status, 200);
  const received = await response.json();
  assert.equal(received.path, '/api/channels/native-upload?ticket=synthetic-capability');
  assert.equal(received.headers.authorization, 'Bearer native-client-token');
  assert.equal(Buffer.from(received.body, 'base64').toString(), body);
});

test('native caller credentials and independent hook authentication survive wrapper login', async () => {
  for (const route of ['/v1/responses', '/hooks/custom', '/__openclaw__/worker/run', '/j/sample']) {
    const response = await fetch(origin + route, { method: 'POST', headers: { ...browserHeaders(), authorization: 'Bearer independent-native-credential' }, body: 'original' });
    const received = await response.json();
    assert.equal(received.headers.authorization, 'Bearer independent-native-credential', route);
    assert.equal(received.headers.cookie.trim(), 'native_preference=keep');
  }
  const foreign = await (await fetch(origin + '/tools/invoke', { headers: { cookie, origin: 'https://attacker.invalid' } })).json();
  assert.equal(foreign.headers.authorization, undefined);
});

test('wrapper-only admin token header is not forwarded to the native Gateway', async () => {
  const response = await fetch(origin + '/v1/responses', { headers: { 'x-admin-token': process.env.WRAPPER_ADMIN_PASSWORD } });
  const received = await response.json();
  assert.equal(received.headers.authorization, `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`);
  assert.equal(received.headers['x-admin-token'], undefined);
});

test('actual raw WebSocket bridge carries frames and retains independent auth while removing wrapper credentials', async () => {
  const ws = await socketAt('/native-ws?sample=1', { ...browserHeaders(), 'x-forwarded-for': '127.0.0.1', 'x-admin-token': process.env.WRAPPER_ADMIN_PASSWORD });
  assert.equal(await echo(ws, 'frame through raw TCP'), 'echo:frame through raw TCP');
  assert.equal(lastUpgrade.path, '/native-ws?sample=1');
  assert.equal(lastUpgrade.headers.authorization, `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`);
  assert.equal(lastUpgrade.headers.cookie.trim(), 'native_preference=keep');
  assert.equal(lastUpgrade.headers['x-forwarded-for'], '192.0.2.1');
  assert.equal(lastUpgrade.headers['x-admin-token'], undefined);
  ws.close();
  const independent = await socketAt('/native-ws', { ...browserHeaders(), authorization: 'Bearer independent-websocket-credential' });
  assert.equal(await echo(independent, 'independent'), 'echo:independent');
  assert.equal(lastUpgrade.headers.authorization, 'Bearer independent-websocket-credential');
  independent.close();
});

test('anonymous native WebSocket is proxied without a token, and terminal upgrades require same-origin admin auth', async () => {
  const ws = await socketAt('/native-ws');
  assert.equal(await echo(ws, 'anonymous'), 'echo:anonymous');
  assert.equal(lastUpgrade.headers.authorization, undefined);
  ws.close();
  await assert.rejects(socketAt('/ws/terminal'), { status: 401 });
  await assert.rejects(socketAt('/ws/terminal', { cookie, origin: 'https://attacker.invalid' }), { status: 401 });
  const terminal = await socketAt('/ws/terminal', browserHeaders());
  assert.equal(getActiveSessionCount(), 1);
  terminal.close();
  await stopAllTerminalSessions();
  assert.equal(getActiveSessionCount(), 0);
});

test('maintenance closes new HTTP/WS admission while health and authenticated recovery status stay readable', async () => {
  let finish;
  const work = withExclusiveOperation('integration maintenance', () => new Promise(resolve => { finish = resolve; }));
  await tick();
  try {
    assert.equal((await fetch(origin + '/tools/invoke')).status, 503);
    await assert.rejects(socketAt('/native-ws', browserHeaders()), { status: 503 });
    assert.equal((await fetch(origin + '/api/status')).status, 200);
    const admin = await fetch(origin + '/api/admin/status', { headers: { cookie } });
    assert.equal(admin.status, 200);
    assert.equal((await admin.json()).operation.active, true);
  } finally { finish(); await work; }
});

test('actual server blocks anonymous upgrade retry and setup mutations before any operation starts', async () => {
  for (const route of ['/api/upgrade/retry', '/setup/save', '/setup/reset', '/setup/pairing/approve']) {
    const response = await fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401, route);
  }
});
