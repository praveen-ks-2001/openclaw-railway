import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createUpgradeRecovery } from "./upgrade-recovery.js";

function fixture(t, { nested = false, externalConfig = false, absentWorkspace = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const workspaceDir = nested ? path.join(stateDir, "workspace") : path.join(root, "workspace");
  const configPath = path.join(externalConfig ? root : stateDir, "openclaw.json");
  fs.mkdirSync(stateDir);
  if (!absentWorkspace) fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { workspace: workspaceDir } }, fixture: "old" }));
  fs.writeFileSync(path.join(stateDir, "gateway.token"), "stable-token", { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, "database.sqlite"), "old-database");
  fs.writeFileSync(path.join(stateDir, "database.sqlite-wal"), "committed-wal");
  fs.mkdirSync(path.join(stateDir, "devices"));
  fs.writeFileSync(path.join(stateDir, "devices", "paired.json"), "keep-authority");
  if (!absentWorkspace) fs.writeFileSync(path.join(workspaceDir, "memory.md"), "all-memory");
  const options = { stateDir, workspaceDir, configPath, version: "2026.10.4", env: {} };
  const control = () => createUpgradeRecovery(options);
  function mutate() {
    fs.writeFileSync(configPath, '{"fixture":"migrated"}');
    fs.writeFileSync(path.join(stateDir, "database.sqlite"), "new-schema");
    fs.rmSync(path.join(stateDir, "database.sqlite-wal"));
    fs.rmSync(path.join(stateDir, "devices"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "memory.md"), "overwritten");
  }
  function assertRestored() {
    assert.equal(JSON.parse(fs.readFileSync(configPath)).fixture, "old");
    assert.equal(fs.readFileSync(path.join(stateDir, "gateway.token"), "utf8"), "stable-token");
    assert.equal(fs.readFileSync(path.join(stateDir, "database.sqlite"), "utf8"), "old-database");
    assert.equal(fs.readFileSync(path.join(stateDir, "database.sqlite-wal"), "utf8"), "committed-wal");
    assert.equal(fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"), "keep-authority");
    if (absentWorkspace) assert.equal(fs.existsSync(workspaceDir), false);
    else assert.equal(fs.readFileSync(path.join(workspaceDir, "memory.md"), "utf8"), "all-memory");
  }
  return { root, options, stateDir, workspaceDir, configPath, control, mutate, assertRestored };
}

test("managed npm host peers are captured as links to the verified installed runtime", (t) => {
  const f = fixture(t);
  const codeRoot = path.join(f.root, "installed-openclaw");
  fs.mkdirSync(codeRoot);
  fs.writeFileSync(path.join(codeRoot, "package.json"), JSON.stringify({ name: "openclaw", version: f.options.version }));
  fs.writeFileSync(path.join(codeRoot, "runtime.js"), "original-runtime");
  f.options.openclawRoot = codeRoot;
  const relative = "npm/projects/openclaw-discord-fixture/node_modules/@openclaw/discord/node_modules/openclaw";
  const peer = path.join(f.stateDir, relative);
  fs.mkdirSync(path.dirname(peer), { recursive: true });
  fs.symlinkSync(codeRoot, peer);
  const attempt = f.control().begin();
  const captured = path.join(attempt.snapshotPath, "snapshot", "0", relative);
  assert.equal(fs.lstatSync(captured).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(captured), codeRoot);
  fs.rmSync(peer);
  fs.writeFileSync(path.join(codeRoot, "runtime.js"), "replacement-runtime");
  f.control().rollback();
  assert.equal(fs.readlinkSync(peer), codeRoot);
  assert.equal(fs.readFileSync(path.join(codeRoot, "runtime.js"), "utf8"), "replacement-runtime", "snapshot restoration must not overwrite external runtime code");
  f.assertRestored();
});

test("host-peer allowance cannot hide external user data or an unverified runtime", (t) => {
  for (const invalid of ["outside-project", "different-target", "code-subdirectory", "wrong-version", "wrong-package"]) {
    const f = fixture(t);
    const codeRoot = path.join(f.root, "installed-openclaw");
    fs.mkdirSync(codeRoot);
    fs.mkdirSync(path.join(codeRoot, "subdirectory"));
    fs.writeFileSync(path.join(codeRoot, "package.json"), JSON.stringify({ name: invalid === "wrong-package" ? "other-package" : "openclaw", version: invalid === "wrong-version" ? "2026.9.5" : f.options.version }));
    f.options.openclawRoot = codeRoot;
    const outside = path.join(f.root, "external-user-data");
    fs.mkdirSync(outside);
    const peer = path.join(f.stateDir, invalid === "outside-project" ? "credentials/node_modules/openclaw" : "npm/projects/fixture/node_modules/openclaw");
    fs.mkdirSync(path.dirname(peer), { recursive: true });
    fs.symlinkSync(invalid === "different-target" ? outside : invalid === "code-subdirectory" ? path.join(codeRoot, "subdirectory") : codeRoot, peer);
    assert.throws(() => f.control().begin(), /external state\/workspace symbolic link/, invalid);
    f.assertRestored();
  }
});

