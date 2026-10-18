import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { collectInventory, compareInventories, normalizeConfiguration, normalizeMemoryEmbedding, resolveRegisteredDatabasePath } from "./docker-state-inventory.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inventory-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, "state"), workspaceDir = path.join(directory, "workspace");
  fs.mkdirSync(stateDir); fs.mkdirSync(workspaceDir);
  const put = (relative, value) => {
    const filename = path.join(stateDir, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  };
  const database = (relative, sql, fn) => {
    const filename = path.join(stateDir, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    try { db.exec(sql); fn?.(db); } finally { db.close(); }
  };
  return { stateDir, workspaceDir, put, database };
}

const ownerSchema = "CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,role TEXT,schema_version INTEGER,agent_id TEXT,app_version TEXT,created_at INTEGER,updated_at INTEGER)";
function databaseOwnershipFixture(t, { target = false } = {}) {
  const item = fixture(t);
  item.put("openclaw.json", {});
  const agentPath = path.join(item.stateDir, "agents/main/agent/openclaw-agent.sqlite");
  item.database("agents/main/agent/openclaw-agent.sqlite", ownerSchema, db => {
    db.prepare("INSERT INTO schema_meta VALUES ('primary','agent',?,'main',?,?,?)").run(target ? 24 : 1, target ? "2026.10.4" : null, target ? 100 : 1, target ? 200 : 1);
  });
  item.database("state/openclaw.sqlite", ownerSchema + ";CREATE TABLE agent_databases(agent_id TEXT,path TEXT,schema_version INTEGER,last_seen_at INTEGER,size_bytes INTEGER)", db => {
    db.prepare("INSERT INTO schema_meta VALUES ('primary','global',?,NULL,?,?,?)").run(target ? 20 : 1, target ? "2026.10.4" : null, target ? 100 : 1, target ? 200 : 1);
    db.prepare("INSERT INTO agent_databases VALUES ('main',?,?,?,?)").run(target ? "agents/main/agent/openclaw-agent.sqlite" : agentPath, target ? 24 : 1, target ? 200 : 1, target ? 131072 : 8192);
  });
  return item;
}
function editDatabase(item, relative, sql, ...parameters) {
  const db = new DatabaseSync(path.join(item.stateDir, relative));
  try { db.prepare(sql).run(...parameters); } finally { db.close(); }
}

test("registry paths follow upstream state-root anchoring for canonical and custom global DB locations", () => {
  assert.equal(resolveRegisteredDatabasePath("/capture/state/openclaw.sqlite", "agents/main/agent/db.sqlite"), "/capture/agents/main/agent/db.sqlite");
  assert.equal(resolveRegisteredDatabasePath("/capture/custom.sqlite", "agents/main/agent/db.sqlite"), "/capture/agents/main/agent/db.sqlite");
  assert.equal(resolveRegisteredDatabasePath("/capture/state/openclaw.sqlite", "/external/agent.sqlite"), "/external/agent.sqlite");
  assert.equal(resolveRegisteredDatabasePath("/capture/state/openclaw.sqlite", "agents/main/../main/agent/db.sqlite"), "/capture/agents/main/agent/db.sqlite");
  assert.throws(() => resolveRegisteredDatabasePath("/capture/state/openclaw.sqlite", null), /invalid path/);
});

test("preserves DB owners and registry targets across absolute-to-relative migration while allowing schema/build/size/time updates", t => {
  const old = databaseOwnershipFixture(t), next = databaseOwnershipFixture(t, { target: true });
  const before = collectInventory(old), after = collectInventory(next);
  assert.equal(before.collectorRevision, 8);
  assert.equal(after.collectorRevision, 8);
  assert.equal(before.coverage.categories["database-owner"], 2);
  assert.equal(before.coverage.categories["agent-database-registration"], 1);
  assert.deepEqual(before.coverage.unprojectedNonemptyTables, []);
  assert.deepEqual(after.coverage.warnings, []);
  assert.equal(compareInventories(before, after).ok, true);
  assert.ok(!JSON.stringify(after.entities).includes(next.stateDir), "disposable root must not become identity or leak into field values");
});

test("changed global/agent role, agent owner, or primary ownership key fails even when all other data remains", t => {
  const old = databaseOwnershipFixture(t), next = databaseOwnershipFixture(t, { target: true });
  const before = collectInventory(old);
  for (const [relative, column, wrong, original] of [
    ["state/openclaw.sqlite", "role", "agent", "global"],
    ["agents/main/agent/openclaw-agent.sqlite", "role", "global", "agent"],
    ["agents/main/agent/openclaw-agent.sqlite", "agent_id", "wrong-owner", "main"],
    ["agents/main/agent/openclaw-agent.sqlite", "meta_key", "missing-primary", "primary"],
  ]) {
    editDatabase(next, relative, `UPDATE schema_meta SET ${column}=?`, wrong);
    const comparison = compareInventories(before, collectInventory(next));
    assert.equal(comparison.ok, false, `${relative}/${column}`);
    assert.ok(comparison.failures.some(failure => failure.category === "database-owner"), `${relative}/${column}`);
    editDatabase(next, relative, `UPDATE schema_meta SET ${column}=?`, original);
  }
  assert.equal(compareInventories(before, collectInventory(next)).ok, true);
});

test("wrong or missing registry owner/target cannot hide behind an intact agent database", t => {
  const old = databaseOwnershipFixture(t), next = databaseOwnershipFixture(t, { target: true });
  const before = collectInventory(old);
  for (const [column, wrong, original] of [
    ["agent_id", "wrong-owner", "main"],
    ["path", "agents/missing/agent/openclaw-agent.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
  ]) {
    editDatabase(next, "state/openclaw.sqlite", `UPDATE agent_databases SET ${column}=?`, wrong);
    const after = collectInventory(next);
    assert.equal(compareInventories(before, after).ok, false, column);
    if (column === "path") assert.ok(after.coverage.warnings.some(warning => warning.table === "agent_databases"));
    editDatabase(next, "state/openclaw.sqlite", `UPDATE agent_databases SET ${column}=?`, original);
  }
  editDatabase(next, "state/openclaw.sqlite", "DELETE FROM agent_databases");
  assert.equal(compareInventories(before, collectInventory(next)).ok, false, "dropping discovery pointer is a regression despite the DB file surviving");
});

test("a registry switched to another existing agent DB fails, and loss of the target primary owner fails", t => {
  const old = databaseOwnershipFixture(t), next = databaseOwnershipFixture(t, { target: true });
  const before = collectInventory(old);
  next.database("agents/other/agent/openclaw-agent.sqlite", ownerSchema, db => {
    db.exec("INSERT INTO schema_meta VALUES ('primary','agent',24,'other','2026.10.4',100,200)");
  });
  editDatabase(next, "state/openclaw.sqlite", "UPDATE agent_databases SET path='agents/other/agent/openclaw-agent.sqlite'");
  assert.equal(compareInventories(before, collectInventory(next)).ok, false, "a different existing DB is not the same pointer");
  editDatabase(next, "state/openclaw.sqlite", "UPDATE agent_databases SET path='agents/main/agent/openclaw-agent.sqlite'");
  editDatabase(next, "agents/main/agent/openclaw-agent.sqlite", "DELETE FROM schema_meta");
  const after = collectInventory(next);
  assert.equal(compareInventories(before, after).ok, false);
  assert.ok(after.coverage.warnings.some(warning => warning.table === "agent_databases"));
});

test("compares coherent credential, cron, history, session, compressed transcript, device and memory entities across retired layouts", (t) => {
  const old = fixture(t), next = fixture(t);
  const secret = "test-only-provider-secret-not-to-be-emitted";
  const profile = { type: "api_key", provider: "minimax", key: secret };
  const authState = { version: 1, order: { minimax: ["minimax:default"] }, lastGood: { minimax: "minimax:default" }, usageStats: { "minimax:default": { lastUsed: 20, errorCount: 0 } } };
  const pluginRecord = { source: "npm", spec: "@example/fixture-plugin@1.0.0", packageName: "@example/fixture-plugin", installPath: "/old/install/path", installedAt: "2026-06-06" };
  const transcript = [
    { type: "session", version: 3, id: "conversation-one", timestamp: "2026-10-16T00:00:00Z" },
    { type: "message", id: "message-one", parentId: null, message: { role: "user", content: [{ type: "text", text: "Private test memory" }] } },
    { type: "message", id: "message-two", parentId: "message-one", message: { role: "assistant", content: [{ type: "text", text: "Retained private reply" }] } },
  ];
  const session = { sessionId: "conversation-one", label: "Retain label", modelOverride: "MiniMax-M2.5", providerOverride: "minimax", updatedAt: 50 };
  const job = { id: "job-one", name: "Retain schedule", enabled: false, createdAtMs: 10, agentId: "main", schedule: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "Retain prompt" }, delivery: { mode: "none" } };
  const history = { jobId: "job-one", ts: 20, status: "ok", summary: "command fixture output", runAtMs: 15, durationMs: 5, delivered: false, deliveryStatus: "not-requested" };
  const device = { deviceId: "device-one", publicKey: "synthetic-public-key", displayName: "Retain approved browser", role: "operator", roles: ["operator"], scopes: ["operator.read"], approvedScopes: ["operator.read"], tokens: { operator: { token: "test-device-secret", role: "operator", scopes: ["operator.read"], createdAtMs: 10 } }, createdAtMs: 10, approvedAtMs: 11 };
  for (const item of [old, next]) {
    fs.mkdirSync(path.join(item.workspaceDir, "memory"));
    fs.writeFileSync(path.join(item.workspaceDir, "memory", "नमस्ते.md"), "Private user note survives\n");
    item.put("gateway.token", "test-gateway-secret");
  }
  old.put("openclaw.json", { meta: { lastTouchedVersion: "2026.6.6" }, agents: { defaults: { model: "minimax/MiniMax-M2.5", workspace: old.workspaceDir }, list: [{ id: "main", workspace: old.workspaceDir }] }, channels: { discord: { enabled: false, dm: { policy: "pairing" } } }, gateway: { controlUi: { allowInsecureAuth: true } } });
  next.put("openclaw.json", { meta: { lastTouchedVersion: "2026.10.4" }, agents: { defaults: { model: { primary: "minimax/MiniMax-M2.5" }, workspace: next.workspaceDir }, entries: { main: { workspace: next.workspaceDir, agentDir: path.join(next.stateDir, "agents/main/agent") } } }, channels: { discord: { enabled: false, dmPolicy: "pairing" } }, gateway: { controlUi: {} } });
  old.put("agents/main/agent/auth-profiles.json", { ...authState, profiles: { "minimax:default": profile } });
  old.put("agents/main/sessions/sessions.json", { "agent:main:main": session });
  old.put("agents/main/sessions/conversation-one.jsonl", transcript.map((record) => JSON.stringify(record)).join("\n") + "\n");
  old.put("devices/paired.json", { "device-one": device });
  old.database("state/openclaw.sqlite", "CREATE TABLE cron_jobs(job_id TEXT PRIMARY KEY,job_json TEXT); CREATE TABLE cron_run_logs(job_id TEXT,ts INTEGER,entry_json TEXT); CREATE TABLE task_runs(task_id TEXT PRIMARY KEY,runtime TEXT,task TEXT,status TEXT); CREATE TABLE task_delivery_state(task_id TEXT PRIMARY KEY,requester_origin_json TEXT,last_notified_event_at INTEGER); CREATE TABLE installed_plugin_index(install_records_json TEXT);", (db) => {
    db.prepare("INSERT INTO cron_jobs VALUES (?,?)").run(job.id, JSON.stringify(job));
    db.prepare("INSERT INTO cron_run_logs VALUES (?,?,?)").run(job.id, history.ts, JSON.stringify(history));
    db.prepare("INSERT INTO task_runs VALUES (?,?,?,?)").run("existing-task", "subagent", "Private task intent", "succeeded");
    db.prepare("INSERT INTO task_delivery_state VALUES (?,?,?)").run("existing-task", JSON.stringify({ channel: "telegram", to: "100000001" }), 25);
    db.prepare("INSERT INTO installed_plugin_index VALUES (?)").run(JSON.stringify({ "fixture-plugin": pluginRecord }));
  });
  old.database("memory/main.sqlite", "CREATE TABLE files(path TEXT PRIMARY KEY,source TEXT,hash TEXT,mtime INTEGER,size INTEGER); CREATE TABLE chunks(id TEXT PRIMARY KEY,path TEXT,source TEXT,start_line INTEGER,end_line INTEGER,hash TEXT,model TEXT,text TEXT,embedding TEXT,updated_at INTEGER);", (db) => {
    db.exec("INSERT INTO files VALUES ('memory/note.md','memory','file-sha',10,30); INSERT INTO chunks VALUES ('chunk-one','memory/note.md','memory',1,2,'chunk-sha','lexical','Private indexed memory','[]',10)");
  });
  next.database("state/openclaw.sqlite", "CREATE TABLE cron_jobs(job_id TEXT PRIMARY KEY,job_json TEXT); CREATE TABLE task_runs(task_id TEXT,runtime TEXT,source_id TEXT,ended_at INTEGER,last_event_at INTEGER,created_at INTEGER,child_session_key TEXT,detail_json TEXT,task TEXT,status TEXT); CREATE TABLE task_delivery_state(task_id TEXT PRIMARY KEY,requester_origin_json TEXT,last_notified_event_at INTEGER); CREATE TABLE config_machine_state(state_key TEXT,value_json TEXT); CREATE TABLE device_pairing_paired(device_id TEXT,public_key TEXT,display_name TEXT,role TEXT,roles_json TEXT,scopes_json TEXT,approved_scopes_json TEXT,tokens_json TEXT,created_at_ms INTEGER,approved_at_ms INTEGER,last_seen_at_ms INTEGER);", (db) => {
    db.prepare("INSERT INTO cron_jobs VALUES (?,?)").run(job.id, JSON.stringify({ ...job, declarationKey: "new-field", updatedAtMs: 99 }));
    db.prepare("INSERT INTO task_runs VALUES (?,?,?,?,?,?,?,?,?,?)").run("new-imported-cron-task", "cron", job.id, history.ts, history.ts, 15, null, JSON.stringify({ ...history, kind: "cron-run", storeKey: "some-key", error: null }), job.id, "succeeded");
    db.prepare("INSERT INTO task_runs(task_id,runtime,task,status) VALUES (?,?,?,?)").run("existing-task", "subagent", "Private task intent", "succeeded");
    db.prepare("INSERT INTO task_delivery_state VALUES (?,?,?)").run("existing-task", JSON.stringify({ channel: "telegram", to: "100000001" }), 25);
    db.prepare("INSERT INTO config_machine_state VALUES (?,?)").run("plugins.installedIndex", JSON.stringify({ revision: 100, index: { installRecords: { "fixture-plugin": { ...pluginRecord, installPath: "/new/install/path", installedAt: "2026-10-04" } } } }));
    db.prepare("INSERT INTO device_pairing_paired VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(device.deviceId, device.publicKey, device.displayName, device.role, JSON.stringify(device.roles), JSON.stringify(device.scopes), JSON.stringify(device.approvedScopes), JSON.stringify(device.tokens), device.createdAtMs, device.approvedAtMs, 99);
  });
  next.database("agents/main/agent/openclaw-agent.sqlite", "CREATE TABLE auth_profile_store(store_key TEXT,store_json TEXT,updated_at INTEGER); CREATE TABLE auth_profile_state(state_key TEXT,state_json TEXT,updated_at INTEGER); CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT); CREATE TABLE session_entry_snapshots(session_key TEXT,field TEXT,value_json TEXT); CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB); CREATE TABLE memory_index_sources(id INTEGER PRIMARY KEY,path TEXT,source TEXT,hash TEXT,mtime INTEGER,size INTEGER); CREATE TABLE memory_index_chunks(chunk_rowid INTEGER PRIMARY KEY,id TEXT,path TEXT,source TEXT,start_line INTEGER,end_line INTEGER,hash TEXT,model TEXT,text TEXT,embedding TEXT,updated_at INTEGER);", (db) => {
    db.prepare("INSERT INTO auth_profile_store VALUES (?,?,?)").run("main", JSON.stringify({ version: 1, profiles: { "minimax:default": profile }, usageStats: {} }), 90);
    db.prepare("INSERT INTO auth_profile_state VALUES (?,?,?)").run("primary", JSON.stringify(authState), 90);
    db.prepare("INSERT INTO session_nodes VALUES (?,?,?)").run("agent:main:main", session.sessionId, JSON.stringify({ ...session, label: undefined, updatedAt: 99 }));
    db.prepare("INSERT INTO session_entry_snapshots VALUES (?,?,?)").run("agent:main:main", "label", JSON.stringify(session.label));
    transcript.forEach((record, index) => db.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run(session.sessionId, index, index === 1 ? null : JSON.stringify(record), index === 1 ? zstdCompressSync(Buffer.from(JSON.stringify(record))) : null));
    db.exec("INSERT INTO memory_index_sources VALUES (1,'memory/note.md','memory','file-sha',99,30); INSERT INTO memory_index_chunks VALUES (1,'chunk-one','memory/note.md','memory',1,2,'chunk-sha','lexical','Private indexed memory','[]',99)");
  });
  const before = collectInventory(old), after = collectInventory(next);
  const comparison = compareInventories(before, after);
  assert.equal(comparison.ok, true, JSON.stringify(comparison.failures));
  assert.equal(comparison.checked.transcriptEvents, 3);
  for (const category of ["credential", "credential-runtime", "plugin-install", "task", "task-delivery", "cron", "cron-history", "session", "paired-device", "memory-source", "memory-chunk"])
    assert.equal(before.coverage.categories[category], 1, category);
  const emitted = JSON.stringify({ before, after, comparison });
  for (const value of [secret, "test-device-secret", "test-gateway-secret", "Private test memory", "Retain prompt", "Retained private reply", "Private indexed memory"])
    assert.ok(!emitted.includes(value), `Leaked fixture value ${value}`);
  const credential = Object.values(after.entities).find((record) => record.category === "credential");
  credential.fields["/key"] = "changed";
  assert.ok(compareInventories(before, after).failures.some((failure) => failure.category === "credential"));
});

test("does not let retired JSON backups conceal a canonical SQLite data loss", (t) => {
  const item = fixture(t);
  item.put("openclaw.json", {});
  item.put("agents/main/sessions/sessions.json", { "agent:main:main": { sessionId: "lost-session" } });
  item.put("agents/main/sessions/lost-session.jsonl", JSON.stringify({ type: "session", id: "lost-session" }) + "\n");
  const before = collectInventory(item);
  item.database("agents/main/agent/openclaw-agent.sqlite", "CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT); CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB);");
  const after = collectInventory(item);
  assert.equal(Object.keys(after.transcripts).length, 0);
  const comparison = compareInventories(before, after);
  assert.equal(comparison.ok, false);
  assert.ok(comparison.failures.some((failure) => failure.category === "session"));
  assert.ok(comparison.failures.some((failure) => failure.category === "transcript"));
});

test("rejects transcript reordering and preserves repeated historical events", () => {
  const base = { format: 1, config: {}, workspaceFiles: {}, durableFiles: {}, entities: {}, coverage: {}, transcripts: { session: ["a", "a", "b"] } };
  const valid = structuredClone(base); valid.transcripts.session.push("new");
  assert.equal(compareInventories(base, valid).ok, true);
  for (const events of [["a", "b"], ["b", "a", "a"]]) {
    const changed = structuredClone(base); changed.transcripts.session = events;
    assert.equal(compareInventories(base, changed).ok, false);
  }
});

test("normalizes official Doctor structural moves while preserving model aliases, allow policy and memory values", () => {
  const old = {
    meta: { lastTouchedVersion: "2026.6.6" },
    agents: { defaults: { models: { "minimax/MiniMax-M3": { alias: "MiniMax", params: { temperature: 0.3 } }, "minimax/MiniMax-M2.7": {} }, memorySearch: { enabled: true, provider: "none", sources: ["memory"], chunkSize: 512, chunkOverlap: 32, maxResults: 7 } }, list: [{ id: "archivist", memorySearch: { enabled: false, provider: "none" } }] },
    channels: { slack: { enabled: false, dm: { enabled: true, policy: "allowlist", allowFrom: ["U123"] }, accounts: { team: { dm: { policy: "open", allowFrom: ["*"] } } } }, discord: { dm: { policy: "pairing", allowFrom: ["123"] } } },
    gateway: { tailscale: { mode: "off", resetOnExit: false } },
  };
  const target = {
    meta: { migrations: { modelPolicyAllowlist: true } },
    agents: { defaults: { models: { "minimax/MiniMax-M3": { alias: "MiniMax", params: { temperature: 0.3 } } }, modelPolicy: { allow: ["minimax/MiniMax-M3", "minimax/MiniMax-M2.7"] } }, entries: { archivist: { memory: { search: { enabled: false, provider: "none" } } } } },
    memory: { search: { enabled: true, provider: "none", sources: ["memory"], chunking: { tokens: 512, overlap: 32 }, query: { maxResults: 7 } } },
    channels: { slack: { enabled: false, dm: { enabled: true }, dmPolicy: "allowlist", allowFrom: ["U123"], accounts: { team: { dmPolicy: "open", allowFrom: ["*"] } } }, discord: { dmPolicy: "pairing", allowFrom: ["123"] } },
    gateway: { tailscale: { mode: "off" } },
  };
  const before = normalizeConfiguration(old), after = normalizeConfiguration(target);
  assert.deepEqual(before.config, after.config);
  assert.equal(before.config.agents.defaults.models["minimax/MiniMax-M3"].alias, "MiniMax");
  assert.deepEqual(before.config.agents.defaults.modelPolicy.allow, ["minimax/MiniMax-M2.7", "minimax/MiniMax-M3"]);
  assert.ok(before.changes.some((change) => change.path === "memory.search"));
  assert.equal(old.agents.defaults.memorySearch.chunkSize, 512, "normalizer must not mutate source");
  for (const change of [
    (value) => { delete value.agents.defaults.models["minimax/MiniMax-M3"].alias; },
    (value) => { value.agents.defaults.modelPolicy.allow.push("openai/*"); },
    (value) => { value.memory.search.provider = "openai"; },
    (value) => { value.channels.slack.allowFrom = ["*"]; },
  ]) {
    const changed = structuredClone(target); change(changed);
    assert.notDeepEqual(normalizeConfiguration(old).config, normalizeConfiguration(changed).config, "must retain changed policy/alias intent");
  }
});

test("does not hide conflicts, dynamic legacy model restrictions, or an active retired retained-route preference", () => {
  const conflict = { channels: { slack: { dmPolicy: "allowlist", allowFrom: ["U123"], dm: { policy: "open", allowFrom: ["*"] } } } };
  assert.deepEqual(normalizeConfiguration(conflict).config.channels.slack.dm, conflict.channels.slack.dm);
  const dynamic = { agents: { defaults: { models: { "unqualified-dynamic-selector": {} } } } };
  assert.deepEqual(normalizeConfiguration(dynamic).config.agents.defaults, dynamic.agents.defaults, "unrepresentable legacy map must stay visible");
  const active = { gateway: { tailscale: { mode: "serve", resetOnExit: false } } };
  const after = { gateway: { tailscale: { mode: "serve" } } };
  assert.notDeepEqual(normalizeConfiguration(active).config, normalizeConfiguration(after).config);
  assert.ok(normalizeConfiguration(active).changes.some((change) => change.reason.startsWith("UNREPRESENTABLE")));
  assert.deepEqual(normalizeConfiguration({ gateway: { tailscale: { mode: "serve", resetOnExit: true } } }).config, normalizeConfiguration(after).config, "explicit cleanup true matches automatic target cleanup");
  assert.notDeepEqual(normalizeConfiguration({ memorySearch: { provider: "auto" } }).config, normalizeConfiguration({ memory: { search: { provider: "openai" } } }).config, "auto to explicit provider is a behavioral change, not a structural move");
});

test("canonical shared machine-state credentials retain every secret and runtime preference", (t) => {
  const old = fixture(t), next = fixture(t);
  const store = { version: 1, profiles: { "minimax:global": { type: "api_key", provider: "minimax", key: "never-emit-this-secret" } } };
  const runtime = { version: 1, lastGood: { minimax: "minimax:global" }, usageStats: { "minimax:global": { errorCount: 0, lastUsed: 123 } } };
  old.database("state/openclaw.sqlite", "CREATE TABLE auth_profile_stores(store_key TEXT,store_json TEXT); CREATE TABLE auth_profile_state(store_key TEXT,state_json TEXT)", (db) => {
    db.prepare("INSERT INTO auth_profile_stores VALUES (?,?)").run("shared", JSON.stringify(store));
    db.prepare("INSERT INTO auth_profile_state VALUES (?,?)").run("shared", JSON.stringify(runtime));
  });
  next.database("state/openclaw.sqlite", "CREATE TABLE config_machine_state(state_key TEXT,value_json TEXT)", (db) => {
    db.prepare("INSERT INTO config_machine_state VALUES (?,?)").run("authProfiles.store", JSON.stringify(store));
    db.prepare("INSERT INTO config_machine_state VALUES (?,?)").run("authProfiles.state", JSON.stringify(runtime));
  });
  const before = collectInventory(old), after = collectInventory(next);
  assert.equal(compareInventories(before, after).ok, true);
  assert.equal(after.coverage.categories.credential, 1);
  assert.equal(after.coverage.categories["credential-runtime"], 1);
  assert.ok(!JSON.stringify(after).includes("never-emit-this-secret"));
  const changed = structuredClone(after);
  delete changed.entities[Object.keys(changed.entities).find((key) => key.startsWith("credential:"))];
  assert.equal(compareInventories(before, changed).ok, false);
});

test("conversation SQLite and explicitly retained diagnostic archives are checked as distinct ordered streams", (t) => {
  const old = fixture(t), next = fixture(t);
  const transcript = [{ type: "session", id: "s1" }, { type: "message", id: "m1", message: { role: "user", content: "Private historical question" } }];
  const diagnostic = [{ type: "session.started", sessionId: "s1", runId: "old-run", seq: 0 }, { type: "model.completed", sessionId: "s1", runId: "old-run", seq: 1, data: "Private diagnostic data" }];
  const bytes = diagnostic.map(JSON.stringify).join("\n") + "\n";
  old.put("agents/main/sessions/s1.jsonl", transcript.map(JSON.stringify).join("\n"));
  old.put("agents/main/sessions/s1.trajectory.jsonl", bytes);
  next.database("agents/main/agent/openclaw-agent.sqlite", "CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT); CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB); CREATE TABLE trajectory_runtime_events(session_id TEXT,seq INTEGER,event_json TEXT); CREATE TABLE session_transcript_active_events(session_id TEXT,active_position INTEGER,event_seq INTEGER)", (db) => {
    db.prepare("INSERT INTO session_nodes VALUES (?,?,?)").run("agent:main:main", "s1", "{}");
    transcript.forEach((entry, index) => db.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("s1", index, null, zstdCompressSync(Buffer.from(JSON.stringify(entry)))));
    db.exec("INSERT INTO session_transcript_active_events VALUES ('s1',0,1)");
    diagnostic.forEach((entry, index) => db.prepare("INSERT INTO trajectory_runtime_events VALUES (?,?,?)").run("s1", index, JSON.stringify({ ...entry, runId: "new-run" })));
  });
  const archive = path.join(next.stateDir, "agents/main/session-sqlite-import-archive/s1.trajectory.jsonl.imported-123");
  next.put(path.relative(next.stateDir, archive), bytes);
  const manifest = { manifestVersion: 3, completedAt: "2026-10-16T00:00:00Z", openClawVersion: "2026.10.4", targets: [{ agentId: "main", completedMoves: [{ kind: "trajectory", sourcePath: path.join(next.stateDir, "agents/main/sessions/s1.trajectory.jsonl"), archivePath: archive, artifact: { classification: "protected", reason: "unimported-or-unknown-history", disposal: { state: "retained" }, identity: { size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") } } }] }] };
  next.put("session-sqlite-migration-runs/receipt.json", manifest);
  const before = collectInventory(old), after = collectInventory(next), comparison = compareInventories(before, after);
  assert.equal(comparison.ok, true, JSON.stringify(comparison.failures));
  assert.equal(comparison.checked.transcriptEvents, 2);
  assert.equal(comparison.checked.trajectoryEvents, 2);
  assert.equal(comparison.checked.archivedTrajectoryEvents, 2, "new runtime diagnostics cannot masquerade as old canonical diagnostics");
  assert.equal(Object.values(after.activeTranscripts)[0].length, 1);
  const lostConversation = structuredClone(after); lostConversation.transcripts = {};
  assert.equal(compareInventories(before, lostConversation).ok, false, "diagnostic archives must never conceal conversation loss");
  manifest.failedAt = "2026-10-16T00:00:01Z";
  next.put("session-sqlite-migration-runs/receipt.json", manifest);
  assert.equal(compareInventories(before, collectInventory(next)).ok, false, "failed receipts do not certify archive retention");
  delete manifest.failedAt;
  next.put("session-sqlite-migration-runs/receipt.json", manifest);
  fs.writeFileSync(archive, bytes + "tampered");
  assert.throws(() => collectInventory(next), /recorded content identity/);
});

test("memory vectors compare by exact finite coordinates and invalid-vector regeneration requires recorded debt", (t) => {
  const coordinates = [0.25, -1.5, 2];
  const vector = Buffer.alloc(coordinates.length * 8);
  coordinates.forEach((value, index) => vector.writeDoubleLE(value, index * 8));
  assert.deepEqual(normalizeMemoryEmbedding(JSON.stringify(coordinates)).vector, normalizeMemoryEmbedding(vector).vector);
  assert.equal(normalizeMemoryEmbedding("not-json").valid, false);
  const old = fixture(t), next = fixture(t);
  old.database("memory/main.sqlite", "CREATE TABLE files(path TEXT,source TEXT,hash TEXT,size INTEGER); CREATE TABLE chunks(id TEXT,path TEXT,source TEXT,start_line INTEGER,end_line INTEGER,hash TEXT,model TEXT,text TEXT,embedding TEXT)", (db) => {
    db.exec("INSERT INTO files VALUES ('memory/note.md','memory','old-file-fingerprint',20); INSERT INTO chunks VALUES ('c1','memory/note.md','memory',1,2,'chunk-hash','lexical','Retained memory text','')");
  });
  next.database("agents/main/agent/openclaw-agent.sqlite", "CREATE TABLE memory_index_sources(path TEXT,source TEXT,hash TEXT,size INTEGER); CREATE TABLE memory_index_chunks(id TEXT,path TEXT,source TEXT,start_line INTEGER,end_line INTEGER,hash TEXT,model TEXT,text TEXT,embedding BLOB); CREATE TABLE memory_index_meta(key TEXT,value TEXT)", (db) => {
    db.exec("INSERT INTO memory_index_sources VALUES ('memory/note.md','memory','',20); INSERT INTO memory_index_chunks VALUES ('c1','memory/note.md','memory',1,2,'chunk-hash','lexical','Retained memory text',X''); INSERT INTO memory_index_meta VALUES ('memory_vector_rebuild_v1','1')");
  });
  const before = collectInventory(old), after = collectInventory(next);
  assert.equal(compareInventories(before, after).ok, true);
  const noDebt = structuredClone(after);
  for (const fact of Object.values(noDebt.memoryDerivations)) fact.vectorRebuildDebt = false;
  assert.equal(compareInventories(before, noDebt).ok, false);
  const changedText = structuredClone(after);
  const chunk = Object.values(changedText.entities).find((entity) => entity.category === "memory-chunk");
  chunk.fields["/text"] = "changed";
  assert.equal(compareInventories(before, changedText).ok, false, "regeneration debt cannot conceal lost authored text");
});

test("normalizes only documented false diagnostic flags and managed empty placeholders", (t) => {
  const old = fixture(t), next = fixture(t);
  old.put("openclaw.json", { agents: { entries: { main: {} } }, gateway: { controlUi: {}, trustedProxies: [] } });
  next.put("openclaw.json", { agents: { entries: { main: { workspace: next.workspaceDir } } }, gateway: { controlUi: { allowedOrigins: ["https://test.invalid"] }, trustedProxies: ["127.0.0.1", "::1"] } });
  const history = { jobId: "job", ts: 123, summary: "retained outcome", diagnostics: { summary: "retained diagnostics", entries: [{ ts: 123, source: "exec", severity: "info", message: "retained details", exitCode: 0, truncated: false }] } };
  old.database("state/openclaw.sqlite", "CREATE TABLE cron_run_logs(job_id TEXT,ts INTEGER,entry_json TEXT)", (db) => db.prepare("INSERT INTO cron_run_logs VALUES (?,?,?)").run("job", 123, JSON.stringify(history)));
  const canonical = structuredClone(history); delete canonical.diagnostics.entries[0].truncated;
  next.database("state/openclaw.sqlite", "CREATE TABLE cron_run_logs(job_id TEXT,ts INTEGER,entry_json TEXT)", (db) => db.prepare("INSERT INTO cron_run_logs VALUES (?,?,?)").run("job", 123, JSON.stringify(canonical)));
  const before = collectInventory(old), after = collectInventory(next);
  assert.equal(compareInventories(before, after).ok, true);
  const wrongProxy = structuredClone(after); wrongProxy.config["/gateway/trustedProxies"] = "changed";
  assert.equal(compareInventories(before, wrongProxy).ok, false);
  const missingDiagnostic = structuredClone(after);
  Object.values(missingDiagnostic.entities).find((entity) => entity.category === "cron-history").fields["/diagnostics/entries"] = "changed";
  assert.equal(compareInventories(before, missingDiagnostic).ok, false);
});

test("workspace owner moves prove every tool-note and heartbeat byte while preserving other AGENTS instructions", (t) => {
  const old = fixture(t), next = fixture(t);
  const oldAgents = "# Agent instructions\nPrivate owner instruction before tools.\n\n- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill\n\n## Tools\n\nSkills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.\n\n## Owner rules\nDo not lose this exact private owner rule.\n";
  const tools = "# Private tool notes\nCamera alpha points north.\n\n## Device notes\nRetain all these exact bytes.";
  const heartbeat = "# Private monitoring tasks\nCheck the original owner instruction every interval.\n";
  const newAgents = "# Agent instructions\nPrivate owner instruction before tools.\n\n- When you learn a lesson → update AGENTS.md or the relevant skill\n\n## Tools\n\n### Local notes\n\nSkills define how tools work. Keep environment-specific local notes in this section.\n\n### Local notes (migrated from TOOLS.md)\n\n" + tools + "\n\n## Owner rules\nDo not lose this exact private owner rule.\n";
  for (const item of [old, next]) item.put("openclaw.json", { agents: { entries: { main: { workspace: item.workspaceDir } } } });
  for (const [name, value] of [["AGENTS.md", oldAgents], ["TOOLS.md", tools], ["HEARTBEAT.md", heartbeat]])
    fs.writeFileSync(path.join(old.workspaceDir, name), value, { mode: name === "HEARTBEAT.md" ? 0o644 : 0o600 });
  fs.writeFileSync(path.join(next.workspaceDir, "AGENTS.md"), newAgents, { mode: 0o600 });
  const toolsSha = createHash("sha256").update(tools).digest("hex");
  const heartbeatSha = createHash("sha256").update(heartbeat).digest("hex");
  next.put(`backups/tools-md-migration/main-${toolsSha}.md`, tools);
  const job = { id: "heartbeat-main", agentId: "main", declarationKey: "heartbeat:main", enabled: true, payload: { kind: "heartbeat" }, schedule: { kind: "every", everyMs: 1800000 } };
  next.database("state/openclaw.sqlite", "CREATE TABLE cron_jobs(job_id TEXT,job_json TEXT); CREATE TABLE cron_job_scratch(job_id TEXT,content TEXT,source_sha256 TEXT,revision INTEGER)", (db) => {
    db.prepare("INSERT INTO cron_jobs VALUES (?,?)").run(job.id, JSON.stringify(job));
    db.prepare("INSERT INTO cron_job_scratch VALUES (?,?,?,?)").run(job.id, heartbeat, heartbeatSha, 1);
  });
  fs.chmodSync(path.join(next.stateDir, "state/openclaw.sqlite"), 0o600);
  const before = collectInventory(old), after = collectInventory(next);
  const comparison = compareInventories(before, after);
  assert.equal(comparison.ok, true, JSON.stringify(comparison.failures));
  assert.equal(comparison.checked.workspaceCanonicalMigrations, 3);
  assert.ok(!JSON.stringify(comparison).includes("Private owner instruction"));
  fs.writeFileSync(path.join(next.workspaceDir, "AGENTS.md"), newAgents.replace("Do not lose this exact private owner rule.", "Lost rule"));
  assert.equal(compareInventories(before, collectInventory(next)).ok, false, "arbitrary user instruction edits must remain failures");
  fs.writeFileSync(path.join(next.workspaceDir, "AGENTS.md"), newAgents.replace("Camera alpha points north.", "Changed tool note"));
  assert.equal(compareInventories(before, collectInventory(next)).ok, false, "archive alone cannot prove canonical tool-note retention");
  fs.writeFileSync(path.join(next.workspaceDir, "AGENTS.md"), newAgents);
  const altered = structuredClone(after);
  altered.workspaceMigrations["@workspace/HEARTBEAT.md"].canonicalScratch[0].everyMs = 60000;
  assert.equal(compareInventories(before, altered).ok, false, "different heartbeat cadence is not equivalent migration");
  altered.workspaceMigrations["@workspace/HEARTBEAT.md"].canonicalScratch[0].everyMs = 1800000;
  altered.workspaceMigrations["@workspace/HEARTBEAT.md"].canonicalScratch[0].contentSha256 = "changed";
  assert.equal(compareInventories(before, altered).ok, false, "a matching source receipt cannot conceal changed canonical scratch");
  const widened = structuredClone(after);
  widened.workspaceMigrations["@workspace/HEARTBEAT.md"].canonicalScratch[0].destinationMode = 0o666;
  assert.equal(compareInventories(before, widened).ok, false, "a canonical move must not widen access permissions");
});

test("provenance backfill may dirty derived fingerprints only with identical indexed content", (t) => {
  const old = fixture(t), next = fixture(t);
  for (const item of [old, next]) item.put("openclaw.json", {});
  old.database("memory/main.sqlite", "CREATE TABLE files(path TEXT,source TEXT,hash TEXT,size INTEGER); CREATE TABLE chunks(id TEXT,path TEXT,source TEXT,start_line INTEGER,end_line INTEGER,hash TEXT,text TEXT,embedding TEXT,updated_at INTEGER)", (db) => {
    db.exec("INSERT INTO files VALUES ('memory/note.md','memory','old-index-fingerprint',10); INSERT INTO chunks VALUES ('c1','memory/note.md','memory',1,2,'chunk-hash','Original authored memory','[]',123)");
  });
  next.database("agents/main/agent/openclaw-agent.sqlite", "CREATE TABLE memory_index_sources(path TEXT,source TEXT,hash TEXT,size INTEGER); CREATE TABLE memory_index_chunks(id TEXT,path TEXT,source TEXT,start_line INTEGER,end_line INTEGER,hash TEXT,text TEXT,embedding BLOB,updated_at INTEGER); CREATE TABLE memory_index_chunk_provenance(chunk_id TEXT,origin_class TEXT,session_kind TEXT,observed_at INTEGER)", (db) => {
    db.exec("INSERT INTO memory_index_sources VALUES ('memory/note.md','memory','',10); INSERT INTO memory_index_chunks VALUES ('c1','memory/note.md','memory',1,2,'chunk-hash','Original authored memory',X'',123); INSERT INTO memory_index_chunk_provenance VALUES ('c1','untrusted','unknown',123)");
  });
  const before = collectInventory(old), after = collectInventory(next);
  assert.equal(compareInventories(before, after).ok, true);
  const unsupported = structuredClone(after);
  for (const fact of Object.values(unsupported.memoryDerivations)) fact.legacyProvenanceBackfill = false;
  assert.equal(compareInventories(before, unsupported).ok, false, "an arbitrary fingerprint change is not a proven migration");
  const changed = structuredClone(after);
  Object.values(changed.entities).find((entry) => entry.category === "memory-chunk").fields["/text"] = "lost content";
  assert.equal(compareInventories(before, changed).ok, false, "backfill cannot hide lost memory content");
});

test('exact upstream webchat origin retirement requires canonical internal state and retained chat type', (t) => {
  const old=fixture(t),next=fixture(t);
  for(const item of [old,next])item.put('openclaw.json',{});
  const legacy={sessionId:'internal-session',origin:{provider:'webchat',surface:'webchat',chatType:'direct'},deliveryContext:{channel:'webchat'},lastChannel:'webchat',route:{channel:'webchat'},chatType:'direct',label:'Retain owner label'};
  old.put('agents/main/sessions/sessions.json',{'agent:main:main':legacy});
  const canonical={sessionId:legacy.sessionId,chatType:'direct',label:legacy.label,delivery:{kind:'internal'}};
  next.database('agents/main/agent/openclaw-agent.sqlite','CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT)',db=>db.prepare('INSERT INTO session_nodes VALUES (?,?,?)').run('agent:main:main',canonical.sessionId,JSON.stringify(canonical)));
  const before=collectInventory(old);
  const setNext=entry=>{
    const db=new DatabaseSync(path.join(next.stateDir,'agents/main/agent/openclaw-agent.sqlite'));
    try{db.prepare('UPDATE session_nodes SET entry_json=?').run(JSON.stringify(entry));}finally{db.close();}
    return collectInventory(next);
  };
  assert.equal(before.collectorRevision,8);
  assert.equal(before.coverage.sessionNormalizations.length,1);
  assert.match(before.coverage.sessionNormalizations[0].reason,/constant webchat\/direct origin/);
  assert.equal(compareInventories(before,setNext(canonical)).ok,true);
  for(const changed of [
    {...canonical,delivery:undefined},
    {...canonical,delivery:{kind:'none'}},
    {...canonical,chatType:'group'},
    {...canonical,label:'Changed owner label'},
  ])assert.equal(compareInventories(before,setNext(changed)).ok,false,'a missing replacement marker or changed authored metadata must remain a failure');
});

test('internal-webchat exception cannot hide additional origin data or an addressed/external route', (t) => {
  for(const extra of [
    {origin:{provider:'webchat',surface:'webchat',chatType:'direct',label:'Authored origin label'}},
    {origin:{provider:'webchat',surface:'webchat',chatType:'direct',from:'Authored origin identity'}},
    {origin:{provider:'telegram',surface:'telegram',chatType:'direct'}},
    {deliveryContext:{channel:'webchat',to:'authored-destination'}},
    {deliveryContext:{channel:'telegram',to:'authored-destination'}},
    {route:{channel:'webchat',accountId:'authored-account'}},
    {lastTo:'authored-destination'},
  ]){
    const old=fixture(t),next=fixture(t);
    for(const item of [old,next])item.put('openclaw.json',{});
    const legacy={sessionId:'guarded-session',origin:{provider:'webchat',surface:'webchat',chatType:'direct'},deliveryContext:{channel:'webchat'},route:{channel:'webchat'},chatType:'direct',...extra};
    old.put('agents/main/sessions/sessions.json',{'agent:main:main':legacy});
    next.database('agents/main/agent/openclaw-agent.sqlite','CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT)',db=>db.prepare('INSERT INTO session_nodes VALUES (?,?,?)').run('agent:main:main',legacy.sessionId,JSON.stringify({sessionId:legacy.sessionId,chatType:'direct',delivery:{kind:'internal'}})));
    const before=collectInventory(old);
    assert.equal(before.coverage.sessionNormalizations.length,0);
    assert.equal(compareInventories(before,collectInventory(next)).ok,false,'authored origin/route facts cannot be treated as the constant unaddressed webchat case');
  }
});

test('canonical external delivery origin is authoritative and stale legacy duplicates cannot hide its loss', (t) => {
  const old=fixture(t),next=fixture(t);
  for(const item of [old,next])item.put('openclaw.json',{});
  const origin={provider:'telegram',surface:'telegram',chatType:'direct',to:'synthetic-recipient',accountId:'synthetic-account',label:'Retain origin label'};
  const legacy={sessionId:'external-session',chatType:'direct',origin};
  old.put('agents/main/sessions/sessions.json',{'agent:main:main':legacy});
  const canonical={...legacy,delivery:{kind:'external',route:{channel:'telegram',target:{to:'synthetic-recipient'}},context:{channel:'telegram',to:'synthetic-recipient'},origin:{...origin}}};
  next.database('agents/main/agent/openclaw-agent.sqlite','CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT,entry_json TEXT)',db=>db.prepare('INSERT INTO session_nodes VALUES (?,?,?)').run('agent:main:main',legacy.sessionId,JSON.stringify(canonical)));
  const before=collectInventory(old);
  assert.equal(compareInventories(before,collectInventory(next)).ok,true);
  for(const alteration of [{...origin,label:'Lost origin label'},{...origin,to:'different-recipient'},{}]){
    const changed=structuredClone(canonical);changed.delivery.origin=alteration;
    const db=new DatabaseSync(path.join(next.stateDir,'agents/main/agent/openclaw-agent.sqlite'));
    try{db.prepare('UPDATE session_nodes SET entry_json=?').run(JSON.stringify(changed));}finally{db.close();}
    assert.equal(compareInventories(before,collectInventory(next)).ok,false,'canonical nested origin must be checked even if the old duplicate remains unchanged');
  }
});
