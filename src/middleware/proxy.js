/**
 * middleware/proxy.js
 *
 * Reverse proxies /ui/*, /assets/*, /__openclaw/* → http://127.0.0.1:18789/*
 *
 * When mounted at /ui, Express strips the /ui prefix from req.url.
 * We use req.originalUrl and strip only the /ui prefix so the gateway
 * always sees the correct full path.
 *
 * Only active when gateway is running. Returns 503 otherwise.
 */

import { GATEWAY_INTERNAL_URL } from '../config/index.js';
import { gatewayManager } from '../services/gatewayManager.js';

export function proxyMiddleware(req, res, next) {
  if (!gatewayManager.isRunning()) {
    return res.status(503).json({
      error: 'Gateway not running',
      state: gatewayManager.getState(),
    });
  }

  // req.originalUrl has the full path (e.g. /ui/assets/foo.js or /assets/foo.js).
  // Strip the /ui prefix so the gateway receives /assets/foo.js or /foo.js.
  // Paths that don't start with /ui (e.g. /assets/*, /__openclaw/*) pass through as-is.
  req.url = req.originalUrl.replace(/^\/ui/, '') || '/';

  const proxy = gatewayManager.getHttpProxy();
  proxy.web(req, res, { target: GATEWAY_INTERNAL_URL });
}