test("successful release never restores a stale snapshot on an ordinary redeploy", (t) => {
  const f = fixture(t);
  const first = f.control().begin();
  f.mutate();
  f.control().commit();
  fs.writeFileSync(path.join(f.workspaceDir, "memory.md"), "new-user-work-after-upgrade");
  assert.equal(f.control().recover().recovered, false);
  assert.equal(f.control().begin().needed, false);
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, "memory.md"), "utf8"), "new-user-work-after-upgrade");
  assert.equal(fs.existsSync(path.join(first.snapshotPath, "snapshot", "0", "database.sqlite")), true);
  const forced = f.control().begin({ force: true });
  assert.notEqual(forced.snapshotPath, first.snapshotPath);
  fs.writeFileSync(path.join(f.workspaceDir, "memory.md"), "failed-maintenance");
  f.control().rollback();
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, "memory.md"), "utf8"), "new-user-work-after-upgrade");
});

for (const layout of [{}, { nested: true }, { externalConfig: true }, { absentWorkspace: true }]) {
  test(`failed migration restores complete original data and blocks accidental retry ${JSON.stringify(layout)}`, (t) => {
    const f = fixture(t, layout);
    const before = f.control().begin();
    f.mutate();
    assert.equal(f.control().rollback().blocked, true);
    f.assertRestored();
    assert.equal(f.control().recover().recovered, false);
    assert.throws(() => f.control().begin(), /deliberate recovery attempt/);
    assert.equal(fs.existsSync(path.join(before.snapshotPath, "manifest.json")), true);
    const next = f.control().begin({ force: true });
    assert.notEqual(next.snapshotPath, before.snapshotPath);
    f.control().commit();
  });
}

test("interrupted migration is recovered on next boot without running any target process", (t) => {
  const f = fixture(t);
  f.control().begin();
  f.mutate();
  const recovered = f.control().recover();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.blocked, true);
  f.assertRestored();
});

test("different corrected target may attempt migration after original data is recovered", (t) => {
  const f = fixture(t);
  f.control().begin();
  f.mutate();
  const next = createUpgradeRecovery({ ...f.options, version: "2026.10.5" });
  assert.equal(next.recover().blocked, false);
  f.assertRestored();
  assert.equal(next.begin().needed, true);
  next.commit();
});

test("a recorded successful newer schema refuses an older target even for forced repair", (t) => {
  const f = fixture(t);
  f.control().begin();
  f.mutate();
  f.control().commit();
  const older = createUpgradeRecovery({ ...f.options, version: "2026.9.33" });
  assert.throws(() => older.begin(), /older OpenClaw release/);
  assert.throws(() => older.begin({ force: true }), /older OpenClaw release/);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "database.sqlite"), "utf8"), "new-schema");
});

test("capture failure cannot publish an incomplete recovery point or mutate original state", (t) => {
  const f = fixture(t);
  assert.throws(() => createUpgradeRecovery({ ...f.options, checkpoint(point) {
    if (point === "snapshot-copied-0") throw new Error("capture interrupted");
  } }).begin(), /capture interrupted/);
  f.assertRestored();
  assert.equal(f.control().status().status, undefined);
  assert.equal(f.control().begin().needed, true);
});

const helperUrl = new URL("./upgrade-recovery.js", import.meta.url).href;
function crashChild(f, point, operation) {
  const script = `import { createUpgradeRecovery } from ${JSON.stringify(helperUrl)};
    const recovery = createUpgradeRecovery({ ...JSON.parse(process.env.FIXTURE_OPTIONS), checkpoint(point) {
      if (point === process.env.FIXTURE_POINT) process.exit(79);
    } });
    recovery[process.env.FIXTURE_OPERATION]();`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, FIXTURE_OPTIONS: JSON.stringify(f.options), FIXTURE_POINT: point, FIXTURE_OPERATION: operation },
    encoding: "utf8",
  });
  assert.equal(result.status, 79, result.stderr);
}

for (const point of [
  "restore-started", "restore-prepared-0", "restore-moving-0", "restore-live-moved-0",
  "restore-installing-0", "restore-snapshot-installed-0", "restore-completed-0",
  "restore-live-moved-1", "restore-snapshot-installed-1", "restore-completed",
]) {
  test(`process death at ${point} resumes restoration without losing either generation`, (t) => {
    const f = fixture(t);
    f.control().begin();
    f.mutate();
    crashChild(f, point, "rollback");
    f.control().recover();
    f.assertRestored();
    assert.equal(f.control().status().status, "rolled-back");
    assert.equal(fs.readFileSync(path.join(f.root, fs.readdirSync(f.root).find((name) => name.startsWith(".wrapper-upgrade-failed-") && name.endsWith("-0")), "database.sqlite"), "utf8"), "new-schema");
  });
}

test("process death while capturing cannot migrate the live data and next boot may retry", (t) => {
  const f = fixture(t);
  crashChild(f, "snapshot-copied-0", "begin");
  f.assertRestored();
  assert.equal(f.control().recover().blocked, false);
  assert.equal(f.control().begin().needed, true);
});

