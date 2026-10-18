import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-admin-api-test-'));
process.env.OPENCLAW_DATA_DIR = directory;
process.env.WRAPPER_ADMIN_PASSWORD = 'synthetic-api-admin';
process.env.OPENCLAW_GATEWAY_TOKEN = 'synthetic-private-gateway-token';
const { apiRoutes } = await import('../src/routes/api.js');
const { setAuthCookie } = await import('../src/middleware/auth.js');
const { OPENCLAW_CONFIG_PATH, SETUP_INCOMPLETE_PATH } = await import('../src/config/index.js');
const { gatewayManager } = await import('../src/services/gatewayManager.js');
const { setBootFailure } = await import('../src/services/operations.js');
const app = express(); app.use(express.json()); app.use('/api', apiRoutes);
// Stand in for the Gateway after the wrapper router; report the original inputs.
app.use((req, res) => res.status(209).json({
  gateway: true,
  url: req.originalUrl,
  method: req.method,
  authorization: req.headers.authorization || null,
  origin: req.headers.origin || null,
  wrapperCacheControl: res.getHeader('Cache-Control') || null,
  body: req.body,
}));
const server = createServer(app); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const bearer = { authorization: `Bearer ${process.env.WRAPPER_ADMIN_PASSWORD}` };
let cookie;
setAuthCookie({ setHeader(name, value) { if (name === 'Set-Cookie') cookie = value.split(';')[0]; } }, process.env.WRAPPER_ADMIN_PASSWORD);
const originalGatewayMethods = {
  isRunning: gatewayManager.isRunning,
  getState: gatewayManager.getState,
  restart: gatewayManager.restart,
};
function restoreProcessState() {
  setBootFailure(null);
  for (const [name, implementation] of Object.entries(originalGatewayMethods)) gatewayManager[name] = implementation;
}
test.beforeEach(async () => {
  restoreProcessState();
  await Promise.all([
    fs.rm(OPENCLAW_CONFIG_PATH, { force: true }),
    fs.rm(SETUP_INCOMPLETE_PATH, { force: true }),
  ]);
});
test.afterEach(restoreProcessState);
test.after(async () => { restoreProcessState(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
const save = async (raw) => { await fs.mkdir(path.dirname(OPENCLAW_CONFIG_PATH), { recursive: true }); await fs.writeFile(OPENCLAW_CONFIG_PATH, raw); };

test('configured but stopped Gateway is unhealthy without disclosing private admin details', async () => {
  await save(JSON.stringify({ gateway: { auth: { token: 'disk-secret' } }, agents: { defaults: { model: { primary: 'private-provider/private-model' } } } }));
  const response = await fetch(origin + '/api/status'); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.configured, true); assert.equal(body.running, false);
  for (const key of ['gatewayToken', 'aiProvider', 'terminalSessions', 'operation', 'bootFailure']) assert.equal(Object.hasOwn(body, key), false);
  assert.equal(JSON.stringify(body).includes('private-provider'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('fresh and incomplete installations keep healthy setup access without claiming configuration is complete', async () => {
  const fresh = await fetch(origin + '/api/status');
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).configured, false);
  await save(JSON.stringify({ gateway: { mode: 'local' } }));
  await fs.writeFile(SETUP_INCOMPLETE_PATH, 'incomplete');
  const incomplete = await fetch(origin + '/api/status');
  assert.equal(incomplete.status, 200);
  const body = await incomplete.json();
  assert.equal(body.configured, false);
  assert.equal(body.running, false);
});

test('ready Gateway is healthy, but any boot failure makes health503 while remaining sanitized', async () => {
  await save(JSON.stringify({ gateway: { mode: 'local' } }));
  gatewayManager.isRunning = () => true;
  gatewayManager.getState = () => 'running';
  const ready = await fetch(origin + '/api/status');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).running, true);
  setBootFailure('Synthetic private recovery detail');
  const blocked = await fetch(origin + '/api/status');
  assert.equal(blocked.status, 503);
  const body = await blocked.json();
  assert.equal(body.configured, true);
  assert.equal(Object.hasOwn(body, 'bootFailure'), false);
  assert.equal(JSON.stringify(body).includes('Synthetic private recovery detail'), false);
});

test('protected status retains UI shape and remains readable when config/upgrade failed', async () => {
  await save('{broken JSON');
  setBootFailure('Synthetic interrupted migration');
  const anonymous = await fetch(origin + '/api/admin/status'); assert.equal(anonymous.status, 401);
  const response = await fetch(origin + '/api/admin/status', { headers: bearer }); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.gatewayToken, process.env.OPENCLAW_GATEWAY_TOKEN);
  assert.equal(body.aiProvider, null); assert.equal(body.bootFailure, 'Synthetic interrupted migration');
  assert.equal(typeof body.terminalSessions, 'number'); assert.equal(typeof body.operation.active, 'boolean');
  assert.equal(body.configured, false);
  const health = await fetch(origin + '/api/status');
  assert.equal(health.status, 503);
  assert.equal((await health.json()).configured, false);
});

test('all data/config/control APIs require auth; cookie cross-origin mutations fail before operations', async () => {
  for (const route of ['/logs', '/logs/stream', '/events', '/config', '/pairing/pending', '/pairing/paired', '/pairing/stream', '/setup-ui', '/LOGS/', '/CONFIG/']) {
    const response = await fetch(origin + '/api' + route); assert.equal(response.status, 401, route);
  }
  for (const route of ['/gateway/restart', '/gateway/stop', '/config', '/pairing/approve', '/pairing/reject', '/pairing/revoke']) {
    const response = await fetch(origin + '/api' + route, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://attacker.example' }, body: '{}' });
    assert.equal(response.status, 403, route);
  }
});

test('actual config route emits revision, redacts secrets, and rejects old/stale POST contracts', async () => {
  await save(JSON.stringify({ gateway: { auth: { token: 'disk-secret' } }, models: { providers: { test: { apiKey: 'provider-secret' } } } }));
  const response = await fetch(origin + '/api/config', { headers: bearer }); const loaded = await response.json();
  assert.equal(response.status, 200); assert.match(loaded.revision, /^[a-f0-9]{64}$/);
  assert.equal(loaded.config.models.providers.test.apiKey, '[redacted]');
  assert.equal(JSON.stringify(loaded).includes('provider-secret'), false);
  const legacy = await fetch(origin + '/api/config', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(loaded.config) });
  assert.equal(legacy.status, 400);
  const stale = await fetch(origin + '/api/config', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ config: loaded.config, revision: '0'.repeat(64) }) });
  assert.equal(stale.status, 409);
});

