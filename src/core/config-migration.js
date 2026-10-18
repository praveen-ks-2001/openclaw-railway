import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Read before any bridge/Doctor process. A config write stamp can remain old
// even after its databases have crossed the release that changed the defaults.
// null means no database exists; "unknown" prevents a guessed legacy rewrite.
export function readSourceStateSchema(stateDir) {
  const filename = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(filename)) return null;
  let database;
  try {
    database = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA trusted_schema=OFF");
    const version = database.prepare("PRAGMA user_version").get().user_version;
    const metadata = database.prepare("SELECT role,schema_version FROM schema_meta WHERE meta_key='primary'").get();
    return Number.isInteger(version) && version >= 1 && metadata?.role === "global" &&
      metadata.schema_version === version ? version : "unknown";
  } catch {
    return "unknown";
  } finally {
    database?.close();
  }
}

function hasLegacyOptInDefaults(source, sourceStateSchema) {
  // Measured stable 6.6.6/7.1 use schema1; 8.1 first shipped schema15. Do not
  // guess at intermediate beta/dev schemas, or disable already-modern defaults
  // merely because lastTouchedVersion or some config keys remained old.
  if (sourceStateSchema != null && sourceStateSchema !== 1) return false;
  // Stable 2026.8.1 first enabled dreaming and automatic Skill Workshop work
  // by default. Evidence: official CHANGELOG/2026.8.1.md (#114819, #115576),
  // plus the actual 6.6.6/10.4 config resolvers. Missing metadata is not proof
  // of an old runtime. Neither is stale metadata on an already-canonical config.
  const version = source?.meta?.lastTouchedVersion;
  const release = typeof version === "string" && /^(2026)\.(\d+)\.(\d+)$/.exec(version);
  if (!release) return false;
  const month = Number(release[2]), patch = Number(release[3]);
  if (month < 1 || month > 12 || patch < 1 || month > 8 || (month === 8 && patch >= 1)) return false;
  const agents = source.agents;
  return !isRecord(agents?.entries) || Array.isArray(agents?.list) ||
    isRecord(source.memorySearch) || isRecord(agents?.defaults?.memorySearch) ||
    Object.values(agents?.entries || {}).some((agent) => isRecord(agent?.memorySearch));
}

function preserveLegacyConcurrencyDefault(result, source, sourceStateSchema) {
  if (!hasLegacyOptInDefaults(source, sourceStateSchema)) return;
  // 2026.6.6 resolves an absent top-level agent limit to4. The target resolves
  // it to max(8, availableParallelism()*4), which would silently increase the
  // work admitted on an existing Railway service. Subagents remain8 upstream.
  const containers = [source.agents, source.agents?.defaults, result.agents, result.agents?.defaults];
  if (containers.some(value => value !== undefined && !isRecord(value))) return;
  if (Object.hasOwn(source.agents?.defaults || {}, "maxConcurrent")) return;
  result.agents ||= {};
  result.agents.defaults ||= {};
  // Source was captured under exclusive ownership before any bridge/Doctor.
  // An intermediate Doctor may have materialized its newer implicit default;
  // the measured old effective limit remains authoritative in this one case.
  result.agents.defaults.maxConcurrent = 4;
}

function preserveLegacyBackgroundDefaults(result, source, sourceStateSchema) {
  if (!hasLegacyOptInDefaults(source, sourceStateSchema)) return;
  // Do not repair malformed containers or replace explicit operator choices.
  // Validation should surface malformed shapes through the normal Doctor path.
  const validContainers = (values) => values.every((value) => value === undefined || isRecord(value));
  const sourceMemory = source.plugins?.entries?.["memory-core"];
  const memory = result.plugins?.entries?.["memory-core"];
  const memorySlot = source.plugins?.slots?.memory;
  const currentMemorySlot = result.plugins?.slots?.memory;
  const activeCore = (memorySlot === undefined || memorySlot === "memory-core") &&
    (currentMemorySlot === undefined || currentMemorySlot === "memory-core") &&
    source.plugins?.enabled !== false && sourceMemory?.enabled !== false &&
    result.plugins?.enabled !== false && memory?.enabled !== false;
  if (activeCore && validContainers([
    source.plugins, source.plugins?.entries, sourceMemory, sourceMemory?.config, sourceMemory?.config?.dreaming,
    result.plugins, result.plugins?.entries, memory, memory?.config, memory?.config?.dreaming,
  ]) && !Object.hasOwn(sourceMemory?.config?.dreaming || {}, "enabled") &&
      !Object.hasOwn(memory?.config?.dreaming || {}, "enabled")) {
    result.plugins ||= {};
    result.plugins.entries ||= {};
    result.plugins.entries["memory-core"] ||= {};
    result.plugins.entries["memory-core"].config ||= {};
    result.plugins.entries["memory-core"].config.dreaming ||= {};
    result.plugins.entries["memory-core"].config.dreaming.enabled = false;
  }

  const sourceWorkshop = source.skills?.workshop;
  const workshop = result.skills?.workshop;
  if (!validContainers([source.skills, sourceWorkshop, sourceWorkshop?.autonomous,
    result.skills, workshop, workshop?.autonomous])) return;
  const needsMode = !Object.hasOwn(sourceWorkshop?.autonomous || {}, "mode") &&
    !Object.hasOwn(sourceWorkshop?.autonomous || {}, "enabled") &&
    !Object.hasOwn(workshop?.autonomous || {}, "mode") &&
    !Object.hasOwn(workshop?.autonomous || {}, "enabled");
  const needsApproval = !Object.hasOwn(sourceWorkshop || {}, "approvalPolicy") &&
    !Object.hasOwn(workshop || {}, "approvalPolicy");
  if (!needsMode && !needsApproval) return;
  result.skills ||= {};
  result.skills.workshop ||= {};
  if (needsMode) {
    result.skills.workshop.autonomous ||= {};
    result.skills.workshop.autonomous.mode = "off";
  }
  if (needsApproval) result.skills.workshop.approvalPolicy = "pending";
}

