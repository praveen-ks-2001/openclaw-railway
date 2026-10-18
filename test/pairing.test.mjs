import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingService } from '../src/services/pairingService.js';
import { withExclusiveOperation } from '../src/services/operations.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('pairing constructor performs no state reads; isolated calls reflect replaced state', async () => {
  let generation = 0;
  const calls = [];
  const service = new PairingService({ sdk: async (action) => { calls.push(action); return { pending: [{ requestId: `request-${generation}` }], paired: [{ deviceId: `device-${generation}`, tokens: { operator: { token: 'never-expose' } } }] }; } });
  assert.deepEqual(calls, []);
  assert.equal((await service.getPending())[0].requestId, 'request-0');
  generation++;
  assert.equal((await service.getPending())[0].requestId, 'request-1');
  assert.equal(JSON.stringify(await service.getPaired()).includes('never-expose'), false);
});

test('simultaneous pending and paired lists use one worker; mutation drains reader before state replacement', async () => {
  let finish;
  let calls = 0;
  const service = new PairingService({ sdk: async () => { calls++; await new Promise((resolve) => { finish = resolve; }); return { pending: [], paired: [] }; } });
  const pending = service.getPending();
  const paired = service.getPaired();
  await delay(0);
  assert.equal(calls, 1);
  let changed = false;
  const mutation = withExclusiveOperation('replace-state', async () => { changed = true; });
  await delay(0); assert.equal(changed, false);
  await assert.rejects(service.listDevices(), (error) => error.status === 409);
  finish(); await Promise.all([pending, paired, mutation]); assert.equal(changed, true);
});

test('approval carries the exact browser request ID and handles forbidden/stale results', async () => {
  const calls = [];
  const service = new PairingService({ sdk: async (action, options) => { calls.push({ action, requestId: options.requestId }); return { status: 'approved', device: { deviceId: 'device', token: 'secret' } }; } });
  const result = await service.approve('matching-request');
  assert.deepEqual(calls, [{ action: 'devices-approve', requestId: 'matching-request' }]);
  assert.deepEqual(result, { requestId: 'matching-request', device: { deviceId: 'device' } });
  for (const invalid of ['', '--help', '--evil value', 'abc\n', null, {}]) await assert.rejects(service.approve(invalid), (error) => error.status === 400);
  const forbidden = new PairingService({ sdk: async () => ({ status: 'forbidden', reason: 'caller-missing-scope' }) });
  await assert.rejects(forbidden.approve('request'), (error) => error.status === 403);
  const stale = new PairingService({ sdk: async () => null });
  await assert.rejects(stale.approve('request'), (error) => error.status === 404);
});

test('reject/removal use bounded official CLI, with no legacy files or silent failed revoke', async () => {
  const calls = [];
  const service = new PairingService({ cli: async (args, options) => { calls.push({ args, options }); return { code: 0 }; } });
  await service.reject('request');
  await service.revoke('device', 'operator');
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 2)), [['devices', 'reject'], ['devices', 'revoke'], ['devices', 'remove']]);
  for (const { args, options } of calls) { assert.equal(options.timeoutMs, 25000); assert.ok(args.includes('--url')); assert.ok(options.signal instanceof AbortSignal); }
  const failed = new PairingService({ cli: async () => ({ code: 1, output: 'sensitive-gateway-token' }) });
  await assert.rejects(failed.revoke('device', 'operator'), (error) => !error.message.includes('sensitive-gateway-token'));
});

test('explicit polling emits canonical pending changes, and stops cleanly', async (t) => {
  let count = 0;
  const service = new PairingService({ intervalMs: 10, sdk: async () => ({ pending: [{ requestId: String(count) }], paired: [] }) });
  t.after(() => service.stopWatching());
  const events = [];
  service.on('pendingChanged', (pending) => events.push(pending));
  service.startWatching();
  await delay(25); assert.equal(events.length, 1);
  count = 1; await delay(25); assert.equal(events.length, 2);
  service.stopWatching(); count = 2; await delay(25); assert.equal(events.length, 2);
});

test('unsubscribed watchers launch no SDK processes while manual reads still work', async (t) => {
  let calls = 0;
  const service = new PairingService({ intervalMs: 5, sdk: async () => { calls++; return { pending: [{ requestId: 'manual-request' }], paired: [] }; } });
  t.after(() => service.stopWatching());
  service.startWatching();
  await delay(25);
  assert.equal(calls, 0, 'idle boot must not launch an eager worker or periodic workers');
  assert.equal((await service.getPending())[0].requestId, 'manual-request');
  await delay(25);
  assert.equal(calls, 1, 'a manual read must not enable idle background polling');
});

test('polling follows SSE subscribers and stops launching workers after unsubscribe or stop', async (t) => {
  let calls = 0;
  const service = new PairingService({ intervalMs: 5, sdk: async () => { calls++; return { pending: [{ requestId: String(calls) }], paired: [] }; } });
  t.after(() => service.stopWatching());
  const updates = [];
  const listener = (pending) => updates.push(pending);
  service.startWatching();
  service.on('pendingChanged', listener);
  await delay(25);
  assert.ok(calls > 0);
  assert.equal(updates.length, calls);
  service.off('pendingChanged', listener);
  const afterUnsubscribe = calls;
  await delay(25);
  assert.equal(calls, afterUnsubscribe, 'closing the last SSE subscriber stops SDK reads');
  const updateListener = () => {};
  service.on('pairingUpdate', updateListener);
  await delay(25);
  assert.ok(calls > afterUnsubscribe, 'an active pairing update subscriber enables refresh');
  service.stopWatching();
  const afterStop = calls;
  await delay(25);
  assert.equal(calls, afterStop, 'stopped watchers do not launch further workers');
});
