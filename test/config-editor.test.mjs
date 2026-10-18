import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-config-editor-test-'));
process.env.OPENCLAW_DATA_DIR = directory;
const { OPENCLAW_CONFIG_PATH } = await import('../src/config/index.js');
const { createConfigEditor, readEditableConfig, recoverConfigEdit, redactConfig, retainConfigSecrets, REDACTED } = await import('../src/services/configEditor.js');
const { setBootFailure } = await import('../src/services/operations.js');
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const base = { gateway: { mode: 'local', auth: { token: 'synthetic-gateway-secret' } }, models: { providers: { example: { apiKey: 'synthetic-provider-secret', headers: { 'X-Custom': 'synthetic-header-secret' } } } }, agents: { defaults: { model: { primary: 'example/model' } } } };
const write = async (raw = JSON.stringify(base)) => { await fs.mkdir(path.dirname(OPENCLAW_CONFIG_PATH), { recursive: true }); await fs.writeFile(OPENCLAW_CONFIG_PATH, raw); setBootFailure(null); return raw; };
const goodCli = async (args, options) => {
  assert.deepEqual(args, ['config', 'validate', '--json']);
  const filename = options.env.OPENCLAW_CONFIG_PATH;
  assert.notEqual(filename, OPENCLAW_CONFIG_PATH);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(filename)).gateway.auth.token, base.gateway.auth.token);
  return { code: 0, output: 'Some harmless diagnostics\n' + JSON.stringify({ valid: true }) };
};
const fakeGateway = (running = false) => ({ running, starts: 0, stops: 0, isRunning() { return this.running; }, async stop() { this.stops++; this.running = false; }, async start() { this.starts++; this.running = true; } });

test.after(async () => { setBootFailure(null); await fs.rm(directory, { recursive: true, force: true }); });

test('redacted config round trip retains all covered secrets and permits explicit replacement', async () => {
  await write();
  const displayed = await readEditableConfig();
  assert.equal(displayed.config.gateway.auth.token, REDACTED);
  assert.equal(displayed.config.models.providers.example.apiKey, REDACTED);
  assert.equal(displayed.config.models.providers.example.headers['X-Custom'], REDACTED);
  const gateway = fakeGateway(false);
  const save = createConfigEditor({ gateway, cli: goodCli, stopTerminals: async () => {} });
  const result = await save(displayed.config, displayed.revision);
  assert.deepEqual(JSON.parse(await fs.readFile(OPENCLAW_CONFIG_PATH)), base);
  assert.equal((await fs.stat(OPENCLAW_CONFIG_PATH)).mode & 0o777, 0o600);
  assert.equal(gateway.starts, 0);
  assert.notEqual(result.revision, displayed.revision);
  const next = await readEditableConfig();
  next.config.models.providers.example.apiKey = 'synthetic-replacement';
  await save(next.config, next.revision);
  assert.equal(JSON.parse(await fs.readFile(OPENCLAW_CONFIG_PATH)).models.providers.example.apiKey, 'synthetic-replacement');
});

test('stale revision and invalid schema leave config and Gateway untouched', async () => {
  const raw = await write();
  const loaded = await readEditableConfig();
  const gateway = fakeGateway(true);
  const stale = createConfigEditor({ gateway, cli: () => assert.fail('no validation for stale revision'), stopTerminals: () => assert.fail() });
  await assert.rejects(stale(loaded.config, '0'.repeat(64)), (error) => error.status === 409);
  const invalid = createConfigEditor({ gateway, cli: async () => ({ code: 1, output: 'synthetic-provider-secret was invalid' }), stopTerminals: () => assert.fail() });
  await assert.rejects(invalid(loaded.config, loaded.revision), (error) => error.status === 400 && !error.message.includes('synthetic-provider-secret'));
  assert.equal(await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf8'), raw);
  assert.equal(gateway.stops, 0);
});

test('startup failure restores exact prior JSON5 bytes and restarts previous config', async () => {
  const raw = await write('// Existing user comment\n' + JSON.stringify(base));
  const loaded = await readEditableConfig();
  loaded.config.agents.defaults.model.primary = 'example/other';
  const gateway = fakeGateway(true);
  gateway.start = async function () { this.starts++; if (this.starts === 1) throw new Error('failed startup with synthetic-provider-secret'); this.running = true; };
  const save = createConfigEditor({ gateway, cli: goodCli, stopTerminals: async () => {} });
  await assert.rejects(save(loaded.config, loaded.revision), (error) => error.status === 500 && /restored/.test(error.message) && !error.message.includes('synthetic-provider-secret'));
  assert.equal(await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf8'), raw);
  assert.equal(gateway.starts, 2);
  await assert.rejects(fs.access(path.join(directory, '.openclaw-wrapper/config-editor-transaction.json')));
});

test('crash recovery restores a pending candidate but refuses to overwrite later edits', async () => {
  const old = await write();
  const candidate = JSON.stringify({ ...base, meta: { edit: 1 } });
  const journal = path.join(directory, '.openclaw-wrapper/config-editor-transaction.json');
  await fs.mkdir(path.dirname(journal), { recursive: true });
  const record = { schema: 1, previous: Buffer.from(old).toString('base64'), previousRevision: hash(old), candidateRevision: hash(candidate) };
  await fs.writeFile(journal, JSON.stringify(record));
  await fs.writeFile(OPENCLAW_CONFIG_PATH, candidate);
  assert.equal(await recoverConfigEdit(), true);
  assert.equal(await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf8'), old);
  await fs.writeFile(journal, JSON.stringify(record));
  const later = JSON.stringify({ ...base, meta: { edit: 2 } });
  await fs.writeFile(OPENCLAW_CONFIG_PATH, later);
  await assert.rejects(recoverConfigEdit(), (error) => error.status === 503 && /will not overwrite/.test(error.message));
  assert.equal(await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf8'), later);
  await fs.rm(journal);
});

test('unknown placeholders and reordered secret-bearing lists are rejected', () => {
  assert.throws(() => retainConfigSecrets({ arbitrary: REDACTED }, {}), /no matching saved secret/);
  const previous = { accounts: [{ name: 'first', apiKey: 'one' }, { name: 'second', apiKey: 'two' }] };
  const edited = redactConfig(previous); edited.accounts.reverse();
  assert.throws(() => retainConfigSecrets(edited, previous), /reordered list/);
  assert.deepEqual(JSON.parse(JSON.stringify(retainConfigSecrets(redactConfig(previous), previous))), previous);
});
