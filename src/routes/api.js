/**
 * routes/api.js
 *
 * Internal API endpoints used by the admin UI panels.
 *
 * GET  /api/status          — gateway state + uptime
 * GET  /api/logs            — last N log lines
 * GET  /api/logs/stream     — SSE live log stream
 * GET  /api/events          — SSE gateway state events
 * POST /api/gateway/restart — restart the gateway process
 * POST /api/gateway/stop    — stop the gateway
 * GET  /api/config          — read current openclaw.json
 * POST /api/config          — write updated openclaw.json (triggers hot reload)
 * GET  /api/pairing/pending — list pending device pair requests
 * POST /api/pairing/approve — approve a pending pair request
 * POST /api/pairing/reject  — reject a pending pair request
 * GET  /api/pairing/paired  — list currently paired devices
 * GET  /api/setup-ui        — serves the inline setup HTML (fallback)
 */

import { Router } from 'express';
import { config } from '../config/index.js';
import { OPENCLAW_GATEWAY_TOKEN } from '../config/index.js';
import { gatewayManager } from '../services/gatewayManager.js';
import { pairingService } from '../services/pairingService.js';
import { getActiveSessionCount, stopAllTerminalSessions } from '../services/terminalService.js';
import { getVersionInfo } from '../utils/version.js';
import { requireAdminAuth } from '../middleware/auth.js';
import { readEditableConfig, updateEditableConfig } from '../services/configEditor.js';
import { withExclusiveOperation, getOperationState, getBootFailure } from '../services/operations.js';

export const apiRoutes = Router();

const WRAPPER_API_PATHS = new Set([
  '/status', '/admin/status', '/logs', '/logs/stream', '/events',
  '/gateway/restart', '/gateway/stop', '/config',
  '/pairing/pending', '/pairing/paired', '/pairing/approve',
  '/pairing/reject', '/pairing/revoke', '/pairing/stream', '/setup-ui',
]);

/** Paths relative to /api. Match Express's default case/trailing-slash policy. */
export function isWrapperApiPath(pathname) {
  return typeof pathname === 'string' && WRAPPER_API_PATHS.has(pathname.replace(/\/$/, '').toLowerCase());
}

// OpenClaw owns additional /api routes, including bearer/capability downloads.
// Leave their authentication, credentials, response headers and payloads alone.
apiRoutes.use((req, _res, next) => {
  if (!isWrapperApiPath(req.path)) return next('router');
  next();
});

// ── Public endpoints (no auth) — needed for Railway healthcheck ───
// These must be registered BEFORE the requireAdminAuth middleware.

async function statusDetails(privileged = false) {
  let cfg = null;
  try { cfg = await config.readConfig(); } catch { /* status and recovery remain available for invalid config */ }
  const result = {
    state: gatewayManager.getState(),
    running: gatewayManager.isRunning(),
    configured: Boolean(cfg) && await config.isAlreadyConfigured(),
    uptime: process.uptime(),
    version: getVersionInfo(),
    ts: new Date().toISOString(),
  };
  if (privileged) {
    const savedToken = cfg?.gateway?.auth?.token;
    result.gatewayToken = OPENCLAW_GATEWAY_TOKEN || (typeof savedToken === 'string' ? savedToken : null);
    result.aiProvider = cfg?.agents?.defaults?.model?.primary || null;
    result.terminalSessions = getActiveSessionCount();
    result.operation = getOperationState();
    result.bootFailure = getBootFailure();
  }
  return result;
}

apiRoutes.get('/status', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const details = await statusDetails();
    res.status(getBootFailure() || (details.configured && !details.running) ? 503 : 200).json(details);
  } catch (error) { next(error); }
});

// Only the wrapper management endpoints below require wrapper admin auth.
apiRoutes.use(requireAdminAuth);
apiRoutes.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
apiRoutes.get('/admin/status', async (req, res, next) => {
  try { res.json(await statusDetails(true)); } catch (error) { next(error); }
});

function errorResponse(res, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  return res.status(status).json({ ok: false, error: error.message || 'The operation failed.' });
}

// ── Logs ──────────────────────────────────────────────────────────

