import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';

process.env.WRAPPER_ADMIN_PASSWORD = 'synthetic-adapter-admin';
const { gatewayManager } = await import('../src/services/gatewayManager.js');
const { withExclusiveOperation, isOperationActive } = await import('../src/services/operations.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
test.after(() => gatewayManager.getHttpProxy().close());

for (const method of ['start', 'restart']) {
  test(`${method} adapter requires both successful core result and actual readiness`, async () => {
    const previous = gatewayManager._core;
    try {
      for (const scenario of [{ result: { ok: false }, ready: false }, { result: { ok: true }, ready: false }]) {
        gatewayManager._core = { [method]: async () => scenario.result, isReady: () => scenario.ready, isStarting: () => false };
        await assert.rejects(gatewayManager[method](), /did not become ready/);
        assert.equal(gatewayManager.getState(), 'crashed');
      }
      gatewayManager._core = { [method]: async () => ({ ok: true }), isReady: () => true, isStarting: () => false };
      assert.equal((await gatewayManager[method]()).ok, true);
      assert.equal(gatewayManager.getState(), 'running');
    } finally { gatewayManager._core = previous; }
  });

  test(`${method} inherits operation cancellation and waits for actual stop before releasing the state gate`, async () => {
    const previous = gatewayManager._core;
    const entered = deferred(), startup = deferred(), exited = deferred();
    let stopCalled = false;
    let finished = false;
    gatewayManager._core = {
      [method]: () => { entered.resolve(); return startup.promise; },
      stop: async () => { stopCalled = true; startup.reject(new Error('core startup cancelled')); await exited.promise; },
      isReady: () => false, isStarting: () => false,
    };
    const controller = new AbortController();
    const operation = withExclusiveOperation(`adapter ${method}`, () => gatewayManager[method](), { signal: controller.signal });
    const rejected = assert.rejects(operation, /core startup cancelled|synthetic shutdown/).then(() => { finished = true; });
    try {
      await entered.promise;
      controller.abort(new Error('synthetic shutdown'));
      await tick();
      assert.equal(stopCalled, true);
      assert.equal(finished, false, 'state replacement must wait for the owned process to exit');
      assert.equal(isOperationActive(), true);
      exited.resolve();
      await rejected;
      assert.equal(isOperationActive(), false);
    } finally {
      startup.reject(new Error('test cleanup'));
      exited.resolve();
      await rejected;
      gatewayManager._core = previous;
    }
  });
}

test('stop adapter destroys existing raw proxy sockets and awaits the core exit proof', async () => {
  const previous = gatewayManager._core;
  const exited = deferred();
  let destroyed = false, stopped = false;
  const socket = { destroy: () => { destroyed = true; } };
  gatewayManager._sockets.add(socket);
  gatewayManager._core = { stop: () => exited.promise, isReady: () => false, isStarting: () => false };
  try {
    const stopping = gatewayManager.stop().then(() => { stopped = true; });
    assert.equal(destroyed, true);
    await tick();
    assert.equal(stopped, false);
    exited.resolve();
    await stopping;
    assert.equal(gatewayManager.getState(), 'stopped');
  } finally { exited.resolve(); gatewayManager._sockets.delete(socket); gatewayManager._core = previous; }
});

test('raw WebSocket adapter rechecks maintenance after connecting upstream before forwarding headers or frame head', async () => {
  const previous = gatewayManager._core;
  const originalConnect = net.connect;
  class Socket extends EventEmitter {
    destroyed = false;
    writes = [];
    setTimeout() { return this; }
    write(value) { this.writes.push(value); }
    pipe() { return this; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
    end(value) { this.write(value); this.destroy(); }
  }
  const upstream = new Socket(), browser = new Socket();
  net.connect = () => upstream;
  gatewayManager._core = { isReady: () => true, isStarting: () => false };
  let release;
  let operation;
  try {
    gatewayManager.handleWsUpgrade({ url: '/', headers: {}, rawHeaders: [], method: 'GET', httpVersion: '1.1' }, browser, Buffer.from('must not forward'));
    operation = withExclusiveOperation('replace state during TCP connect', () => new Promise(resolve => { release = resolve; }));
    await tick();
    upstream.emit('connect');
    assert.equal(upstream.destroyed, true);
    assert.equal(browser.destroyed, true);
    assert.deepEqual(upstream.writes, []);
  } finally {
    release?.();
    await operation;
    net.connect = originalConnect;
    gatewayManager._core = previous;
  }
});
