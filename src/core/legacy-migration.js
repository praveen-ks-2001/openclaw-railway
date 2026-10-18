import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";

const BRIDGE_VERSION = "2026.9.5";
// Measured from this exact official artifact's openclaw.schemaVersions metadata.
// Never let the intermediate executable discover newer SQLite state itself.
const BRIDGE_SCHEMA = { global: 17, agent: 21 };

function newerRelease(value) {
  if (value == null) return false;
  if (typeof value !== "string" || !/^\d{4}\.\d+\.\d+(?:-[\w.-]+)?$/.test(value))
    throw new Error("Unrecognized database release metadata");
  const recorded = value.split("-")[0].split(".").map(Number);
  const bridge = BRIDGE_VERSION.split(".").map(Number);
  for (let index = 0; index < recorded.length; index++) {
    if (recorded[index] !== bridge[index]) return recorded[index] > bridge[index];
  }
  return false;
}

function assertBridgeSafe({ stateDir, configPath, env }) {
  const agentPaths = new Set();
  const addAgentDir = (value) => {
    if (value == null || value === "") return;
    if (typeof value !== "string" || value.includes("$") || value.includes("\0"))
      throw new Error("Unresolved agent storage path");
    const expanded = value === "~" || value.startsWith("~/")
      ? path.join(env.HOME || os.homedir(), value.slice(2)) : value;
    if (!path.isAbsolute(expanded)) throw new Error("Ambiguous relative agent storage path");
    agentPaths.add(path.join(expanded, "openclaw-agent.sqlite"));
  };
  function inspect(filename, role, collectAgents = false) {
    if (!fs.existsSync(filename)) return;
    const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema=OFF");
      const pragma = db.prepare("PRAGMA user_version").get().user_version;
      const hasMeta = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_meta'").get();
      const metadata = hasMeta
        ? db.prepare("SELECT role, schema_version, app_version FROM schema_meta WHERE meta_key='primary'").get()
        : null;
      // A genuinely empty database is safe for the bridge to initialize. A
      // populated unversioned/ambiguous store must never be guessed at.
      const empty = pragma === 0 && !metadata && !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
      if (!empty && (!Number.isInteger(pragma) || pragma < 1 || pragma > BRIDGE_SCHEMA[role] ||
          metadata?.role !== role || metadata.schema_version !== pragma || newerRelease(metadata.app_version)))
        throw new Error(`Database is newer than or incompatible with the ${BRIDGE_VERSION} bridge`);
      if (collectAgents && db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_databases'").get()) {
        for (const row of db.prepare("SELECT path FROM agent_databases").all()) {
          if (typeof row.path !== "string" || row.path.includes("\0") || row.path.includes("$"))
            throw new Error("Unrecognized registered agent storage path");
          agentPaths.add(path.resolve(stateDir, row.path));
        }
      }
    } finally {
      db.close();
    }
  }
  try {
    inspect(path.join(stateDir, "state", "openclaw.sqlite"), "global", true);
    if (fs.existsSync(configPath)) {
      const cfg = JSON5.parse(fs.readFileSync(configPath, "utf8"));
      if (newerRelease(cfg.meta?.lastTouchedVersion)) throw new Error("Config was written by a newer release");
      if (cfg.session?.store) throw new Error("Custom session stores need explicit migration");
      const pending = [cfg];
      while (pending.length) {
        const object = pending.pop();
        if (!object || typeof object !== "object") continue;
        if (Object.hasOwn(object, "$include")) throw new Error("Config includes need explicit migration");
        for (const value of Object.values(object)) if (value && typeof value === "object") pending.push(value);
      }
      const list = cfg.agents?.list;
      for (const agent of [
        ...(Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : []),
        ...Object.values(cfg.agents?.entries || {}),
      ]) addAgentDir(agent?.agentDir);
    }
    addAgentDir(env.OPENCLAW_AGENT_DIR);
    addAgentDir(env.PI_CODING_AGENT_DIR);
    const agentsRoot = path.join(stateDir, "agents");
    if (fs.existsSync(agentsRoot)) for (const agent of fs.readdirSync(agentsRoot)) {
      agentPaths.add(path.join(agentsRoot, agent, "agent", "openclaw-agent.sqlite"));
    }
    for (const filename of agentPaths) inspect(filename, "agent");
  } catch {
    throw new Error(
      `The retired plugin index coexists with state that cannot safely be opened by OpenClaw ${BRIDGE_VERSION}. No intermediate CLI was started and the original data was retained. Preserve the recovery snapshot and migrate this mixed/newer layout explicitly with the matching OpenClaw release.`,
    );
  }
}

// Current OpenClaw deliberately no longer reads this retired registry. The
// supported intermediate Doctor migrates it before the target CLI touches it.
export async function migrateRetiredPluginIndex({
  stateDir,
  toolsDir,
  node,
  run,
  log = () => {},
  configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json"),
  env = process.env,
}) {
  if (!fs.existsSync(path.join(stateDir, "plugins", "installs.json")))
    return { migrated: false };
  assertBridgeSafe({ stateDir, configPath, env });
  const prefix = path.join(toolsDir, BRIDGE_VERSION);
  const root = path.join(prefix, "node_modules", "openclaw");
  const entry = path.join(root, "dist", "entry.js");
  const complete = path.join(prefix, ".wrapper-install-complete");
  const cached = () => {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      return (
        fs.existsSync(complete) &&
        metadata.version === BRIDGE_VERSION &&
        metadata.openclaw?.schemaVersions?.state === BRIDGE_SCHEMA.global &&
        metadata.openclaw?.schemaVersions?.agent === BRIDGE_SCHEMA.agent
      );
    } catch {
      return false;
    }
  };
  if (!cached()) {
    fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
    log(
      `Installing the official ${BRIDGE_VERSION} migration tool for the retired plugin registry`,
    );
    const install = await run(
      "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--omit=dev",
        "--engine-strict",
        "--no-audit",
        "--no-fund",
        `openclaw@${BRIDGE_VERSION}`,
      ],
      { timeoutMs: 300_000 },
    );
    if (install.code !== 0)
      throw new Error(
        "The supported intermediate migration tool could not be installed; the pre-upgrade snapshot was retained",
      );
    const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (metadata.version !== BRIDGE_VERSION ||
        metadata.openclaw?.schemaVersions?.state !== BRIDGE_SCHEMA.global ||
        metadata.openclaw?.schemaVersions?.agent !== BRIDGE_SCHEMA.agent)
      throw new Error("Unexpected intermediate migration package version");
    assertBridgeSafe({ stateDir, configPath, env });
    const verified = await run(node, [entry, "--version"]);
    if (verified.code !== 0)
      throw new Error("The intermediate migration CLI could not start");
    fs.writeFileSync(complete, BRIDGE_VERSION, { mode: 0o600 });
  }
  assertBridgeSafe({ stateDir, configPath, env });
  const result = await run(
    node,
    [entry, "doctor", "--non-interactive", "--fix"],
    { timeoutMs: 300_000 },
  );
  if (
    result.code !== 0 ||
    fs.existsSync(path.join(stateDir, "plugins", "installs.json"))
  )
    throw new Error(
      "Intermediate migration did not finish; restore the pre-upgrade snapshot before retrying if needed",
    );
  return { migrated: true, version: BRIDGE_VERSION };
}