test('authenticated same-origin restart route awaits verified Gateway result', async () => {
  const original = gatewayManager.restart;
  let called = false;
  gatewayManager.restart = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); called = true; };
  try {
    const response = await fetch(origin + '/api/gateway/restart', { method: 'POST', headers: { cookie, origin } });
    assert.equal(response.status, 200); assert.equal(called, true);
    assert.match((await response.json()).message, /verified/);
  } finally { gatewayManager.restart = original; }
});

test('native API bearer clients reach the Gateway with credentials and payload intact', async () => {
  const headers = { authorization: 'Bearer synthetic-independent-client-token', 'content-type': 'application/json', origin: 'https://native-client.example' };
  for (const route of ['/api/users/self?view=profile', '/api/nodes/watch/device-id', '/api/channels/telegram/action', '/api/configuration/native-extension']) {
    const response = await fetch(origin + route, { method: 'POST', headers, body: JSON.stringify({ native: 'unchanged', nested: { count: 2 } }) });
    assert.equal(response.status, 209, route);
    const body = await response.json();
    assert.equal(body.gateway, true);
    assert.equal(body.url, route);
    assert.equal(body.method, 'POST');
    assert.equal(body.authorization, headers.authorization);
    assert.equal(body.origin, headers.origin);
    assert.deepEqual(body.body, { native: 'unchanged', nested: { count: 2 } });
    assert.equal(body.wrapperCacheControl, null);
  }
});

test('native anonymous capability downloads bypass wrapper admin authentication without altering tickets', async () => {
  for (const route of ['/api/chat/media/outgoing/asset-id?ticket=synthetic-media-ticket', '/api/artifacts/download/artifact-id?capability=synthetic-download-ticket']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 209, route);
    const body = await response.json();
    assert.equal(body.gateway, true);
    assert.equal(body.url, route);
    assert.equal(body.authorization, null);
    assert.equal(body.wrapperCacheControl, null);
  }
});
