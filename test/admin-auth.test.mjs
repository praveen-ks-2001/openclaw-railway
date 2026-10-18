import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
process.env.WRAPPER_ADMIN_PASSWORD = 'synthetic-password-"; cookie-safe';
const auth = await import('../src/middleware/auth.js');
const req = (headers = {}, method = 'POST') => ({ headers: { host: 'deployment.example', ...headers }, method, originalUrl: '/admin' });
const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, redirect(url) { this.redirected = url; return this; }, setHeader(name, value) { this.headers[name] = value; } });
const bearer = { authorization: `Bearer ${process.env.WRAPPER_ADMIN_PASSWORD}` };
function cookie() { const res = response(); auth.setAuthCookie(res, process.env.WRAPPER_ADMIN_PASSWORD); return res.headers['Set-Cookie'].split(';')[0]; }

test('admin cookie contains a signed value, never the password, and survives fresh processes', () => {
  const res = response(); auth.setAuthCookie(res, process.env.WRAPPER_ADMIN_PASSWORD, req({ 'x-forwarded-proto': 'https' }));
  const value = res.headers['Set-Cookie'];
  assert.ok(!value.includes(process.env.WRAPPER_ADMIN_PASSWORD));
  assert.match(value, /HttpOnly; SameSite=Strict; Secure$/);
  assert.equal(auth.isAdminAuthenticated(req({ cookie: value })), true);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `import {isAdminAuthenticated} from './src/middleware/auth.js'; process.stdout.write(String(isAdminAuthenticated({headers:{cookie:process.env.TEST_COOKIE}})));`], { env: { ...process.env, TEST_COOKIE: value }, encoding: 'utf8' });
  assert.equal(result, 'true');
});

test('malformed cookies and legacy raw-password cookies do not authorize or throw', () => {
  for (const value of ['ocw_admin=%ZZ', 'ocw_admin=%E0%A4%A', `ocw_admin=${encodeURIComponent(process.env.WRAPPER_ADMIN_PASSWORD)}`, cookie() + '; ' + cookie(), 'constructor=x']) assert.equal(auth.isAdminAuthenticated(req({ cookie: value })), false);
});

test('cookie mutations require matching Origin; explicit foreign Origin rejects admin headers too', () => {
  for (const origin of [undefined, 'null', 'https://evil.example', 'https://deployment.example.evil', 'https://deployment.example/path']) {
    const res = response(); let called = false;
    auth.requireAdminAuth(req({ cookie: cookie(), ...(origin ? { origin } : {}) }), res, () => { called = true; });
    assert.equal(called, false); assert.equal(res.code, 403);
  }
  const res = response(); let called = false;
  auth.requireAdminAuth(req({ cookie: cookie(), origin: 'https://deployment.example' }), res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(auth.isAdminOriginAllowed(req({ ...bearer, origin: 'https://evil.example' })), false);
});

test('explicit header clients may act without Origin; browser GET accepts a signed cookie', () => {
  for (const headers of [bearer, { 'x-admin-token': process.env.WRAPPER_ADMIN_PASSWORD }]) {
    let called = false; auth.requireAdminAuth(req(headers), response(), () => { called = true; }); assert.equal(called, true);
  }
  let called = false; auth.requireAdminAuth(req({ cookie: cookie() }, 'GET'), response(), () => { called = true; }); assert.equal(called, true);
});

test('anonymous API receives JSON401 and navigation returns only to a local path', () => {
  const res = response(); auth.requireAdminAuth(req({}, 'GET'), res, () => assert.fail()); assert.equal(res.code, 401);
  const browser = response(); auth.requireAdminAuth(req({ accept: 'text/html' }, 'GET'), browser, () => assert.fail()); assert.equal(browser.redirected, '/login?returnTo=%2Fadmin');
  for (const target of ['//evil.example', 'https://evil.example', '/\\evil.example', '/admin\nX: x', ['//evil.example']]) assert.equal(auth.sanitizeReturnTo(target), '/admin');
  assert.equal(auth.sanitizeReturnTo('/setup?done=1'), '/setup?done=1');
});

test('missing configured password denies privileged access with actionable503', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `import {requireAdminAuth} from './src/middleware/auth.js'; const r={status(c){this.code=c;return this},json(b){process.stdout.write(JSON.stringify({code:this.code,...b}))}}; requireAdminAuth({headers:{}},r,()=>process.stdout.write('WRONGLY_ALLOWED'));`], { env: { ...process.env, WRAPPER_ADMIN_PASSWORD: '' }, encoding: 'utf8' });
  const body = JSON.parse(result); assert.equal(body.code, 503); assert.match(body.error, /WRAPPER_ADMIN_PASSWORD/);
});
