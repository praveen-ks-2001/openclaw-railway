/** Admin authentication is separate from OpenClaw's Gateway credentials. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WRAPPER_ADMIN_PASSWORD } from '../config/index.js';

const COOKIE_NAME = 'ocw_admin';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === 'string' ? value : '';
}

export function passwordsEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

function cookieValue(password) {
  return createHmac('sha256', password).update('openclaw-railway/admin-cookie/v1').digest('base64url');
}

function cookies(req) {
  const result = Object.create(null);
  for (const part of header(req, 'cookie').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (Object.hasOwn(result, key)) { result[key] = ''; continue; }
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { result[key] = ''; }
  }
  return result;
}

function authMethod(req) {
  if (!WRAPPER_ADMIN_PASSWORD) return null;
  const authorization = header(req, 'authorization');
  if (/^Bearer /i.test(authorization) && passwordsEqual(authorization.slice(7).trim(), WRAPPER_ADMIN_PASSWORD)) return 'header';
  if (passwordsEqual(header(req, 'x-admin-token').trim(), WRAPPER_ADMIN_PASSWORD)) return 'header';
  if (passwordsEqual(cookies(req)[COOKIE_NAME], cookieValue(WRAPPER_ADMIN_PASSWORD))) return 'cookie';
  return null;
}

export function isAdminAuthenticated(req) { return authMethod(req) !== null; }

/** No forwarded host is trusted: the browser must be operating this exact host. */
export function isAdminOriginAllowed(req) {
  const origin = header(req, 'origin');
  if (!origin) return authMethod(req) === 'header';
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    const host = header(req, 'host');
    return Boolean(host) && parsed.host.toLowerCase() === host.toLowerCase();
  } catch { return false; }
}

export function sanitizeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n\u0000]/.test(value)) return '/admin';
  try {
    const parsed = new URL(value, 'http://wrapper.invalid');
    return parsed.origin === 'http://wrapper.invalid' ? parsed.pathname + parsed.search + parsed.hash : '/admin';
  } catch { return '/admin'; }
}

export function requireAdminAuth(req, res, next) {
  if (!WRAPPER_ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'Set WRAPPER_ADMIN_PASSWORD in your Railway service variables, then redeploy to enable setup and administration.' });
  }
  const method = authMethod(req);
  if (method) {
    if ((!SAFE_METHODS.has(req.method) || header(req, 'origin')) && !isAdminOriginAllowed(req)) {
      return res.status(403).json({ ok: false, error: 'Administration requires a same-origin browser request. Reload this deployment and try again.' });
    }
    return next();
  }
  const browserNavigation = SAFE_METHODS.has(req.method) && !header(req, 'authorization') && !header(req, 'x-admin-token') && (req.headers?.['sec-fetch-mode'] === 'navigate' || String(req.headers?.accept || '').includes('text/html'));
  if (browserNavigation) return res.redirect(`/login?returnTo=${encodeURIComponent(sanitizeReturnTo(req.originalUrl))}`);
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function secureSuffix(req) {
  return req?.secure || header(req || {}, 'x-forwarded-proto').split(',')[0].trim() === 'https' ? '; Secure' : '';
}

export function setAuthCookie(res, password, req) {
  if (!passwordsEqual(password, WRAPPER_ADMIN_PASSWORD)) throw new Error('Cannot create an admin session without the configured password.');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${cookieValue(password)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict${secureSuffix(req)}`);
  res.setHeader('Cache-Control', 'no-store');
}

export function clearAuthCookie(res, req) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secureSuffix(req)}`);
  res.setHeader('Cache-Control', 'no-store');
}
