/** The terminal keeps the existing JSON protocol and defers PTY until resize. */
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { DATA_DIR, OPENCLAW_STATE_DIR, WORKSPACE_DIR, OPENCLAW_ENTRY, OPENCLAW_NODE } from '../config/index.js';
import { isAdminAuthenticated, isAdminOriginAllowed } from '../middleware/auth.js';
import { assertOperationsAvailable } from './operations.js';
import { log } from '../utils/log.js';

const MAX_SESSIONS = 5;
const sessions = new Map();
let sessionCounter = 0;
let attached = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function groupAlive(session) {
  if (process.platform === 'win32' || !session.ptyProc?.pid) return false;
  try { process.kill(-session.ptyProc.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function killSession(session, signal) {
  if (process.platform !== 'win32' && session.ptyProc?.pid) {
    try { process.kill(-session.ptyProc.pid, signal); return; } catch { /* fall back to the owned PTY */ }
  }
  try { session.ptyProc?.kill(signal); } catch { /* checked by exit event */ }
}
async function cleanupGroup(session) {
  if (!groupAlive(session)) return true;
  killSession(session, 'SIGTERM');
  let deadline = Date.now() + 1500;
  while (groupAlive(session) && Date.now() < deadline) await delay(20);
  if (!groupAlive(session)) return true;
  killSession(session, 'SIGKILL');
  deadline = Date.now() + 1500;
  while (groupAlive(session) && Date.now() < deadline) await delay(20);
  return !groupAlive(session);
}
export const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function send(ws, message) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(message)); } catch { ws.terminate?.(); }
  }
}

export function createTerminalSession(ws, req, { spawn = pty.spawn } = {}) {
  try {
    if (!isAdminAuthenticated(req) || !isAdminOriginAllowed(req)) throw new Error('Admin login and a same-origin connection are required.');
    assertOperationsAvailable();
    if (sessions.size >= MAX_SESSIONS) throw new Error('Too many terminal sessions. Close another terminal and try again.');
  } catch (error) {
    send(ws, { type: 'output', data: `\r\n[${error.message}]\r\n` });
    ws.close(1013, 'Terminal unavailable');
    return;
  }

  const id = ++sessionCounter;
  let resolveExit;
  const session = { ws, ptyProc: null, started: false, closing: false, exited: new Promise((resolve) => { resolveExit = resolve; }) };
  sessions.set(id, session);
  let completing = false;
  const complete = async () => {
    if (completing) return;
    completing = true;
    if (!await cleanupGroup(session)) {
      log.error('A terminal process group did not exit; maintenance will remain blocked.');
      return;
    }
    sessions.delete(id);
    resolveExit();
  };
  const stop = () => {
    if (session.closing) return;
    session.closing = true;
    if (session.ptyProc) {
      killSession(session, 'SIGTERM');
    } else complete();
  };
  session.stop = stop;

  ws.on('message', (raw) => {
    if (session.closing) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      assertOperationsAvailable();
      if (msg?.type === 'input' && typeof msg.data === 'string' && msg.data.length <= 64 * 1024) session.ptyProc?.write(msg.data);
      if (msg?.type !== 'resize' || !Number.isInteger(msg.cols) || !Number.isInteger(msg.rows) || msg.cols < 1 || msg.rows < 1 || msg.cols > 500 || msg.rows > 200) return;
      if (session.started) { session.ptyProc?.resize(msg.cols, msg.rows); return; }
      session.started = true;
      const env = { ...process.env, HOME: DATA_DIR, OPENCLAW_STATE_DIR, OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR, OPENCLAW_NO_AUTO_UPDATE: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      delete env.WRAPPER_ADMIN_PASSWORD;
      session.ptyProc = spawn(OPENCLAW_NODE, [OPENCLAW_ENTRY, 'tui'], { name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: WORKSPACE_DIR, env });
      session.ptyProc.onData((data) => send(ws, { type: 'output', data }));
      session.ptyProc.onExit(({ exitCode }) => {
        send(ws, { type: 'exit', code: exitCode });
        if (ws.readyState === 1) ws.close(1000, 'Terminal exited');
        complete();
      });
      log.info(`Terminal session #${id} started.`);
    } catch (error) {
      send(ws, { type: 'output', data: `\r\n[Terminal unavailable: ${error.message}]\r\n` });
      stop();
      if (ws.readyState === 1) ws.close(1011, 'Terminal unavailable');
      if (!session.ptyProc) complete();
    }
  });
  ws.on('close', stop);
  ws.on('error', (error) => { log.debug('Terminal connection closed:', error.message); stop(); ws.terminate?.(); });
}

export function attachTerminalWebSocket() {
  if (attached) return;
  attached = true;
  terminalWss.on('connection', createTerminalSession);
  terminalWss.on('error', (error) => log.error('Terminal WebSocket error:', error.message));
}

export const getActiveSessionCount = () => sessions.size;

/** Do not let a reset/config migration replace state while a PTY can write it. */
export async function stopAllTerminalSessions() {
  const active = [...sessions.values()];
  for (const session of active) {
    session.stop();
    if (session.ws.readyState === 1) session.ws.close(1012, 'Maintenance in progress');
  }
  if (!active.length) return;
  const finished = Promise.all(active.map((session) => session.exited));
  let timer;
  const wait = (ms) => new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  if (await Promise.race([finished.then(() => true), wait(2000)])) { clearTimeout(timer); return; }
  clearTimeout(timer);
  for (const session of active) {
    if (![...sessions.values()].includes(session)) continue;
    killSession(session, 'SIGKILL');
    session.ws.terminate?.();
  }
  const exited = await Promise.race([finished.then(() => true), wait(3000)]);
  clearTimeout(timer);
  if (!exited) throw new Error('A terminal process did not exit. Maintenance was stopped to protect your data.');
}
