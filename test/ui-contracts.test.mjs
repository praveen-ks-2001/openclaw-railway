import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const pages = Object.fromEntries(await Promise.all(['setup', 'admin'].map(async name => [
  name, await fs.readFile(new URL(`../public/${name}.html`, import.meta.url), 'utf8'),
])));
const scripts = name => [...pages[name].matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes)).map(([, , body]) => body).join('\n');
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Execute the shipped browser script against its real element IDs and API boundary. */
async function browser(name, handler = () => undefined, { runTimers = false, hidden = false } = {}) {
  const calls = [], timers = [], intervals = [], streams = [], confirmations = [], documentListeners = {}, elements = new Map();
  const markup = pages[name].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const [, id] of markup.matchAll(/\sid="([^"]+)"/g)) {
    assert.ok(!elements.has(id), `Duplicate ${name} element ID: ${id}`);
    const classes = new Set();
    elements.set(id, {
      id, value: '', textContent: '', innerHTML: '', className: '', style: {}, checked: false, disabled: false,
      listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; },
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), toggle: () => {} },
      focus() {},
    });
  }
  const context = vm.createContext({
    console, TextDecoder, Date, JSON, URL,
    document: {
      hidden,
      addEventListener(type, listener) { documentListeners[type] = listener; },
      getElementById(id) { assert.ok(elements.has(id), `Missing ${name} element: ${id}`); return elements.get(id); },
      querySelectorAll: () => [], querySelector: () => null,
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return await handler(url, options) || response({
        state: 'stopped', configured: false, pending: [], paired: [],
        version: { pinned: '2026.10.4', effective: '2026.10.4', source: 'branch' },
      });
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      if (runTimers) queueMicrotask(() => { if (!timer.cleared) callback(); });
      return timers.length;
    },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; }, clearInterval() {},
    EventSource: class {
      constructor(url) { this.url = url; this.closed = false; streams.push(this); }
      close() { this.closed = true; }
    },
    window: { location: { href: '' } }, location: { protocol: 'http:', host: 'localhost' },
    navigator: { clipboard: { writeText: async () => {} } },
    confirm(message) { confirmations.push(message); return true; }, alert() {},
  });
  new vm.Script(scripts(name), { filename: `${name}.html:inline` }).runInContext(context);
  await flush();
  return { context, calls, timers, intervals, streams, confirmations, documentListeners, get: id => elements.get(id) };
}

test('both shipped pages and inline handlers parse, and their declared IDs are unique', async () => {
  for (const name of ['setup', 'admin']) {
    await browser(name);
    for (const [, source] of pages[name].matchAll(/\bon(?:click|change|mouseover|mouseout)="([^"]*)"/g)) {
      new vm.Script(`(function(event) { ${source} })`);
    }
  }
});

test('admin uses protected status and clears the token if its session loses access', async () => {
  let allowed = true;
  const b = await browser('admin', url => url === '/api/admin/status'
    ? allowed ? response({ state: 'running', gatewayToken: 'synthetic-gateway-secret' })
      : response({ error: 'Sign in again at /login.' }, 401) : undefined);
  assert.ok(b.calls.some(call => call.url === '/api/admin/status'));
  assert.ok(!b.calls.some(call => call.url === '/api/status'));
  assert.equal(b.get('token-value').value, 'synthetic-gateway-secret');
  allowed = false;
  await b.context.refreshStatus();
  assert.equal(b.get('token-value').value, '');
  assert.equal(b.get('token-card').style.display, 'none');
  assert.match(b.get('status-label').textContent, /Sign in/);
});

test('config saves round-trip revisions and retain secret placeholders', async () => {
  let revision = 'revision-one';
  const bodies = [];
  const b = await browser('admin', (url, options) => {
    if (url !== '/api/config') return;
    if (!options.method) return response({ config: { auth: { token: '[redacted]' }, label: 'before' }, revision });
    bodies.push(JSON.parse(options.body));
    revision = `revision-${bodies.length + 1}`;
    return response({ ok: true, revision, message: 'Validated and saved.' });
  });
  await b.context.loadConfig();
  const edited = JSON.parse(b.get('config-editor').value);
  edited.label = 'after';
  b.get('config-editor').value = JSON.stringify(edited);
  await b.context.saveConfig();
  await b.context.saveConfig();
  assert.deepEqual(bodies[0], { config: edited, revision: 'revision-one' });
  assert.equal(bodies[1].revision, 'revision-2');
  assert.equal(b.get('config-status').textContent, 'Validated and saved.');
});

