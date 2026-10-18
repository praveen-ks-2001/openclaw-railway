import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
let instance = 0;
const isolated = () => import(`../src/services/operations.js?coordination-test=${++instance}`);

test('an exclusive operation closes admission immediately and drains existing state readers', async () => {
  const operations = await isolated();
  const readerExit = deferred();
  const events = [];
  const read = operations.withStateRead('SDK owner', async () => {
    events.push('read-start');
    await readerExit.promise;
    events.push('read-exit');
  });
  await tick();
  const write = operations.withExclusiveOperation('replace state', async () => { events.push('write-start'); });
  assert.equal(operations.isOperationActive(), true);
  assert.deepEqual(events, ['read-start']);
  await assert.rejects(operations.withStateRead('late reader', () => assert.fail('admitted late reader')), { status: 409 });
  await assert.rejects(operations.withExclusiveOperation('late writer', () => assert.fail('admitted late writer')), { status: 409 });
  readerExit.resolve();
  await Promise.all([read, write]);
  assert.deepEqual(events, ['read-start', 'read-exit', 'write-start']);
  assert.equal(operations.isOperationActive(), false);
});

test('the exclusive owner may call a state reader without waiting on itself', async () => {
  const operations = await isolated();
  await operations.withExclusiveOperation('owner', async ({ signal }) => {
    assert.equal(operations.isCurrentOperationOwner(), true);
    operations.assertOperationsAvailable();
    const received = await operations.withStateRead('owned config read', async context => context.signal);
    assert.equal(received, signal);
  });
  assert.equal(operations.isCurrentOperationOwner(), false);
});

test('a failed reader releases its lease, and failed mutation releases admission', async () => {
  const operations = await isolated();
  const reader = operations.withStateRead('failed reader', async () => { throw new Error('read failed'); });
  const writer = operations.withExclusiveOperation('writer', async () => { throw new Error('write failed'); });
  await assert.rejects(reader, /read failed/);
  await assert.rejects(writer, /write failed/);
  assert.equal(operations.isOperationActive(), false);
  assert.equal(await operations.withStateRead('next reader', () => 'released'), 'released');
});

test('boot failure blocks ordinary state access and requires deliberate recovery admission', async () => {
  const operations = await isolated();
  operations.setBootFailure('Synthetic failed migration');
  await assert.rejects(operations.withStateRead('read', () => assert.fail()), { status: 503 });
  await assert.rejects(operations.withExclusiveOperation('write', () => assert.fail()), { status: 503 });
  await operations.withExclusiveOperation('deliberate retry', async () => {
    operations.setBootFailure(null);
    operations.assertOperationsAvailable();
  }, { allowBootFailure: true });
  assert.equal(operations.getBootFailure(), null);
});

test('pre-aborted mutation never enters its callback and leaves the gate reusable', async () => {
  const operations = await isolated();
  const controller = new AbortController();
  controller.abort(new Error('cancelled before admission'));
  await assert.rejects(operations.withExclusiveOperation('cancelled', () => assert.fail(), { signal: controller.signal }), /cancelled before admission/);
  assert.equal(operations.isOperationActive(), false);
  assert.equal(await operations.withExclusiveOperation('next writer', () => 'ready'), 'ready');
});

test('shutdown aborts existing readers and a queued writer without starting mutation', async () => {
  const operations = await isolated();
  const entered = deferred();
  const read = operations.withStateRead('SDK subprocess', ({ signal }) => new Promise((resolve, reject) => {
    entered.resolve();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await entered.promise;
  const write = operations.withExclusiveOperation('queued reset', () => assert.fail('shutdown started mutation'));
  // Observe both rejections before triggering abort; no unhandled-rejection races.
  const readFailure = assert.rejects(read, /shutting down/);
  const writeFailure = assert.rejects(write, /shutting down/);
  await operations.stopOperations();
  await Promise.all([readFailure, writeFailure]);
  assert.equal(operations.getOperationState().shuttingDown, true);
  assert.equal(operations.getOperationState().active, false);
  await assert.rejects(operations.withStateRead('new reader', () => assert.fail()), { status: 503 });
});
