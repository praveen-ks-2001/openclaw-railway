import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import httpProxy from 'http-proxy';
import { createGatewayManager } from '../core/gateway-manager.js';
import { createOutputFilter } from '../core/command-runner.js';
import { applyProxyPolicy, usesIndependentAuthentication } from '../core/proxy-policy.js';
import { isAdminAuthenticated, isAdminOriginAllowed } from '../middleware/auth.js';
import { config, OPENCLAW_ENTRY, OPENCLAW_NODE, OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD,
  OPENCLAW_STATE_DIR, WORKSPACE_DIR, GATEWAY_PORT, GATEWAY_HOST, GATEWAY_INTERNAL_URL } from '../config/index.js';
import { isOperationActive, getBootFailure, isCurrentOperationOwner, getOperationSignal } from './operations.js';
import { log } from '../utils/log.js';

export function adminProxyToken(req) {
  if (usesIndependentAuthentication(req.url) || !isAdminOriginAllowed(req)) return null;
  if (req.headers.authorization) {
    const headerOnly = { ...req, headers: { ...req.headers, cookie: undefined } };
    if (!isAdminAuthenticated(headerOnly)) return null; // Preserve independent Gateway credentials.
  }
  return isAdminAuthenticated(req) ? OPENCLAW_GATEWAY_TOKEN : null;
}

