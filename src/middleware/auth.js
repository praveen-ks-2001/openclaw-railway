/**
 * middleware/auth.js
 *
 * Optional password protection for the wrapper's /api and /setup routes.
 *
 * If WRAPPER_ADMIN_PASSWORD is set, requests must include:
 *   Authorization: Bearer <password>
 * or a cookie:
 *   x-admin-token: <password>
 *
 * If not set, all requests are allowed (suitable for Railway private deployments).
 */

import { WRAPPER_ADMIN_PASSWORD } from '../config/index.js';

export function requireAdminAuth(req, res, next) {
  // If no password configured, allow all
  if (!WRAPPER_ADMIN_PASSWORD) return next();

  const authHeader = req.headers['authorization'] || '';
  const cookieToken = req.headers['x-admin-token'] || '';

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : cookieToken.trim();

  if (token === WRAPPER_ADMIN_PASSWORD) return next();

  res.status(401).json({ ok: false, error: 'Unauthorized. Set WRAPPER_ADMIN_PASSWORD.' });
}
