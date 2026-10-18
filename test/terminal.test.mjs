import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
process.env.WRAPPER_ADMIN_PASSWORD = 'synthetic-terminal-admin';
const { createTerminalSession, getActiveSessionCount, stopAllTerminalSessions } = await import('../src/services/terminalService.js');
const { OPENCLAW_ENTRY, OPENCLAW_NODE, WORKSPACE_DIR } = await import('../src/config/index.js');
const { withExclusiveOperation } = await import('../src/services/operations.js');
class Socket extends EventEmitter {
  readyState = 1;
  messages = [];
  send(raw) { this.messages.push(JSON.parse(raw)); }
  close(code, reason) { this.code = code; this.reason = reason; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1006, 'terminated'); }
}
const request = () => ({ headers: { host: 'local.example', origin: 'https://local.example', authorization: `Bearer ${process.env.WRAPPER_ADMIN_PASSWORD}` }, method: 'GET' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakePty = () => {
  const pty = { writes: [], sizes: [], write(data) { this.writes.push(data); }, resize(cols, rows) { this.sizes.push([cols, rows]); }, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, kill() { this.exit?.({ exitCode: 0 }); } };
  return pty;
};

test('terminal defers selected CLI spawn until valid resize and keeps JSON protocol', async () => {
  const socket = new Socket(); const calls = []; const pty = fakePty();
  createTerminalSession(socket, request(), { spawn: (...args) => { calls.push(args); return pty; } });
  assert.equal(getActiveSessionCount(), 1); assert.equal(calls.length, 0);
  socket.emit('message', Buffer.from('{"type":"resize","cols":80.2,"rows":24}'));
  assert.equal(calls.length, 0);
  socket.emit('message', Buffer.from('{"type":"resize","cols":90,"rows":30}'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], OPENCLAW_NODE); assert.deepEqual(calls[0][1], [OPENCLAW_ENTRY, 'tui']);
  assert.equal(calls[0][2].cwd, WORKSPACE_DIR); assert.equal(calls[0][2].env.WRAPPER_ADMIN_PASSWORD, undefined);
  socket.emit('message', Buffer.from('{"type":"input","data":"hello"}')); assert.deepEqual(pty.writes, ['hello']);
  socket.emit('message', Buffer.from('{"type":"resize","cols":100,"rows":40}')); assert.deepEqual(pty.sizes, [[100, 40]]);
  pty.data('hello back'); assert.deepEqual(socket.messages.at(-1), { type: 'output', data: 'hello back' });
  await stopAllTerminalSessions(); assert.equal(getActiveSessionCount(), 0);
});

test('terminal denies unauthenticated/cross-origin connections, and rechecks maintenance before deferred spawn', async () => {
  for (const req of [{ headers: { host: 'local.example', origin: 'https://local.example' } }, { headers: { ...request().headers, origin: 'https://evil.example' } }]) {
    const socket = new Socket(); createTerminalSession(socket, req, { spawn: () => assert.fail() }); assert.equal(socket.code, 1013);
  }
  const socket = new Socket(); let spawned = false;
  createTerminalSession(socket, request(), { spawn: () => { spawned = true; return fakePty(); } });
  let enter, finish;
  const entered = new Promise((resolve) => { enter = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const maintenance = withExclusiveOperation('test-reset', async () => { enter(); await pending; });
  await entered;
  socket.emit('message', Buffer.from('{"type":"resize","cols":90,"rows":30}'));
  assert.equal(spawned, false);
  finish(); await maintenance;
  await stopAllTerminalSessions();
  assert.equal(getActiveSessionCount(), 0);
});

test('spawn errors and excessive sessions clean up without leaving phantom writers', async () => {
  const socket = new Socket(); createTerminalSession(socket, request(), { spawn: () => { throw new Error('synthetic spawn failure'); } });
  socket.emit('message', Buffer.from('{"type":"resize","cols":90,"rows":30}'));
  await delay(0); assert.equal(getActiveSessionCount(), 0);
  const sockets = Array.from({ length: 6 }, () => new Socket());
  for (const ws of sockets) createTerminalSession(ws, request(), { spawn: () => assert.fail('no resize yet') });
  assert.equal(getActiveSessionCount(), 5); assert.equal(sockets[5].code, 1013);
  await stopAllTerminalSessions(); assert.equal(getActiveSessionCount(), 0);
});
