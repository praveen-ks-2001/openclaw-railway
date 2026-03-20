/**
 * services/gatewayManager.js
 *
 * Manages the lifecycle of the openclaw gateway child process.
 *
 * Design principles:
 *  - Single source of truth for gateway state
 *  - Emits events so any part of the app can react (SSE, WS, logs)
 *  - Auto-restarts on crash with exponential backoff
 *  - Exposes WS proxy attachment for the HTTP server
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import httpProxy from 'http-proxy';
import { WebSocketServer } from 'ws';
import net from 'net';
import {
  GATEWAY_PORT,
  GATEWAY_HOST,
  GATEWAY_INTERNAL_URL,
  OPENCLAW_HOME,
  OPENCLAW_STATE_DIR,
  DATA_DIR,
} from '../config/index.js';
import { log } from '../utils/log.js';

// How long to wait before checking if gateway TCP port is open
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 60_000;

// Restart backoff: 2s, 4s, 8s, 16s, 30s max
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30_000;

class GatewayManager extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
    this._state = 'stopped'; // stopped | starting | running | crashed
    this._restartCount = 0;
    this._restartTimer = null;
    this._logs = []; // rolling last 500 lines
    this._wsProxy = null;
    this._httpProxy = httpProxy.createProxyServer({
      target: GATEWAY_INTERNAL_URL,
      ws: true,
      changeOrigin: false,
    });

    this._httpProxy.on('error', (err, req, res) => {
      if (res && !res.headersSent) {
        res.status(502).json({ error: 'Gateway not reachable', detail: err.message });
      }
    });
  }

  // ─── Public API ────────────────────────────────────────────────

  isRunning() {
    return this._state === 'running';
  }

  getState() {
    return this._state;
  }

  getLogs(lines = 100) {
    return this._logs.slice(-lines);
  }

  async start() {
    if (this._state === 'running' || this._state === 'starting') {
      log.warn('Gateway already running or starting — ignoring start()');
      return;
    }

    this._setState('starting');
    this._restartCount = 0;
    this._spawnProcess();

    // Wait for the gateway TCP port to be accepting connections
    try {
      await this._waitForReady();
      this._setState('running');
      log.info('✅ OpenClaw gateway is ready');
    } catch (err) {
      log.error('Gateway failed to become ready:', err.message);
      this._setState('crashed');
    }
  }

  async stop() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._proc) {
      this._proc.kill('SIGTERM');
      this._proc = null;
    }
    this._setState('stopped');
  }

  async restart() {
    log.info('Restarting OpenClaw gateway...');
    await this.stop();
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  /**
   * Called from server.js — attaches WebSocket proxy so the wrapper's
   * HTTP server can forward WS connections to openclaw's gateway port.
   * This covers both the Control UI websocket AND the webchat websocket.
   */
  attachWebSocketProxy(httpServer) {
    // Proxy upgrade events (standard WS over HTTP/1.1)
    // IMPORTANT: Only proxy /ui/* upgrades — leave /ws/* for their own WSS instances
    httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url || '';

      // /ws/* paths are handled by their own WebSocketServer instances (e.g. /ws/terminal)
      // Do NOT intercept them here — let them reach their own WSS
      if (url.startsWith('/ws/')) {
        return;
      }

      // Only proxy if we're actually running
      if (!this.isRunning()) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      // Strip /ui prefix before forwarding to openclaw's internal port
      // e.g. /ui/something → /something, /ui → /
      req.url = url.replace(/^\/ui/, '') || '/';

      // Set the host header to the internal gateway so openclaw accepts the connection
      req.headers.host = `${GATEWAY_HOST}:${GATEWAY_PORT}`;

      this._httpProxy.ws(req, socket, head, { target: GATEWAY_WS_URL }, (err) => {
        if (err) {
          log.warn(`WS proxy error for ${url}: ${err.message}`);
          socket.destroy();
        }
      });
    });

    // Log proxy-level WS errors so they're visible in /admin logs
    this._httpProxy.on('proxyReqWs', (proxyReq, req) => {
      log.info(`WS proxying: ${req.url} → ${GATEWAY_WS_URL}`);
    });
  }

  /**
   * Returns the underlying http-proxy instance for use in the proxy middleware.
   */
  getHttpProxy() {
    return this._httpProxy;
  }

  // ─── Private ───────────────────────────────────────────────────

  _spawnProcess() {
    log.info('Spawning openclaw gateway process...');

    const env = {
      ...process.env,
      HOME: DATA_DIR,                      // openclaw writes ~/.openclaw → /data/.openclaw
      OPENCLAW_STATE_DIR: OPENCLAW_STATE_DIR,
      // Bind gateway to loopback — our wrapper is the public face
      OPENCLAW_GATEWAY_BIND: 'loopback',
    };

    // openclaw gateway --port 18789 --bind loopback
    this._proc = spawn(
      'openclaw',
      ['gateway', '--port', String(GATEWAY_PORT), '--bind', 'loopback'],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );

    this._proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      lines.forEach((line) => this._appendLog('stdout', line));
    });

    this._proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      lines.forEach((line) => this._appendLog('stderr', line));
    });

    this._proc.on('exit', (code, signal) => {
      log.warn(`Gateway process exited (code=${code}, signal=${signal})`);
      this._proc = null;

      if (this._state !== 'stopped') {
        this._setState('crashed');
        this._scheduleRestart();
      }
    });

    this._proc.on('error', (err) => {
      log.error('Failed to spawn openclaw:', err.message);
      this._setState('crashed');
      this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this._restartCount),
      BACKOFF_MAX_MS
    );
    this._restartCount += 1;
    log.info(`Scheduling gateway restart in ${delay}ms (attempt #${this._restartCount})`);

    this._restartTimer = setTimeout(async () => {
      this._restartTimer = null;
      this._spawnProcess();
      try {
        await this._waitForReady();
        this._setState('running');
        log.info('✅ Gateway recovered after restart');
      } catch {
        log.error('Gateway failed to recover — will retry');
        this._scheduleRestart();
      }
    }, delay);
  }

  _waitForReady() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + READY_TIMEOUT_MS;

      const poll = () => {
        if (Date.now() > deadline) {
          return reject(new Error(`Gateway not ready after ${READY_TIMEOUT_MS}ms`));
        }

        const socket = new net.Socket();
        socket.setTimeout(READY_POLL_INTERVAL_MS);

        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });

        socket.on('error', () => {
          socket.destroy();
          setTimeout(poll, READY_POLL_INTERVAL_MS);
        });

        socket.on('timeout', () => {
          socket.destroy();
          setTimeout(poll, READY_POLL_INTERVAL_MS);
        });

        socket.connect(GATEWAY_PORT, GATEWAY_HOST);
      };

      poll();
    });
  }

  _appendLog(stream, line) {
    const entry = { ts: new Date().toISOString(), stream, line };
    this._logs.push(entry);
    if (this._logs.length > 500) this._logs.shift();
    this.emit('log', entry);
  }

  _setState(state) {
    this._state = state;
    this.emit('stateChange', state);
    log.info(`Gateway state → ${state}`);
  }
}

// Singleton
export const gatewayManager = new GatewayManager();