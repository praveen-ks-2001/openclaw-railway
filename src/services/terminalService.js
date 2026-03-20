/**
 * services/terminalService.js
 *
 * Manages PTY (pseudo-terminal) sessions for the web terminal panel.
 *
 * One PTY per WebSocket connection. When the WS closes, the PTY is killed.
 * The shell is pre-loaded with the correct HOME and OPENCLAW env vars so
 * that `openclaw doctor`, `openclaw models status`, etc. all work correctly.
 *
 * Protocol (binary-safe, text frames):
 *   Client → Server:
 *     { type: 'input', data: '<keystrokes>' }
 *     { type: 'resize', cols: N, rows: N }
 *
 *   Server → Client:
 *     { type: 'output', data: '<terminal output>' }
 *     { type: 'exit',   code: N }
 */

import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { DATA_DIR, OPENCLAW_HOME, OPENCLAW_STATE_DIR } from '../config/index.js';
import { log } from '../utils/log.js';

// Maximum simultaneous PTY sessions (guard against resource exhaustion)
const MAX_SESSIONS = 5;

// Active sessions: Map<wsId, { ptyProc, ws }>
const sessions = new Map();
let sessionCounter = 0;

/**
 * Creates a WebSocket server for terminal connections.
 * Uses noServer mode — the caller (server.js) must route upgrade
 * requests to terminalWss.handleUpgrade() manually.
 *
 * IMPORTANT: We must NOT use { server: httpServer } because the ws
 * library auto-registers an upgrade handler that calls abortHandshake(400)
 * for non-matching paths, which destroys the socket before the gateway
 * WS proxy handler can forward it. noServer avoids this.
 */
export const terminalWss = new WebSocketServer({ noServer: true });

export function attachTerminalWebSocket(httpServer) {
  terminalWss.on('connection', (ws, req) => {
    if (sessions.size >= MAX_SESSIONS) {
      ws.send(JSON.stringify({
        type: 'output',
        data: '\r\n\x1b[31m[Too many terminal sessions open. Close another tab and try again.]\x1b[0m\r\n',
      }));
      ws.close(1013, 'Too many sessions');
      return;
    }

    const sessionId = ++sessionCounter;
    log.info(`Terminal WS connected (session #${sessionId})`);

    // ── Spawn the PTY ─────────────────────────────────────────────
    const shell = process.env.SHELL || '/bin/bash';

    const env = {
      ...process.env,
      HOME:               DATA_DIR,
      OPENCLAW_STATE_DIR: OPENCLAW_STATE_DIR,
      TERM:               'xterm-256color',
      COLORTERM:          'truecolor',
      // Make sure openclaw CLI can find the config
      OPENCLAW_CONFIG:    `${OPENCLAW_HOME}/openclaw.json`,
    };

    let ptyProc;
    try {
      ptyProc = pty.spawn(shell, [], {
        name:  'xterm-256color',
        cols:  80,
        rows:  24,
        cwd:   DATA_DIR,
        env,
      });
    } catch (err) {
      log.error('Failed to spawn PTY:', err.message);
      ws.send(JSON.stringify({
        type: 'output',
        data: `\r\n\x1b[31m[Failed to start terminal: ${err.message}]\x1b[0m\r\n`,
      }));
      ws.close();
      return;
    }

    // Print a welcome banner with openclaw-specific hints
    ptyProc.write(`echo -e "\\e[36m🦞 OpenClaw Terminal — type 'openclaw --help' to get started\\e[0m"\r`);

    sessions.set(sessionId, { ptyProc, ws });

    // ── PTY → WS ──────────────────────────────────────────────────
    ptyProc.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      log.info(`Terminal session #${sessionId} exited (code=${exitCode})`);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        ws.close();
      }
      sessions.delete(sessionId);
    });

    // ── WS → PTY ──────────────────────────────────────────────────
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        // Ignore malformed frames
        return;
      }

      switch (msg.type) {
        case 'input':
          if (typeof msg.data === 'string') {
            ptyProc.write(msg.data);
          }
          break;

        case 'resize':
          if (
            typeof msg.cols === 'number' &&
            typeof msg.rows === 'number' &&
            msg.cols > 0 && msg.rows > 0 &&
            msg.cols <= 500 && msg.rows <= 200
          ) {
            ptyProc.resize(msg.cols, msg.rows);
          }
          break;

        default:
          log.debug('Terminal: unknown message type:', msg.type);
      }
    });

    // ── WS close — kill PTY ───────────────────────────────────────
    ws.on('close', () => {
      log.info(`Terminal WS closed (session #${sessionId})`);
      if (sessions.has(sessionId)) {
        try {
          ptyProc.kill();
        } catch { /* already dead */ }
        sessions.delete(sessionId);
      }
    });

    ws.on('error', (err) => {
      log.warn(`Terminal WS error (session #${sessionId}):`, err.message);
      try { ptyProc.kill(); } catch { /* ignore */ }
      sessions.delete(sessionId);
    });
  });

  terminalWss.on('error', (err) => {
    log.error('Terminal WebSocket server error:', err.message);
  });

  log.info('Terminal WebSocket server attached at /ws/terminal');
}

/**
 * Returns how many active PTY sessions exist.
 */
export function getActiveSessionCount() {
  return sessions.size;
}