class GatewayManager extends EventEmitter {
  constructor() {
    super();
    this._core = null;
    this._logs = [];
    this._sockets = new Set();
    this._state = 'stopped';
    this._beforeStart = async () => {};
    this._canary = false;
    this._env = { ...process.env };
    this._httpProxy = httpProxy.createProxyServer({ target: GATEWAY_INTERNAL_URL,
      changeOrigin: true, xfwd: false, proxyTimeout: 120000, timeout: 120000 });
    this._httpProxy.on('proxyReq', (outgoing, req) => {
      applyProxyPolicy(outgoing, req, adminProxyToken(req));
      outgoing.removeHeader('x-admin-token');
      const cookie = String(req.headers.cookie || '').split(';').filter((part) => !part.trim().startsWith('ocw_admin=')).join(';');
      if (cookie) outgoing.setHeader('cookie', cookie); else outgoing.removeHeader('cookie');
      if (req.rawBody) {
        outgoing.setHeader('Content-Length', req.rawBody.length);
        outgoing.removeHeader('transfer-encoding');
        outgoing.write(req.rawBody);
      }
    });
    this._httpProxy.on('error', (_error, _req, res) => {
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway not reachable' }));
      } else res?.destroy?.();
    });
  }
  setPreflight(action) { this._beforeStart = action; }
  setCanary(enabled) {
    this._canary = enabled;
    for (const key of ['OPENCLAW_SKIP_CHANNELS','OPENCLAW_SKIP_PROVIDERS','OPENCLAW_SKIP_CRON','OPENCLAW_SKIP_GMAIL_WATCHER',
      'OPENCLAW_SKIP_CANVAS_HOST','OPENCLAW_SKIP_BROWSER_CONTROL_SERVER','OPENCLAW_SKIP_STARTUP_MODEL_PREWARM']) {
      if (enabled) this._env[key] = '1';
      else if (process.env[key] === undefined) delete this._env[key];
      else this._env[key] = process.env[key];
    }
    this._env.OPENCLAW_NO_AUTO_UPDATE = '1';
  }
  _initialize() {
    if (this._core) return;
    this._core = createGatewayManager({
      entry: OPENCLAW_ENTRY, node: OPENCLAW_NODE, stateDir: OPENCLAW_STATE_DIR,
      workspaceDir: WORKSPACE_DIR, token: OPENCLAW_GATEWAY_TOKEN, host: GATEWAY_HOST, port: GATEWAY_PORT,
      env: this._env, startupTimeoutMs: 180000, preflightTimeoutMs: 600000,
      isConfigured: () => config.isAlreadyConfiguredSync() && (!getBootFailure() || isCurrentOperationOwner()),
      getExtraGatewayArgs: () => this._canary ? ['--update-canary'] : [],
      beforeStart: (context) => this._beforeStart(context),
      stdio: ['ignore', 'pipe', 'pipe'],
      log: (level, message) => {
        this._appendLog(level, message);
        if (message.startsWith('exited ')) this._setState('crashed');
        if (message.startsWith('starting foreground')) this._setState('starting');
        if (message.startsWith('auto-restart failed')) this._setState('crashed');
      },
      spawn: (command, args, options) => {
        const child = spawn(command, args, options);
        for (const [name, stream] of [['stdout',child.stdout], ['stderr',child.stderr]]) {
          let pending = '';
          const filter = createOutputFilter([OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD], (chunk) => {
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            for (const line of lines) if (line) this._appendLog(name, line);
          });
          stream?.setEncoding('utf8');
          stream?.on('data', (chunk) => filter.write(chunk));
          stream?.on('end', () => { filter.end(); if (pending) this._appendLog(name, pending); });
        }
        return child;
      },
    });
  }
  _appendLog(stream, line) {
    const entry = { ts: new Date().toISOString(), stream, line: String(line) };
    this._logs.push(entry);
    if (this._logs.length > 500) this._logs.shift();
    this.emit('log', entry);
    log[stream === 'stderr' || stream === 'error' ? 'error' : stream === 'warn' ? 'warn' : 'info'](entry.line);
  }
  _setState(state) { if (this._state !== state) { this._state = state; this.emit('stateChange', state); } }
  isRunning() { return this._core?.isReady() || false; }
  getState() {
    if (this._core?.isReady()) this._setState('running');
    else if (this._core?.isStarting()) this._setState('starting');
    else if (this._state === 'running') this._setState('stopped');
    return this._state;
  }
  getLogs(lines = 100) { return this._logs.slice(-lines); }
  getHttpProxy() { return this._httpProxy; }
  async start({ signal = getOperationSignal() } = {}) {
    this._initialize();
    signal?.throwIfAborted();
    let stopping;
    const abort = () => { stopping = this._core.stop(); stopping.catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    this._setState('starting');
    try {
      const result = await this._core.start();
      signal?.throwIfAborted();
      if (!result?.ok || !this._core.isReady()) throw new Error('Gateway did not become ready');
      this._setState('running');
      return result;
    } catch (error) { this._setState('crashed'); throw error; }
    finally { signal?.removeEventListener('abort', abort); if (stopping) await stopping; }
  }
  async stop(options = {}) {
    for (const socket of this._sockets) socket.destroy();
    if (this._core) await this._core.stop(options);
    else await assertGatewayAbsent();
    this._setState('stopped');
  }
  async restart({ signal = getOperationSignal() } = {}) {
    this._initialize();
    signal?.throwIfAborted();
    let stopping;
    const abort = () => { stopping = this._core.stop(); stopping.catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    this._setState('starting');
    try {
      const result = await this._core.restart();
      signal?.throwIfAborted();
      if (!result?.ok || !this._core.isReady()) throw new Error('Gateway restart did not become ready');
      this._setState('running');
      return result;
    } catch (error) { this._setState('crashed'); throw error; }
    finally { signal?.removeEventListener('abort', abort); if (stopping) await stopping; }
  }
  async shutdown() { await this.stop({ shutdown: true }); this._httpProxy.close(); }
  handleWsUpgrade(req, socket, head) {
    const unavailable = () => !this.isRunning() || isOperationActive() || Boolean(getBootFailure());
    if (unavailable()) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(GATEWAY_PORT, GATEWAY_HOST);
    upstream.setTimeout(10000, () => upstream.destroy());
    this._sockets.add(upstream);
    upstream.once('connect', () => {
      if (unavailable()) { upstream.destroy(); socket.destroy(); return; }
      upstream.setTimeout(0);
      const headers = new Map();
      for (let i=0;i<req.rawHeaders.length;i+=2) headers.set(req.rawHeaders[i].toLowerCase(),req.rawHeaders[i+1]);
      headers.set('host', `${GATEWAY_HOST}:${GATEWAY_PORT}`);
      const outgoing = { getHeaderNames: () => [...headers.keys()], setHeader: (k,v) => headers.set(k.toLowerCase(),v),
        removeHeader: (k) => headers.delete(k.toLowerCase()) };
      applyProxyPolicy(outgoing, req, adminProxyToken(req));
      headers.delete('x-admin-token');
      const cookie = String(headers.get('cookie') || '').split(';').filter((part) => !part.trim().startsWith('ocw_admin=')).join(';');
      if (cookie) headers.set('cookie',cookie); else headers.delete('cookie');
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [key,value] of headers) raw += `${key}: ${value}\r\n`;
      upstream.write(raw + '\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => { this._sockets.delete(upstream); socket.destroy(); });
  }
}
export function assertGatewayAbsent() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(GATEWAY_PORT, GATEWAY_HOST);
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('A Gateway is still listening; stop its owner before modifying persistent data')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot confirm Gateway has stopped')); });
    socket.once('error', (error) => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
  });
}
export const gatewayManager = new GatewayManager();
