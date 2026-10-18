/**
 * middleware/logger.js
 * Simple request logger.
 */

import { log } from '../utils/log.js';

export function safeRequestPath(value) {
  let pathname;
  try { pathname = new URL(value || '/', 'http://wrapper.invalid').pathname; }
  catch { return '(invalid path)'; }
  // Native downloads and integrations may carry bearer capabilities in paths
  // or query strings. Diagnostics need the route, never the capability.
  for (const prefix of ['/api/artifacts/download', '/hooks', '/j', '/__openclaw__/worker']) {
    if (pathname === prefix || pathname.startsWith(prefix + '/') ||
        (prefix === '/__openclaw__/worker' && pathname.startsWith(prefix + '-')))
      return prefix + '/[redacted]';
  }
  return pathname;
}

export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level](`${req.method} ${safeRequestPath(req.originalUrl)} → ${res.statusCode} (${ms}ms)`);
  });
  next();
}
