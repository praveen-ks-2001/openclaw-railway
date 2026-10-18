import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateRetiredPluginIndex } from "./legacy-migration.js";
test("only retired plugin registries use the exact intermediate tool before target migration", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"),
    toolsDir = path.join(root, "tools");
  fs.mkdirSync(stateDir);
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "npm") {
      const target = path.join(
        args[args.indexOf("--prefix") + 1],
        "node_modules/openclaw",
      );
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, "package.json"),
        '{"version":"2026.9.5","openclaw":{"schemaVersions":{"state":17,"agent":21}}}',
      );
    }
    if (args.includes("doctor"))
      fs.rmSync(path.join(stateDir, "plugins/installs.json"));
    return { code: 0, output: "" };
  };
  const options = { stateDir, toolsDir, node: process.execPath, run };
  assert.equal((await migrateRetiredPluginIndex(options)).migrated, false);
  assert.equal(calls.length, 0);
  fs.mkdirSync(path.join(stateDir, "plugins"));
  fs.writeFileSync(path.join(stateDir, "plugins/installs.json"), "{}");
  assert.equal((await migrateRetiredPluginIndex(options)).version, "2026.9.5");
  assert.ok(calls[0][1].includes("openclaw@2026.9.5"));
  assert.ok(calls.at(-1)[1].includes("doctor"));
});

function database(filename, { version, role = "global", appVersion = null, metaVersion = version }) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA user_version=${version}; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,role TEXT,schema_version INTEGER,app_version TEXT); CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('preserved');`);
    db.prepare("INSERT INTO schema_meta VALUES('primary',?,?,?)").run(role, metaVersion, appVersion);
  } finally { db.close(); }
}

function bridgeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-bridge-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"), toolsDir = path.join(root, "tools");
  fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
  const index = path.join(stateDir, "plugins", "installs.json");
  fs.writeFileSync(index, '{"fixture":"legacy"}');
  const calls = [];
  const options = { stateDir, toolsDir, node: process.execPath, env: {}, run: async (...args) => {
    calls.push(args);
    throw new Error("CLI should not run");
  } };
  return { root, stateDir, index, calls, options };
}

for (const metadata of [
  { version: 20, appVersion: "2026.10.4" },
  { version: 20, appVersion: "2026.9.5" },
  { version: 20, appVersion: null },
  { version: 17, appVersion: "2026.10.4" },
  { version: 17, metaVersion: 20 },
  { version: 17, role: "agent" },
]) {
  test(`mixed retired index and incompatible global DB refuses every subprocess ${JSON.stringify(metadata)}`, async (t) => {
    const f = bridgeFixture(t);
    const filename = path.join(f.stateDir, "state", "openclaw.sqlite");
    database(filename, metadata);
    const before = fs.readFileSync(filename), indexBefore = fs.readFileSync(f.index);
    await assert.rejects(migrateRetiredPluginIndex(f.options), /cannot safely be opened/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.deepEqual(fs.readFileSync(f.index), indexBefore);
    assert.equal(fs.existsSync(f.options.toolsDir), false);
  });
}

for (const locator of ["owned", "registry", "config"]) {
  test(`agent-only newer state from ${locator} cannot be opened by intermediate CLI`, async (t) => {
    const f = bridgeFixture(t);
    const agent = locator === "owned" ? path.join(f.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")
      : path.join(f.root, "custom", "openclaw-agent.sqlite");
    database(agent, { role: "agent", version: 24 });
    if (locator === "registry") {
      const shared = path.join(f.stateDir, "state", "openclaw.sqlite");
      database(shared, { version: 1 });
      const db = new DatabaseSync(shared);
      try {
        db.exec("CREATE TABLE agent_databases(path TEXT)");
        db.prepare("INSERT INTO agent_databases VALUES(?)").run(agent);
      } finally { db.close(); }
    }
    if (locator === "config") fs.writeFileSync(path.join(f.stateDir, "openclaw.json"), JSON.stringify({ agents: { entries: { custom: { agentDir: path.dirname(agent) } } } }));
    const before = fs.readFileSync(agent);
    await assert.rejects(migrateRetiredPluginIndex(f.options), /cannot safely be opened/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readFileSync(agent), before);
  });
}

test("recognized baseline and bridge-compatible schemas are admitted before tool installation", async (t) => {
  for (const version of [1, 17]) {
    const f = bridgeFixture(t);
    database(path.join(f.stateDir, "state", "openclaw.sqlite"), { version });
    database(path.join(f.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"), { role: "agent", version: 21 });
    await assert.rejects(migrateRetiredPluginIndex(f.options), /CLI should not run/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], "npm");
  }
});

test("newer authored config cannot be rewritten by the old bridge even without SQLite metadata", async (t) => {
  const f = bridgeFixture(t);
  const config = path.join(f.stateDir, "openclaw.json");
  fs.writeFileSync(config, '{"meta":{"lastTouchedVersion":"2026.10.4"}}');
  const before = fs.readFileSync(config);
  await assert.rejects(migrateRetiredPluginIndex(f.options), /cannot safely be opened/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readFileSync(config), before);
});

test("schema compatibility is rechecked after installation before any bridge invocation", async (t) => {
  const f = bridgeFixture(t);
  const options = { ...f.options, run: async (cmd, args) => {
    f.calls.push([cmd, args]);
    assert.equal(cmd, "npm");
    const target = path.join(args[args.indexOf("--prefix") + 1], "node_modules", "openclaw");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), '{"version":"2026.9.5","openclaw":{"schemaVersions":{"state":17,"agent":21}}}');
    database(path.join(f.stateDir, "state", "openclaw.sqlite"), { version: 20 });
    return { code: 0 };
  } };
  // The metadata-only --version probe is intentionally not allowed either once
  // newer state is observed; no old executable should see the live environment.
  await assert.rejects(migrateRetiredPluginIndex(options), /cannot safely be opened/);
  assert.equal(f.calls.length, 1);
});