apiRoutes.get('/logs', (req, res) => {
  const n = Math.max(1, Math.min(parseInt(req.query.lines || '100', 10) || 100, 500));
  res.json({ logs: gatewayManager.getLogs(n) });
});

/**
 * SSE: live log stream
 * Client receives newline-delimited JSON: { ts, stream, line }
 */
apiRoutes.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send recent history first
  const recent = gatewayManager.getLogs(50);
  recent.forEach((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  const handler = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  gatewayManager.on('log', handler);

  req.on('close', () => {
    gatewayManager.off('log', handler);
  });
});

/**
 * SSE: gateway state changes
 * Client receives: { state: 'running'|'starting'|'crashed'|'stopped' }
 */
apiRoutes.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ state: gatewayManager.getState() })}\n\n`);

  const handler = (state) => {
    res.write(`data: ${JSON.stringify({ state })}\n\n`);
  };

  gatewayManager.on('stateChange', handler);

  req.on('close', () => {
    gatewayManager.off('stateChange', handler);
  });
});

// ── Gateway control ──────────────────────────────────────────────

apiRoutes.post('/gateway/restart', async (req, res) => {
  try {
    await withExclusiveOperation('restart-gateway', async () => { await stopAllTerminalSessions(); await gatewayManager.restart(); });
    res.json({ ok: true, message: 'Gateway restarted and startup verified.' });
  } catch (err) {
    errorResponse(res, err);
  }
});

apiRoutes.post('/gateway/stop', async (req, res) => {
  try {
    await withExclusiveOperation('stop-gateway', async () => { await stopAllTerminalSessions(); await gatewayManager.stop(); });
    res.json({ ok: true, message: 'Gateway stopped.' });
  } catch (err) {
    errorResponse(res, err);
  }
});

// ── Config ────────────────────────────────────────────────────────

apiRoutes.get('/config', async (req, res) => {
  try { res.json({ ok: true, ...await readEditableConfig() }); } catch (error) { errorResponse(res, error); }
});

apiRoutes.post('/config', async (req, res) => {
  try {
    const result = await updateEditableConfig(req.body?.config, req.body?.revision);
    res.json({ ok: true, ...result });
  } catch (error) { errorResponse(res, error); }
});

// ── Device Pairing ────────────────────────────────────────────────

/**
 * List pending pairing requests
 * Uses the public SDK in an isolated worker; no legacy file fallback.
 */
apiRoutes.get('/pairing/pending', async (req, res) => {
  try {
    const pending = await pairingService.getPending();
    res.json({ ok: true, pending });
  } catch (err) {
    errorResponse(res, err);
  }
});

/**
 * Approve a pending pair request
 * Calls: openclaw devices approve <requestId>
 */
apiRoutes.post('/pairing/approve', async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ ok: false, error: 'requestId required' });
  }
  try {
    await pairingService.approve(requestId);
    res.json({ ok: true, message: `Request ${requestId} approved` });
  } catch (err) {
    errorResponse(res, err);
  }
});

/**
 * Reject a pending pair request
 */
apiRoutes.post('/pairing/reject', async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ ok: false, error: 'requestId required' });
  }
  try {
    await pairingService.reject(requestId);
    res.json({ ok: true, message: `Request ${requestId} rejected` });
  } catch (err) {
    errorResponse(res, err);
  }
});

/**
 * Revoke a paired device token
 */
apiRoutes.post('/pairing/revoke', async (req, res) => {
  const { deviceId, role } = req.body || {};
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: 'deviceId required' });
  }
  try {
    await pairingService.revoke(deviceId, role);
    res.json({ ok: true, message: `Device ${deviceId} revoked` });
  } catch (err) {
    errorResponse(res, err);
  }
});

/**
 * List currently paired devices
 */
apiRoutes.get('/pairing/paired', async (req, res) => {
  try {
    const paired = await pairingService.getPaired();
    res.json({ ok: true, paired });
  } catch (err) {
    errorResponse(res, err);
  }
});

// ── Setup UI (inline fallback) ─────────────────────────────────────

apiRoutes.get('/setup-ui', (req, res) => {
  // Redirect to the main setup page
  res.redirect('/setup');
});