export function migrateWrapperConfig(config, { publicDomain, localPort, sourceConfig = config, sourceStateSchema } = {}) {
  const result = structuredClone(config);
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("OpenClaw configuration must be an object");
  // Capture sourceConfig before any intermediate Doctor changes its version or
  // roster. Fresh/newer/ambiguous installs retain upstream defaults.
  preserveLegacyConcurrencyDefault(result, sourceConfig, sourceStateSchema);
  preserveLegacyBackgroundDefaults(result, sourceConfig, sourceStateSchema);
  // Match the official Doctor boolean migration before any other target CLI
  // validates the config. Explicit modern modes retain precedence.
  const autonomous = result.skills?.workshop?.autonomous;
  if (isRecord(autonomous) && typeof autonomous.enabled === "boolean") {
    if (!Object.hasOwn(autonomous, "mode")) autonomous.mode = autonomous.enabled ? "propose" : "off";
    delete autonomous.enabled;
  }
  result.gateway ||= {};
  result.gateway.controlUi ||= {};
  delete result.gateway.controlUi.allowInsecureAuth;
  delete result.gateway.controlUi.dangerouslyDisableDeviceAuth;
  result.gateway.trustedProxies = ["127.0.0.1", "::1"];
  if (publicDomain) {
    const origin = new URL(`https://${publicDomain}`).origin;
    const previous = result.gateway.controlUi.allowedOrigins || [];
    if (!Array.isArray(previous))
      throw new Error("gateway.controlUi.allowedOrigins must be an array");
    // Existing wildcard policies can support custom domains unknown to Railway.
    // Retain them exactly; adding the known host would be redundant and
    // narrowing the inherited policy would change existing browser behavior.
    if (!previous.includes("*")) {
      result.gateway.controlUi.allowedOrigins = [
        ...new Set([...previous, origin]),
      ];
    }
    result.gateway.publicOrigin ||= origin;
  } else if (
    localPort &&
    result.gateway.controlUi.allowedOrigins === undefined
  ) {
    result.gateway.controlUi.allowedOrigins = [
      `http://localhost:${localPort}`,
      `http://127.0.0.1:${localPort}`,
    ];
  }
  const mattermost = result.channels?.mattermost;
  if (isRecord(mattermost)) {
    if (Object.hasOwn(mattermost, "url")) { mattermost.baseUrl ??= mattermost.url; delete mattermost.url; }
    if (Object.hasOwn(mattermost, "token")) { mattermost.botToken ??= mattermost.token; delete mattermost.token; }
    // The former wrapper supplied this invalid selector. The target manifest is
    // strict and has no team equivalent; the migration owner retains the full
    // original config and durable snapshot before persisting this migration.
    delete mattermost.team;
  }
  // The wrapper previously wrote Discord's DM policy under dm.policy. The
  // current channel schema owns it at the top level; retain the chosen policy.
  const discord = result.channels?.discord;
  if (discord?.dm && Object.hasOwn(discord.dm, "policy")) {
    discord.dmPolicy ??= discord.dm.policy;
    delete discord.dm.policy;
    if (Object.keys(discord.dm).length === 0) delete discord.dm;
  }
  return result;
}

// Normalized wrapper archives contain one workspace and agent databases under
// state/agents/<id>/agent. Rewrite those known roots rather than following paths
// authored on the source deployment during staged migration.
export function relocateImportedConfig(config, { stateDir, workspaceDir }) {
  const result = structuredClone(config);
  result.agents ||= {};
  result.agents.defaults ||= {};
  const records = [
    ...Object.entries(result.agents.entries || {}),
    ...(result.agents.list || []).map((a) => [a.id, a]),
  ];
  const workspaces = new Set(
    [
      result.agents.defaults.workspace,
      ...records.map(([, a]) => a.workspace),
    ].filter(Boolean),
  );
  if (workspaces.size > 1)
    throw new Error(
      "Multiple distinct agent workspaces require the OpenClaw backup CLI for restoration",
    );
  for (const [id, agent] of records) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new Error(
        "Unsupported agent path identifier in imported configuration",
      );
    if (agent.agentDir) {
      const expected = `agents/${id}/agent`;
      const current = String(agent.agentDir);
      const target = path.join(stateDir, "agents", id, "agent");
      if (
        current !== target &&
        current !== expected &&
        !current.endsWith(`/${expected}`)
      )
        throw new Error(
          "External agent database paths require the OpenClaw backup CLI for restoration",
        );
      agent.agentDir = target;
    }
    if (agent.workspace) agent.workspace = workspaceDir;
  }
  result.agents.defaults.workspace = workspaceDir;
  return result;
}
