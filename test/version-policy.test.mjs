import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repository = new URL('../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
function fixture(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-fourth-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const code = path.join(root, 'runtime');
  const entry = path.join(code, 'dist', 'entry.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'openclaw', version, type: 'module' }));
  fs.writeFileSync(entry, 'import fs from "node:fs";fs.writeFileSync(process.env.PROBE_CLI_MARKER,"WRONGLY_EXECUTED");');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, '.openclaw', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(data, '.openclaw', 'openclaw.json'), '{"gateway":{"auth":{"token":"synthetic-stored-token"}}}\n');
  fs.writeFileSync(path.join(data, '.openclaw', 'workspace', 'memory.md'), 'original user memory\n');
  return { root, data, entry, env: { ...process.env, OPENCLAW_DATA_DIR: data, OPENCLAW_ENTRY: entry, OPENCLAW_NODE: process.execPath, WRAPPER_ADMIN_PASSWORD: 'synthetic-test-admin', PROBE_CLI_MARKER: path.join(root, 'cli-was-executed') } };
}
function inventory(root) {
  const result = {};
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const stat = fs.lstatSync(filename);
      result[path.relative(root, filename)] = { mode: stat.mode & 0o777, hash: entry.isFile() ? createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : null };
      if (entry.isDirectory()) walk(filename);
    }
  }
  walk(root);
  return result;
}

test('branch manifest wins over missing, old, future, mutable, invalid, and spoofed Railway selectors', t => {
  const f = fixture(t, manifest.openclawVersion);
  for (const selector of [undefined, '', '2026.6.6', '2027.1.1', 'latest', 'not-a-release']) {
    const env = { ...f.env, OPENCLAW_REQUESTED_VERSION: 'spoofed', OPENCLAW_MINIMUM_VERSION: '1900.1.1', OPENCLAW_EFFECTIVE_VERSION: 'spoofed', OPENCLAW_VERSION_BUMPED: 'true', OPENCLAW_NO_AUTO_UPDATE: '0' };
    if (selector === undefined) delete env.OPENCLAW_VERSION;
    else env.OPENCLAW_VERSION = selector;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const {getVersionInfo,assertPinnedRuntime}=await import('./src/utils/version.js');
      assertPinnedRuntime();
      console.log(JSON.stringify({info:getVersionInfo(),version:process.env.OPENCLAW_VERSION,noAuto:process.env.OPENCLAW_NO_AUTO_UPDATE,legacy:[process.env.OPENCLAW_REQUESTED_VERSION,process.env.OPENCLAW_MINIMUM_VERSION,process.env.OPENCLAW_EFFECTIVE_VERSION,process.env.OPENCLAW_VERSION_BUMPED]}));
    `], { cwd: repository, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const received = JSON.parse(child.stdout);
    assert.equal(received.version, manifest.openclawVersion, String(selector));
    assert.equal(received.noAuto, '1');
    assert.deepEqual(received.legacy, [null, null, null, null]);
    assert.equal(received.info.source, 'branch');
    assert.equal(received.info.pinned, manifest.openclawVersion);
    assert.equal(received.info.effective, manifest.openclawVersion);
    assert.equal(received.info.requested, null);
    assert.equal(received.info.bumped, false);
  }
  assert.equal(fs.existsSync(f.env.PROBE_CLI_MARKER), false);
});

test('actual server startup rejects a mismatched package before CLI execution or any persistent writes', t => {
  const f = fixture(t, '2026.6.6');
  const before = inventory(f.root);
  const child = spawnSync(process.execPath, ['src/server.js'], {
    cwd: repository,
    env: { ...f.env, OPENCLAW_VERSION: manifest.openclawVersion, OPENCLAW_EFFECTIVE_VERSION: manifest.openclawVersion },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stderr, /does not match branch pin/);
  assert.deepEqual(inventory(f.root), before);
});

test('actual server startup refuses an absent installed package before touching user state', t => {
  const f = fixture(t, manifest.openclawVersion);
  fs.rmSync(path.join(f.root, 'runtime', 'package.json'));
  const before = inventory(f.root);
  const child = spawnSync(process.execPath, ['src/server.js'], { cwd: repository, env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stderr, /Cannot locate the installed OpenClaw package/);
  assert.deepEqual(inventory(f.root), before);
});