test("commit death preserves migrated data and completes success marker on next boot", (t) => {
  const f = fixture(t);
  f.control().begin();
  f.mutate();
  crashChild(f, "migration-committed", "commit");
  assert.equal(f.control().recover().blocked, false);
  assert.equal(f.control().begin().needed, false);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "database.sqlite"), "utf8"), "new-schema");
});

test("a second process death partway through resumed restore still recovers both roots", (t) => {
  const f = fixture(t);
  f.control().begin();
  f.mutate();
  crashChild(f, "restore-live-moved-0", "rollback");
  crashChild(f, "restore-snapshot-installed-1", "recover");
  f.control().recover();
  f.assertRestored();
});

test("reset after commit death invalidates success instead of resurrecting a stale marker", (t) => {
  const f = fixture(t);
  f.control().begin();
  f.mutate();
  crashChild(f, "migration-committed", "commit");
  f.control().forget({ successOnly: true });
  assert.equal(f.control().recover().version, null);
  assert.equal(f.control().status().needed, true);
});

test("unsupported external data and include graphs fail before changing persistent data", (t) => {
  const f = fixture(t);
  for (const config of [
    { $include: "./base.json5" },
    { agents: { defaults: { workspace: "/uncovered/workspace" } } },
    { agents: { list: [{ id: "custom", agentDir: "/uncovered/agent" }] } },
    { agents: { entries: { custom: { agentDir: "/uncovered/agent" } } } },
    { agents: { list: { custom: { workspace: "${EXTERNAL_WORKSPACE}" } } } },
    { session: { store: "/uncovered/sessions.json" } },
    { cron: { store: "/uncovered/jobs.json" } },
  ]) {
    fs.writeFileSync(f.configPath, JSON.stringify(config));
    assert.throws(() => f.control().begin(), /does not support|does not cover/);
    assert.equal(fs.readFileSync(path.join(f.stateDir, "database.sqlite"), "utf8"), "old-database");
  }
  fs.writeFileSync(f.configPath, "{}");
  assert.throws(() => createUpgradeRecovery({ ...f.options, env: { OPENCLAW_OAUTH_DIR: "/uncovered/oauth" } }).begin(), /external credentials/);
});

test("external symbolic state cannot escape coverage while generated plugin skill links are preserved", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "database.sqlite"), "external-state");
  const link = path.join(f.stateDir, "custom-data");
  fs.symlinkSync(outside, link);
  assert.throws(() => f.control().begin(), /external state\/workspace symbolic link/);
  fs.unlinkSync(link);
  fs.mkdirSync(path.join(f.stateDir, "plugin-skills"));
  const generated = path.join(f.stateDir, "plugin-skills", "canvas");
  fs.symlinkSync(outside, generated);
  f.control().begin();
  fs.unlinkSync(generated);
  f.control().rollback();
  assert.equal(fs.readlinkSync(generated), outside);
});

test("insufficient disk refuses migration without an active transaction", (t) => {
  const f = fixture(t);
  const control = createUpgradeRecovery({ ...f.options, statfs: () => ({ bavail: 0n, bsize: 4096n }) });
  assert.throws(() => control.begin(), /Not enough disk space/);
  f.assertRestored();
  assert.equal(control.status().status, undefined);
});

test("verified replacement invalidates a prior block and success invalidation retains recovery copies", (t) => {
  const f = fixture(t);
  const initial = f.control().begin();
  f.mutate();
  assert.throws(() => f.control().adopt(), /upgrade is active/);
  assert.throws(() => f.control().forget(), /active upgrade/);
  f.control().rollback();
  f.control().forget({ successOnly: true });
  assert.equal(f.control().recover().blocked, true);
  // Stand in for a separately migrated, verified import.
  f.mutate();
  f.control().adopt();
  assert.equal(f.control().recover().blocked, false);
  assert.equal(f.control().begin().needed, false);
  assert.equal(fs.existsSync(initial.snapshotPath), true);
  f.control().forget();
  assert.equal(f.control().status().needed, true);
  assert.equal(fs.existsSync(initial.snapshotPath), true);
});

test("death while adopting a verified replacement finishes success without restoring prior state", (t) => {
  const f = fixture(t);
  f.control().begin();
  f.mutate();
  f.control().rollback();
  f.mutate();
  crashChild(f, "replacement-adopted", "adopt");
  assert.equal(f.control().recover().blocked, false);
  assert.equal(f.control().begin().needed, false);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "database.sqlite"), "utf8"), "new-schema");
});

test("changed paths and corrupt journal fail closed rather than restoring unrelated roots", (t) => {
  const f = fixture(t);
  f.control().begin();
  assert.throws(() => createUpgradeRecovery({ ...f.options, workspaceDir: path.join(f.root, "changed-workspace") }).recover(), /incompatible/);
  const journalPath = path.join(f.root, ".wrapper-upgrade-recovery", "active.json");
  const journal = JSON.parse(fs.readFileSync(journalPath));
  journal.records[0].target = "/unrelated";
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => f.control().recover(), /unsafe roots/);
  f.assertRestored();
});