test('config cannot be saved without loading a revision or with invalid JSON', async () => {
  const b = await browser('admin', url => url === '/api/config' ? response({ config: {}, revision: 'one' }) : undefined);
  b.get('config-editor').value = '{}';
  await b.context.saveConfig();
  assert.match(b.get('config-status').textContent, /Reload from Disk/);
  await b.context.loadConfig();
  b.get('config-editor').value = '{invalid';
  await b.context.saveConfig();
  assert.match(b.get('toast').textContent, /JSON parse error/);
  assert.equal(b.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('stale config retains the draft and blocks retries until deliberate reload', async () => {
  const b = await browser('admin', (url, options) => url === '/api/config'
    ? options.method ? response({ error: 'Configuration changed. Reload first.' }, 409)
      : response({ config: { label: 'disk' }, revision: 'one' }) : undefined);
  await b.context.loadConfig();
  const draft = '{"label":"my unsaved draft"}';
  b.get('config-editor').value = draft;
  await b.context.saveConfig(true);
  assert.equal(b.get('config-editor').value, draft);
  assert.match(b.get('config-status').textContent, /Your draft is still here/);
  await b.context.saveConfig();
  assert.equal(b.calls.filter(call => call.url === '/api/config' && call.options.method === 'POST').length, 1);
  assert.ok(!b.calls.some(call => call.url.includes('/gateway/')));
});

test('failed config reload preserves the draft and prevents a blind save', async () => {
  const b = await browser('admin', url => url === '/api/config' ? response({ error: 'Recovery required.' }, 503) : undefined);
  b.get('config-editor').value = '{"label":"draft"}';
  await b.context.loadConfig();
  await b.context.saveConfig();
  assert.equal(b.get('config-editor').value, '{"label":"draft"}');
  assert.ok(!b.calls.some(call => call.options.method === 'POST'));
});

test('pending devices display current SDK fields and keep IDs out of executable handlers', async () => {
  const b = await browser('admin');
  const id = `request-'\"<img src=x onerror=alert(1)>`;
  b.context.renderPendingList([{ requestId: id, displayName: '<script>untrusted</script>', roles: ['operator'], createdAtMs: 1 }]);
  const html = b.get('pair-pending-list').innerHTML;
  assert.match(html, /&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.match(html, /data-request-id="request-'&quot;&lt;img/);
  assert.ok(!html.includes('onclick='));
  assert.ok(!html.includes('<img'));
  assert.match(html, /operator/);
});

test('paired devices show SDK names and remove the whole device with its primary role', async () => {
  const b = await browser('admin');
  b.context.renderPairedList([{ deviceId: 'device-one', displayName: 'Browser', roles: ['operator', 'node'], approvedAtMs: 1 }]);
  const html = b.get('pair-paired-list').innerHTML;
  assert.match(html, /Browser/);
  assert.match(html, /operator, node/);
  assert.match(html, /data-device-role="operator"/);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /Remove device/);
  assert.ok(!html.includes('onclick='));
});

test('delegated pairing controls send the original identifier to the API', async () => {
  const b = await browser('admin');
  b.context.initPairing();
  const id = `request-'\"[]`;
  const buttons = [{ disabled: false }, { disabled: false }];
  const button = { disabled: false, dataset: { pairAction: 'approve', requestId: id }, closest: () => ({ querySelectorAll: () => buttons }) };
  b.get('pair-pending-list').listeners.click({ target: { closest: () => button } });
  await flush();
  const call = b.calls.find(call => call.url === '/api/pairing/approve');
  assert.deepEqual(JSON.parse(call.options.body), { requestId: id });
  assert.ok(buttons.every(button => button.disabled));
});

test('failed pairing approval reenables its controls without claiming success', async () => {
  const b = await browser('admin', url => url === '/api/pairing/approve' ? response({ error: 'Request expired.' }, 404) : undefined);
  const buttons = [{ disabled: false }, { disabled: false }];
  await b.context.pairAction('approve', 'request-one', { closest: () => ({ querySelectorAll: () => buttons }) });
  assert.ok(buttons.every(button => !button.disabled));
  assert.match(b.get('toast').textContent, /Failed: Request expired/);
});

test('both version banners explain the branch pin and ignore spoofed legacy selectors', async () => {
  for (const name of ['setup', 'admin']) {
    const b = await browser(name);
    b.context.renderVersionBanner({ pinned: '2026.10.4', effective: '2026.10.4', requested: 'evil-selector', bumped: true });
    assert.match(b.get('version-banner').innerHTML, /This branch runs OpenClaw 2026\.10\.4/);
    assert.match(b.get('version-banner').innerHTML, /variables and build arguments are ignored/);
    assert.ok(!b.get('version-banner').innerHTML.includes('evil-selector'));
    b.context.renderVersionBanner({ pinned: '2026.10.4', effective: '2026.6.6' });
    assert.match(b.get('version-banner').innerHTML, /does not match this branch/);
  }
});

test('setup does not treat a concurrent maintenance conflict as successful setup', async () => {
  const b = await browser('setup', url => url === '/setup/save' ? response({ error: 'Maintenance is already running.' }, 409) : undefined);
  await assert.rejects(b.context.launchApiKey({}, b.get('launch-status'), b.get('error-list'), b.get('error-items')), /Maintenance/);
  assert.ok(!b.get('launch-status').textContent.includes('running!'));
});

test('setup waits for actual readiness and uses only sanitized health status', async () => {
  let checks = 0;
  const b = await browser('setup', url => url === '/api/status' ? response({ state: 'running', ready: ++checks > 2 }) : undefined, { runTimers: true });
  await b.context.pollUntilRunning();
  assert.ok(checks >= 3);
  assert.ok(!b.calls.some(call => call.url === '/api/admin/status'));
});

test('failed reset responses do not redirect or display successful completion', async () => {
  for (const action of ['resetConfig', 'factoryReset']) {
    const b = await browser('admin', url => url === '/setup/reset' ? response({ error: 'Sign in again.' }, 401) : undefined);
    await b.context[action]();
    assert.match(b.get('toast').textContent, /Reset failed: Sign in again/);
    assert.ok(!b.timers.some(timer => timer.delay === 1500));
  }
});

test('factory reset confirmations distinguish active data deletion from retained private recovery snapshots', async () => {
  const b = await browser('admin', url => url === '/setup/reset' ? response({ ok: true }) : undefined);
  await b.context.factoryReset();
  assert.equal(b.confirmations.length, 2);
  assert.match(b.confirmations[0], /PERMANENTLY DELETE the active data owned by this installation/);
  assert.match(b.confirmations[0], /Recovery snapshots.*retained.*credentials/s);
  assert.match(b.confirmations[1], /Active state and its nested workspaces will be wiped/);
  assert.match(b.confirmations[1], /Retained recovery snapshots can still contain prior data and credentials/);
  assert.ok(!b.confirmations.some(message => /DELETE everything|All data will be wiped/.test(message)));
});

test('upgrade recovery appears only for boot failure and blocks retry during maintenance', async () => {
  let status = { state: 'stopped', bootFailure: 'Canary failed. Old state was restored.', operation: { active: true } };
  const b = await browser('admin', url => url === '/api/admin/status' ? response(status) : undefined);
  assert.equal(b.get('upgrade-recovery').style.display, 'block');
  assert.match(b.get('upgrade-recovery-error').textContent, /Old state was restored/);
  assert.equal(b.get('btn-upgrade-retry').disabled, true);
  await b.context.retryUpgrade();
  assert.ok(!b.calls.some(call => call.url === '/api/upgrade/retry'));
  status = { state: 'running', bootFailure: null, operation: { active: false } };
  await b.context.refreshStatus();
  assert.equal(b.get('upgrade-recovery').style.display, 'none');
});

test('explicit upgrade retry sends one request, keeps controls disabled, and refreshes outcome', async () => {
  let finish;
  let failed = true;
  const b = await browser('admin', url => {
    if (url === '/api/admin/status') return response({ state: failed ? 'stopped' : 'running', bootFailure: failed ? 'Upgrade failed.' : null });
    if (url === '/api/upgrade/retry') return new Promise(resolve => { finish = () => { failed = false; resolve(response({ ok: true })); }; });
  });
  const retry = b.context.retryUpgrade();
  await flush();
  await b.context.refreshStatus();
  assert.equal(b.get('btn-upgrade-retry').disabled, true);
  await b.context.retryUpgrade();
  assert.equal(b.calls.filter(call => call.url === '/api/upgrade/retry').length, 1);
  assert.equal(b.calls.find(call => call.url === '/api/upgrade/retry').options.method, 'POST');
  finish();
  await retry;
  assert.equal(b.get('upgrade-recovery').style.display, 'none');
  assert.equal(b.get('btn-upgrade-retry').disabled, false);
});

test('hidden admin pages make no status/device reads or pairing subscription, then resume visible Pairing immediately', async () => {
  const b = await browser('admin', url => url === '/api/pairing/pending' ? response({ pending: [{ requestId: 'one' }] }) : undefined, { hidden: true });
  b.context.navigate('pairing');
  await b.context.refreshStatus();
  await b.context.refreshPairing();
  for (const timer of b.intervals) timer.callback();
  await flush();
  assert.deepEqual(b.calls, []);
  assert.equal(b.streams.filter(stream => stream.url === '/api/pairing/stream').length, 0);
  b.context.document.hidden = false;
  b.documentListeners.visibilitychange();
  await flush();
  assert.equal(b.calls.filter(call => call.url === '/api/admin/status').length, 1);
  assert.equal(b.calls.filter(call => call.url === '/api/pairing/pending').length, 1, 'status must not duplicate the visible Pairing read');
  assert.equal(b.calls.filter(call => call.url === '/api/pairing/paired').length, 1);
  assert.equal(b.streams.filter(stream => stream.url === '/api/pairing/stream' && !stream.closed).length, 1);
  assert.equal(Number(b.get('st-pairs').textContent), 1);
});

test('status hidden while its cheap request is pending does not launch a late device worker', async () => {
  let pause = false, finish;
  const b = await browser('admin', url => url === '/api/admin/status' && pause
    ? new Promise(resolve => { finish = () => resolve(response({ state: 'running' })); }) : undefined);
  const before = b.calls.filter(call => call.url === '/api/pairing/pending').length;
  pause = true;
  const refresh = b.context.refreshStatus();
  b.context.document.hidden = true;
  b.documentListeners.visibilitychange();
  finish();
  await refresh;
  assert.equal(b.calls.filter(call => call.url === '/api/pairing/pending').length, before);
});

test('navigating away closes Pairing SSE and intentional close cannot start a reconnect loop', async () => {
  const b = await browser('admin');
  b.context.navigate('pairing');
  await flush();
  const stream = b.streams.find(stream => stream.url === '/api/pairing/stream');
  const staleError = stream.onerror;
  b.context.navigate('status');
  await flush();
  assert.equal(stream.closed, true);
  assert.equal(stream.onerror, null);
  staleError();
  assert.equal(b.timers.filter(timer => timer.delay === 4000 && !timer.cleared).length, 0);
  assert.equal(b.streams.filter(stream => stream.url === '/api/pairing/stream').length, 1);
  assert.ok(b.calls.filter(call => call.url === '/api/pairing/pending').length >= 2, 'visible Status retains its pairing badge read');
});

test('foreground Pairing SSE updates counts/actions; hiding closes it and returning reopens one subscription', async () => {
  const b = await browser('admin');
  b.context.navigate('pairing');
  await flush();
  const stream = b.streams.find(stream => stream.url === '/api/pairing/stream');
  stream.onmessage({ data: JSON.stringify({ type: 'pending', pending: [{ requestId: 'one' }, { requestId: 'two' }] }) });
  assert.equal(Number(b.get('st-pairs').textContent), 2);
  assert.equal(Number(b.get('nav-pairing-badge').textContent), 2);
  assert.equal(b.get('btn-approve-all').style.display, '');
  b.context.document.hidden = true;
  b.documentListeners.visibilitychange();
  const before = b.calls.length;
  await b.context.refreshStatus();
  await b.context.refreshPairing();
  assert.equal(stream.closed, true);
  assert.equal(b.calls.length, before);
  b.context.document.hidden = false;
  b.documentListeners.visibilitychange();
  await flush();
  assert.equal(b.streams.filter(stream => stream.url === '/api/pairing/stream' && !stream.closed).length, 1);
  assert.equal(b.streams.filter(stream => stream.url === '/api/pairing/stream').length, 2);
});

test('pairing errors have one reconnect timer, canceled on hiding or leaving the panel', async () => {
  const b = await browser('admin');
  b.context.navigate('pairing');
  await flush();
  const stream = b.streams.find(stream => stream.url === '/api/pairing/stream');
  const error = stream.onerror;
  error();
  error();
  const reconnect = b.timers.filter(timer => timer.delay === 4000 && !timer.cleared);
  assert.equal(reconnect.length, 1);
  assert.equal(stream.closed, true);
  b.context.document.hidden = true;
  b.documentListeners.visibilitychange();
  assert.equal(reconnect[0].cleared, true);
  reconnect[0].callback();
  assert.equal(b.streams.filter(stream => stream.url === '/api/pairing/stream').length, 1);
  b.context.document.hidden = false;
  b.documentListeners.visibilitychange();
  await flush();
  const next = b.streams.filter(stream => stream.url === '/api/pairing/stream').at(-1);
  next.onerror();
  b.context.navigate('about');
  assert.equal(b.timers.filter(timer => timer.delay === 4000 && !timer.cleared).length, 0);
});

test('other visible panels avoid extra pairing workers, and visibility never closes terminal work', async () => {
  const b = await browser('admin');
  const terminal = { close() { assert.fail('visibility must not close a terminal session'); } };
  b.context.probeTerminal = terminal;
  vm.runInContext('termWS = probeTerminal', b.context);
  b.context.navigate('about');
  const before = b.calls.filter(call => call.url === '/api/pairing/pending').length;
  await b.context.refreshStatus();
  assert.equal(b.calls.filter(call => call.url === '/api/pairing/pending').length, before);
  b.context.document.hidden = true;
  b.documentListeners.visibilitychange();
  b.context.document.hidden = false;
  b.documentListeners.visibilitychange();
  await flush();
  assert.equal(vm.runInContext('termWS', b.context), terminal);
  assert.equal(b.calls.filter(call => call.url === '/api/pairing/pending').length, before);
  assert.ok(!b.calls.some(call => call.options.method === 'POST'));
});
