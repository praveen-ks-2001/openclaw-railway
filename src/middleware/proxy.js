/**
 * middleware/proxy.js
 *
 * Reverse proxies /ui/* → http://127.0.0.1:18789/*
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

  // Strip the /ui prefix before forwarding
  req.url = req.url.replace(/^\/ui/, '') || '/';

  const proxy = gatewayManager.getHttpProxy();
  proxy.web(req, res, { target: GATEWAY_INTERNAL_URL });
}
