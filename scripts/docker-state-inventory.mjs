// Read-only, dependency-free state evidence for disposable Docker upgrade tests.
// Run inside either image: docker exec -i NAME node --input-type=module - < this-file
// Compare on the host: node this-file --compare before.json after.json
// Values (including credentials, prompts and messages) are never emitted: only hashes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (value instanceof Uint8Array) return { binarySha256: hash(value) };
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const digest = (value) => hash(JSON.stringify(canonical(value)));
const identifier = (value) => digest(value);
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
function readJson(filename) {
  return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : null;
}
function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

// Match the official target reader's state-root anchoring, not the process cwd:
// src/state/openclaw-state-db.paths.ts resolves relative registry rows beside
// the parent of a canonical state/openclaw.sqlite, or beside a custom DB itself.
// Absolute legacy paths and state-relative target paths can identify one file.
export function resolveRegisteredDatabasePath(registryDatabasePath, storedPath) {
  if (typeof storedPath !== "string" || !storedPath) throw new Error("Agent database registry has an invalid path");
  const directory = path.dirname(path.resolve(registryDatabasePath));
  const root = path.basename(directory) === "state" ? path.dirname(directory) : directory;
  return path.resolve(path.isAbsolute(storedPath) ? storedPath : path.join(root, storedPath));
}

// Official memory-host storage uses finite binary64 little-endian coordinates;
// its migration accepts finite JSON arrays and marks invalid legacy vectors for
// rebuild. Keep invalid inputs distinct until the comparison verifies that debt.
export function normalizeMemoryEmbedding(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number" && Number.isFinite(n)))
        return { encoding: "json", vector: parsed, valid: true };
    } catch {}
    return { encoding: "invalid-json", vector: [], valid: false };
  }
  if (value instanceof Uint8Array && value.byteLength % 8 === 0) {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const vector = [];
    for (let offset = 0; offset < value.byteLength; offset += 8) {
      const n = view.getFloat64(offset, true);
      if (!Number.isFinite(n)) return { encoding: "invalid-binary", valid: false };
      vector.push(n);
    }
    return { encoding: "binary64-le", vector, valid: true };
  }
  return { encoding: "unknown", valid: false };
}

// These two exact managed-template instructions are rewritten by the official
// TOOLS.md migration. Every other instruction byte remains part of the hash.
export function normalizeManagedAgentsInstructions(content) {
  let result = content.replaceAll(
    "Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.",
    "Skills define how tools work. Keep environment-specific local notes in this section.",
  ).replaceAll(
    "- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill",
    "- When you learn a lesson → update AGENTS.md or the relevant skill",
  );
  if (result !== content && /^## Tools\r?\n/m.test(result)) {
    const section = result.split(/^## Tools\r?\n/m)[1]?.split(/^## /m)[0];
    if (!/^### Local notes(?:\s|$)/m.test(section || ""))
      result = result.replace(/^(## Tools\r?\n)/m, "$1\n### Local notes\n");
  }
  return result;
}
function walk(root, visit, skip = () => false, prefix = "") {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skip(relative, entry)) continue;
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) walk(filename, visit, skip, relative);
    else visit(filename, relative, entry);
  }
}

// Normalize measured structural migrations while retaining every authored value.
// This is comparison logic only: it never edits the deployment configuration.
export function normalizeConfiguration(config) {
  const normalized = structuredClone(config);
  const changes = [];
  const note = (path, reason) => changes.push({ path, reason });
  function mergeMissing(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
      if (target[key] === undefined) target[key] = structuredClone(value);
      else if (plain(target[key]) && plain(value)) mergeMissing(target[key], value);
    }
    return target;
  }
  const agents = normalized.agents;
  if (Array.isArray(agents?.list)) {
    agents.entries ||= {};
    for (const { id, ...agent } of agents.list) agents.entries[id] = agent;
    delete agents.list;
    note("agents.list", "canonical agent roster");
  }
  const defaults = agents?.defaults;
  if (typeof defaults?.model === "string") defaults.model = { primary: defaults.model };
  const legacyMemory = defaults?.memorySearch || normalized.memorySearch;
  if (legacyMemory) {
    normalized.memory ||= {};
    const search = structuredClone(normalized.memory.search || {});
    mergeMissing(search, defaults?.memorySearch);
    mergeMissing(search, normalized.memorySearch);
    normalized.memory.search = search;
    if (defaults) delete defaults.memorySearch;
    delete normalized.memorySearch;
    note("memory.search", "moved legacy default memory owner without changing values");
  }
  const searches = [normalized.memory?.search];
  for (const [id, agent] of Object.entries(agents?.entries || {})) {
    if (agent.memorySearch) {
      agent.memory ||= {};
      agent.memory.search = mergeMissing(structuredClone(agent.memory.search || {}), agent.memorySearch);
      delete agent.memorySearch;
      note(`agents.entries.${id}.memory.search`, "moved per-agent memory owner without changing values");
    }
    searches.push(agent.memory?.search);
  }
  for (const search of searches) if (plain(search)) for (const [legacy, parent, field] of [["chunkSize", "chunking", "tokens"], ["chunkOverlap", "chunking", "overlap"], ["maxResults", "query", "maxResults"]]) {
    if (search[legacy] === undefined) continue;
    // Keep conflicting aliases visible; only represent an unchanged value.
    if (search[parent] === undefined) search[parent] = {};
    if (plain(search[parent]) && (search[parent][field] === undefined || digest(search[parent][field]) === digest(search[legacy]))) {
      search[parent][field] = search[legacy];
      delete search[legacy];
    }
  }

  // Upstream copies the legacy default map's allowlist while preserving alias,
  // runtime and parameter metadata. Empty objects carried membership only.
  const models = defaults?.models;
  const marker = normalized.meta?.migrations?.modelPolicyAllowlist === true;
  const explicitPolicy = plain(defaults?.modelPolicy);
  const refs = plain(models) ? Object.keys(models).filter((ref) => ref.trim()) : [];
  const knownRef = (ref) => /^(?:[^/\s*]+\/)+(?:[^/\s*]+|\*)$/.test(ref) || ["openrouter:auto", "openrouter:free"].includes(ref);
  const representableLegacy = !marker && !explicitPolicy && refs.length > 0 && refs.every(knownRef);
  if (representableLegacy) {
    defaults.modelPolicy = { allow: refs };
    note("agents.defaults.modelPolicy.allow", "materialized whole legacy restriction; aliases remain in models");
  }
  if (Array.isArray(defaults?.modelPolicy?.allow)) defaults.modelPolicy.allow = [...new Set(defaults.modelPolicy.allow)].sort();
  for (const agent of Object.values(agents?.entries || {})) if (Array.isArray(agent.modelPolicy?.allow)) agent.modelPolicy.allow = [...new Set(agent.modelPolicy.allow)].sort();
  if (plain(models) && (representableLegacy || marker || Object.hasOwn(defaults?.modelPolicy || {}, "allow"))) {
    for (const [ref, value] of Object.entries(models)) if (plain(value) && Object.keys(value).length === 0) delete models[ref];
    if (!Object.keys(models).length) delete defaults.models;
  }

  for (const name of ["discord", "slack"]) {
    const channel = normalized.channels?.[name];
    for (const [suffix, entry] of [["", channel], ...Object.entries(channel?.accounts || {}).map(([id, entry]) => [`.accounts.${id}`, entry])]) {
      if (!plain(entry?.dm)) continue;
      for (const [legacy, canonicalKey] of [["policy", "dmPolicy"], ["allowFrom", "allowFrom"]]) {
        if (entry.dm[legacy] === undefined) continue;
        const equivalent = (left, right) => legacy === "allowFrom" && Array.isArray(left) && Array.isArray(right)
          ? digest(left.map(String).map((s) => s.trim()).filter(Boolean)) === digest(right.map(String).map((s) => s.trim()).filter(Boolean))
          : digest(left) === digest(right);
        if (entry[canonicalKey] === undefined || equivalent(entry[canonicalKey], entry.dm[legacy])) {
          entry[canonicalKey] ??= entry.dm[legacy];
          delete entry.dm[legacy];
          note(`channels.${name}${suffix}.${canonicalKey}`, "promoted equal/absent canonical DM alias");
        }
      }
      if (!Object.keys(entry.dm).length) delete entry.dm;
    }
  }
  const tailscale = normalized.gateway?.tailscale;
  if (Object.hasOwn(tailscale || {}, "resetOnExit")) {
    if ((tailscale.mode || "off") === "off" || tailscale.resetOnExit === true) {
      delete tailscale.resetOnExit;
      note("gateway.tailscale.resetOnExit", "retired field was inert while off, or enabled lifecycle cleanup now automatic");
    } else note("gateway.tailscale.resetOnExit", "UNREPRESENTABLE retained-route preference: keep comparison failure visible");
  }
  if (normalized.gateway?.controlUi) {
    delete normalized.gateway.controlUi.allowInsecureAuth;
    delete normalized.gateway.controlUi.dangerouslyDisableDeviceAuth;
  }
  if (Array.isArray(normalized.gateway?.trustedProxies) &&
      (normalized.gateway.trustedProxies.length === 0 || digest(normalized.gateway.trustedProxies) === digest(["127.0.0.1"]))) {
    normalized.gateway.trustedProxies = ["127.0.0.1", "::1"];
    note("gateway.trustedProxies", "wrapper explicitly owns the loopback proxy hop; empty old default becomes its two loopback addresses");
  }
  delete normalized.meta;
  delete normalized.wizard;
  return { config: normalized, changes };
}

// Exact 2026.10.4 owners: src/infra/state-migrations.legacy-session-store.ts
// normalizeLegacySessionEntryDelivery and src/utils/delivery-context.shared.ts
// normalizeSessionDeliveryState/projectSessionDeliveryFields. Internal webchat
// is a non-deliverable closed state; external origins remain fully authored data.
export function projectSessionMetadata(entry) {
  const normalized = structuredClone(entry || {});
  let reason = null;
  const delivery = normalized.delivery;
  const canonical = plain(delivery) && (
    delivery.kind === "none" || delivery.kind === "internal" ||
    (delivery.kind === "external" && plain(delivery.route) && plain(delivery.context) && plain(delivery.origin))
  );
  if (canonical) {
    // The actual target reader derives these compatibility fields exclusively
    // from delivery. Retired duplicate fields cannot conceal canonical loss.
    delete normalized.origin;
    delete normalized.channel;
    if (delivery.kind === "external") {
      normalized.origin = structuredClone(delivery.origin);
      normalized.channel = delivery.context.channel ?? delivery.origin.provider;
    }
    return { entry: normalized, deliveryKind: delivery.kind, reason };
  }
  const exactKeys = (value, expected) => plain(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
  const webchatContext = value => value === undefined ||
    (exactKeys(value, ["channel"]) && value.channel === "webchat");
  const origin = normalized.origin;
  // Be deliberately narrower than the upstream migrator: never excuse extra
  // labels, addresses, accounts, threads, channel facts, or an external target.
  const exactInternalWebchat = delivery === undefined &&
    exactKeys(origin, ["provider", "surface", "chatType"]) &&
    origin.provider === "webchat" && origin.surface === "webchat" && origin.chatType === "direct" &&
    webchatContext(normalized.route) && webchatContext(normalized.deliveryContext) &&
    (normalized.channel === undefined || normalized.channel === "webchat") &&
    (normalized.lastChannel === undefined || normalized.lastChannel === "webchat") &&
    ["lastTo", "lastAccountId", "lastThreadId"].every(key => normalized[key] === undefined) &&
    (normalized.chatType === undefined || normalized.chatType === "direct");
  if (exactInternalWebchat) {
    delete normalized.origin;
    delete normalized.channel;
    normalized.chatType = "direct";
    // Require the replacement state in the target. Missing origin alone must
    // never pass as proof that the documented migration actually occurred.
    normalized.delivery = { kind: "internal" };
    reason = "OpenClaw2026.10.4 replaces only the constant webchat/direct origin and unaddressed webchat route with delivery.kind=internal; direct chatType remains required";
    return { entry: normalized, deliveryKind: "internal", reason };
  }
  return { entry: normalized, reason };
}

export function collectInventory(options = {}) {
  const state = path.resolve(options.stateDir || process.env.OPENCLAW_STATE_DIR || "/data/.openclaw");
  const workspace = path.resolve(options.workspaceDir || process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace");
  const configPath = options.configPath || process.env.OPENCLAW_CONFIG_PATH || path.join(state, "openclaw.json");
  const result = {
    format: 1,
    collectorRevision: 8,
    runtime: process.version,
    config: {},
    workspaceFiles: {},
    workspaceMigrations: {},
    durableFiles: {},
    entities: {},
    transcripts: {},
    trajectories: {},
    archivedTrajectories: {},
    activeTranscripts: {},
    memoryDerivations: {},
    databases: {},
    coverage: { categories: {}, unprojectedNonemptyTables: [], warnings: [], configurationNormalizations: [], sessionNormalizations: [], trajectorySources: {} },
  };
  const sessionKeysByAgent = new Map();
  const transcriptKeysByAgent = new Map();
  const protectedDiagnosticArtifacts = new Map();
  walk(path.join(state, "session-sqlite-migration-runs"), (filename, relative, entry) => {
    if (!entry.isFile() || !relative.endsWith(".json")) return;
    const manifest = readJson(filename);
    if (![3, 4].includes(manifest?.manifestVersion) || !manifest.completedAt || manifest.failedAt) return;
    for (const target of manifest.targets || []) for (const move of target.completedMoves || []) {
      const artifact = move.artifact;
      if (move.kind !== "trajectory" || artifact?.classification !== "protected" ||
          artifact.reason !== "unimported-or-unknown-history" || artifact.disposal?.state !== "retained") continue;
      const agentRoot = path.join(state, "agents", target.agentId || "");
      const archiveRoot = path.join(agentRoot, "session-sqlite-import-archive");
      const archive = path.resolve(move.archivePath || "/");
      const source = path.resolve(move.sourcePath || "/");
      if (!target.agentId || path.dirname(archive) !== path.resolve(archiveRoot) ||
          path.dirname(source) !== path.resolve(agentRoot, "sessions") ||
          !/\.trajectory(?:\.jsonl|-path\.json)$/.test(source) || !fs.existsSync(archive)) continue;
      const bytes = fs.readFileSync(archive);
      if (bytes.length !== artifact.identity?.size || hash(bytes) !== artifact.identity?.sha256)
        throw new Error("Protected diagnostic archive failed its recorded content identity");
      protectedDiagnosticArtifacts.set(archive, { agentId: target.agentId, source, bytes });
    }
  });
  const normalize = (value) => {
    if (typeof value !== "string") return value;
    // State/workspace paths can differ between disposable baseline and target.
    for (const [root, token] of [[workspace, "@workspace"], [state, "@state"]])
      if (value === root || value.startsWith(`${root}/`)) return token + value.slice(root.length);
    return value;
  };
  function leaves(value, prefix = "", target = {}) {
    if (plain(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) leaves(child, `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, target);
    } else target[prefix || "/"] = digest(normalize(value));
    return target;
  }
  function entity(category, identity, value) {
    const key = `${category}:${identifier(identity)}`;
    // An entity can be present both in retired JSON and SQLite. Prefer SQLite
    // (visited last); comparing semantic payloads avoids physical-file claims.
    result.entities[key] = { category, fields: leaves(value) };
    result.coverage.categories[category] = (result.coverage.categories[category] || 0) + 1;
    return key;
  }
  function event(agentId, sessionId, value) {
    const key = identifier([agentId, sessionId]);
    if (!transcriptKeysByAgent.has(agentId)) transcriptKeysByAgent.set(agentId, new Set());
    transcriptKeysByAgent.get(agentId).add(key);
    (result.transcripts[key] ||= []).push(digest(value));
  }
  function trajectory(agentId, sessionId, value, archived = false) {
    const key = identifier([agentId, sessionId]);
    ((archived ? result.archivedTrajectories : result.trajectories)[key] ||= []).push(digest(value));
    result.coverage.trajectorySources[key] = archived ? "retained-import-archive" : "canonical";
  }
  function credentials(agentId, store) {
    if (!plain(store?.profiles)) return;
    for (const [profileId, profile] of Object.entries(store.profiles))
      entity("credential", [agentId, profileId], profile);
  }
  function authRuntime(agentId, value) {
    // These are durable selection/failure/cooldown preferences, not a cache.
    // Compare before post-upgrade inference, which legitimately changes usage.
    const stable = {};
    for (const [field, fieldValue] of Object.entries(value || {}))
      if (!["version", "profiles"].includes(field)) stable[field] = fieldValue;
    if (Object.keys(stable).length) entity("credential-runtime", agentId, stable);
  }
  function pluginInstalls(index) {
    // The discovery catalog, file signatures, installed paths and host version
    // are rebuilt for the new package. Preserve the operator's install intent.
    for (const [pluginId, record] of Object.entries(index?.installRecords || {})) {
      const stable = {};
      for (const field of ["source", "spec", "sourcePath", "packageName", "archivePath", "marketplace", "marketplaceSource", "marketplacePlugin", "channel", "pin", "integrity"])
        if (record[field] !== undefined) stable[field] = record[field];
      // Actual installPath/rootDir belongs to the installer and is omitted;
      // authored sourcePath/archivePath remains hashed and path-normalized.
      entity("plugin-install", pluginId, stable);
    }
  }
  function session(agentId, key, entry) {
    // Keep authored identity, selections and user labels; usage/activity/status
    // are runtime changes rather than historical data deletion.
    const projection = projectSessionMetadata(entry);
    const stable = {};
    for (const field of ["sessionId", "label", "displayName", "subject", "groupChannel", "channel", "chatType", "origin", "modelOverride", "providerOverride", "authProfileOverride", "thinkingLevel", "verboseLevel", "reasoningLevel", "sendPolicy", "elevatedLevel", "systemSent", "abortedLastRun", "spawnedBy", "forkedFromSessionId"])
      if (projection.entry?.[field] !== undefined) stable[field] = projection.entry[field];
    if (projection.deliveryKind) stable.delivery = { kind: projection.deliveryKind };
    if (projection.reason) result.coverage.sessionNormalizations.push({ session: identifier([agentId, key]), reason: projection.reason });
    entity("session", [agentId, key], stable);
    if (!sessionKeysByAgent.has(agentId)) sessionKeysByAgent.set(agentId, new Set());
    sessionKeysByAgent.get(agentId).add(`session:${identifier([agentId, key])}`);
  }
  function cron(job) {
    const stable = {};
    for (const field of ["id", "name", "description", "enabled", "deleteAfterRun", "createdAtMs", "agentId", "sessionKey", "schedule", "sessionTarget", "wakeMode", "payload", "delivery", "failureAlert"])
      if (job[field] !== undefined) stable[field] = job[field];
    entity("cron", job.id, stable);
  }
  function cronHistory(record) {
    const stable = {};
    for (const field of ["jobId", "ts", "status", "completionStatus", "error", "errorReason", "summary", "diagnostics", "delivered", "deliveryStatus", "deliveryError", "deliverySuppressionReason", "failureNotificationDelivery", "delivery", "sessionId", "sessionKey", "runId", "runAtMs", "durationMs", "nextRunAtMs", "model", "provider", "usage"])
      if (record[field] !== undefined && record[field] !== null) stable[field] = record[field];
    // Upstream's read codec treats absent and empty diagnostic entries alike;
    // preserve every actual entry and summary instead of hashing a placeholder.
    if (plain(stable.diagnostics)) {
      stable.diagnostics = structuredClone(stable.diagnostics);
      stable.diagnostics.entries ??= [];
      for (const entry of stable.diagnostics.entries)
        if (entry?.truncated === false) delete entry.truncated;
    }
    entity("cron-history", [record.jobId, record.ts, record.runId || null], stable);
  }
  function device(record) {
    const stable = {};
    for (const field of ["deviceId", "publicKey", "displayName", "platform", "deviceFamily", "clientId", "clientMode", "role", "roles", "scopes", "approvedScopes", "tokens", "createdAtMs", "approvedAtMs"])
      if (record[field] !== undefined && record[field] !== null) stable[field] = record[field];
    entity("paired-device", record.deviceId, stable);
  }

  const config = readJson(configPath);
  if (config) {
    const { config: normalized, changes } = normalizeConfiguration(config);
    result.coverage.configurationNormalizations = changes;
    // An absent roster in 6.6.6 means one implicit main agent. The target
    // persists this explicitly, so compare actual authored roster entries.
    const roster = normalized.agents?.entries || {};
    for (const [id, agent] of Object.entries(roster)) entity("agent", id, agent);
    if (normalized.agents) delete normalized.agents.entries;
    result.config = leaves(normalized);
  } else result.coverage.warnings.push("Active JSON configuration is absent");

  const roots = new Map([[workspace, "@workspace"]]);
  const roster = [
    ...Object.entries(config?.agents?.entries || {}).map(([id, agent]) => ({ id, ...agent })),
    ...(config?.agents?.list || []),
  ];
  const defaultAgentId = roster.find((agent) => agent.default === true)?.id || roster[0]?.id || "main";
  for (const [id, agent] of Object.entries(config?.agents?.entries || {}))
    if (agent.workspace && path.resolve(agent.workspace) !== workspace)
      roots.set(path.resolve(agent.workspace), `@agent-workspace/${identifier(id)}`);
  for (const agent of config?.agents?.list || [])
    if (agent.workspace && path.resolve(agent.workspace) !== workspace)
      roots.set(path.resolve(agent.workspace), `@agent-workspace/${identifier(agent.id)}`);
  for (const [root, alias] of roots) walk(root, (filename, relative, entry) => {
    const key = `${alias}/${relative}`;
    if (entry.isSymbolicLink()) result.workspaceFiles[key] = { kind: "symlink", sha256: digest(fs.readlinkSync(filename)) };
    else if (entry.isFile()) result.workspaceFiles[key] = { kind: "file", sha256: hash(fs.readFileSync(filename)), mode: fs.statSync(filename).mode & 0o777 };
    else result.coverage.warnings.push(`Nonregular workspace entry ${identifier(key)}`);
  }, (relative, entry) => entry.isDirectory() && [".git", "node_modules"].includes(entry.name));
  const agentWorkspaceAliases = new Map();
  for (const agent of roster.length ? roster : [{ id: "main" }]) {
    const root = path.resolve(agent.workspace || config?.agents?.defaults?.workspace || workspace);
    const alias = roots.get(root);
    if (alias) agentWorkspaceAliases.set(agent.id, alias);
  }
  for (const [root, alias] of roots) {
    const agentsPath = path.join(root, "AGENTS.md");
    const agents = fs.existsSync(agentsPath) && fs.lstatSync(agentsPath).isFile() ? fs.readFileSync(agentsPath, "utf8") : null;
    if (agents !== null) result.workspaceMigrations[`${alias}/AGENTS.md`] = {
      normalizedInstructionsSha256: hash(normalizeManagedAgentsInstructions(agents)),
      retainedBaseCandidates: [],
    };
    for (const [agentId, candidate] of agentWorkspaceAliases) if (candidate === alias && agents !== null) {
      const archives = path.join(state, "backups", "tools-md-migration");
      const prefix = agentId.replace(/[^A-Za-z0-9._-]+/g, "-") + "-";
      if (fs.existsSync(archives)) for (const name of fs.readdirSync(archives)) {
        if (!name.startsWith(prefix) || !/^[a-f0-9]{64}\.md$/.test(name.slice(prefix.length))) continue;
        const bytes = fs.readFileSync(path.join(archives, name));
        if (hash(bytes) !== name.slice(prefix.length, -3)) throw new Error("Tool-note migration archive content identity is invalid");
        const tools = bytes.toString("utf8");
        const block = `### Local notes (migrated from TOOLS.md)\n\n${tools}`;
        const at = agents.indexOf(block);
        if (at < 0 || !tools.length) continue;
        const before = agents.slice(0, at);
        let after = agents.slice(at + block.length);
        const separator = after.length ? tools.endsWith("\n\n") ? 0 : tools.endsWith("\n") ? 1 : 2 : 0;
        if (!after.startsWith("\n".repeat(separator))) continue;
        after = after.slice(separator);
        result.workspaceMigrations[`${alias}/TOOLS.md`] ||= { canonicalToolsSources: [] };
        result.workspaceMigrations[`${alias}/TOOLS.md`].canonicalToolsSources.push({
          sha256: hash(bytes), destinationMode: fs.statSync(agentsPath).mode & 0o777,
        });
        for (let trim = 0; trim <= 2; trim++) {
          if (trim && !before.endsWith("\n".repeat(trim))) continue;
          result.workspaceMigrations[`${alias}/AGENTS.md`].retainedBaseCandidates.push(hash(normalizeManagedAgentsInstructions(before.slice(0, before.length - trim) + after)));
        }
      }
    }
    for (const [agentId, candidate] of agentWorkspaceAliases) if (candidate === alias) {
      const agent = roster.find((entry) => entry.id === agentId);
      const setting = agent?.heartbeat?.every ?? config?.agents?.defaults?.heartbeat?.every ?? "30m";
      const parsed = typeof setting === "string" && /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(setting);
      const everyMs = parsed ? Number(parsed[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[parsed[2]] : null;
      if (agentId === defaultAgentId || agent?.heartbeat)
        result.workspaceMigrations[`${alias}/HEARTBEAT.md`] = { expectedEveryMs: everyMs, canonicalScratch: [] };
    }
  }

  // Retired JSON is read only if still canonical. A target .migrated backup
  // cannot prove the running target can read the imported data.
  const agentsDir = path.join(state, "agents");
  if (fs.existsSync(agentsDir)) for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentId = entry.name;
    const agentRoot = path.join(agentsDir, agentId);
    const profiles = readJson(path.join(agentRoot, "agent", "auth-profiles.json"));
    credentials(agentId, profiles);
    authRuntime(agentId, profiles);
    const sessionsDir = path.join(agentRoot, "sessions");
    const sessions = readJson(path.join(sessionsDir, "sessions.json"));
    for (const [key, record] of Object.entries(sessions || {})) session(agentId, key, record);
    walk(sessionsDir, (filename, relative, dirent) => {
      if (dirent.isFile() && /^[^/]+\.trajectory-path\.json$/.test(relative)) {
        result.durableFiles[`trajectory-pointer:${identifier([agentId, relative])}`] = hash(fs.readFileSync(filename));
        return;
      }
      if (!dirent.isFile() || !/^[^/]+\.jsonl$/.test(relative)) return;
      const records = fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
      if (relative.endsWith(".trajectory.jsonl")) {
        const sessionId = records.find((record) => typeof record.sessionId === "string")?.sessionId;
        if (!sessionId) throw new Error("Trajectory source has no session identity");
        for (const record of records) trajectory(agentId, sessionId, record);
        return;
      }
      const sessionId = records.find((value) => value.type === "session")?.id || path.basename(relative, ".jsonl");
      for (const record of records) event(agentId, sessionId, record);
    });
    // Doctor archives diagnostic sidecars independently of conversation import.
    // These are evidence of retained diagnostics, never a substitute for the
    // canonical SQLite conversation transcript checked below.
    for (const { agentId: owner, source, bytes } of protectedDiagnosticArtifacts.values()) {
      if (owner !== agentId) continue;
      if (source.endsWith(".trajectory-path.json")) {
        result.durableFiles[`trajectory-pointer:${identifier([agentId, path.basename(source)])}`] = hash(bytes);
        continue;
      }
      const records = bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
      const sessionId = records.find((record) => typeof record.sessionId === "string")?.sessionId;
      if (!sessionId) throw new Error("Archived trajectory has no session identity");
      for (const record of records) trajectory(agentId, sessionId, record, true);
    }
  }
  for (const job of readJson(path.join(state, "cron", "jobs.json"))?.jobs || []) cron(job);
  for (const [deviceId, record] of Object.entries(readJson(path.join(state, "devices", "paired.json")) || {}))
    device({ deviceId, ...record });
  for (const name of ["gateway.token", "config-journal-fingerprint.key"])
    if (fs.existsSync(path.join(state, name))) result.durableFiles[name] = hash(fs.readFileSync(path.join(state, name)));
  // Channel credentials not represented by provider profiles remain important.
  walk(path.join(state, "credentials"), (filename, relative, entry) => {
    if (entry.isFile() && !relative.endsWith(".migrated")) result.durableFiles[`credentials/${relative}`] = hash(fs.readFileSync(filename));
  });

  const databasePaths = [];
  const databaseOwners = new Map();
  const registrations = [];
  walk(state, (filename, relative, entry) => {
    if (entry.isFile() && relative.endsWith(".sqlite") && !relative.endsWith("-quarantine.sqlite")) databasePaths.push([filename, relative]);
  }, (relative, entry) => entry.isDirectory() && ["npm", "tmp", "logs", "backups", "node_modules", ".git"].includes(entry.name));
  for (const [filename, relative] of databasePaths) {
    const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=10000; BEGIN");
      const definitions = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const tables = definitions.map((row) => row.name);
      const schema = { userVersion: Number(db.prepare("PRAGMA user_version").get().user_version), tables: {} };
      const agentId = relative.match(/^agents\/([^/]+)\//)?.[1];
      const memoryOwner = agentId || path.basename(relative, ".sqlite");
      const memoryChunks = tables.includes("memory_index_chunks") ? "memory_index_chunks" : tables.includes("chunks") ? "chunks" : null;
      const memoryContent = new Map();
      const provenance = new Map(tables.includes("memory_index_chunk_provenance")
        ? db.prepare("SELECT * FROM memory_index_chunk_provenance").all().map((row) => [row.chunk_id, row]) : []);
      if (memoryChunks) for (const row of db.prepare(`SELECT * FROM ${quote(memoryChunks)}`).all()) {
        const key = identifier([row.path, row.source]);
        const group = memoryContent.get(key) || { rows: [], invalid: 0, legacyProvenance: 0 };
        group.rows.push(Object.fromEntries(["id", "path", "source", "start_line", "end_line", "hash", "text"].filter((field) => row[field] !== undefined).map((field) => [field, row[field]])));
        if (!normalizeMemoryEmbedding(row.embedding).valid) group.invalid++;
        const origin = provenance.get(row.id);
        // Official ensureMemoryChunkProvenance dirties source fingerprints when
        // backfilling old chunks as untrusted/unknown at their original time.
        if (origin?.origin_class === "untrusted" && origin.session_kind === "unknown" && origin.observed_at === row.updated_at)
          group.legacyProvenance++;
        memoryContent.set(key, group);
      }
      const vectorRebuildDebt = tables.includes("memory_index_meta") &&
        db.prepare("SELECT value FROM memory_index_meta WHERE key='memory_vector_rebuild_v1'").get()?.value === "1";
      const jobsById = new Map(tables.includes("cron_jobs") ? db.prepare("SELECT job_id,job_json FROM cron_jobs").all().map((row) => [row.job_id, JSON.parse(row.job_json)]) : []);
      if (agentId && tables.includes("session_nodes")) {
        for (const key of sessionKeysByAgent.get(agentId) || []) delete result.entities[key];
        for (const key of transcriptKeysByAgent.get(agentId) || []) delete result.transcripts[key];
      }
      for (const table of tables) {
        // FTS virtual tables require their schema extensions and are derived;
        // source text/chunks/transcripts are checked directly instead.
        if (table.includes("_fts") || /CREATE VIRTUAL TABLE/i.test(definitions.find((row) => row.name === table).sql || "")) continue;
        const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => row.name);
        const count = Number(db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n);
        schema.tables[table] = { columns, count };
        let projected = false;
        const rows = () => db.prepare(`SELECT * FROM ${quote(table)}`).all();
        if (table === "schema_meta") {
          // Version/app-version and creation/update timestamps describe the
          // running schema/build. Ownership is functional durable identity:
          // upstream validates role + agent_id before opening an agent DB.
          for (const row of rows()) {
            const owner = { metaKey: row.meta_key, role: row.role, agentId: row.agent_id };
            entity("database-owner", [normalize(filename), row.meta_key], owner);
            if (row.meta_key === "primary") databaseOwners.set(fs.realpathSync(filename), owner);
          }
          projected = true;
        } else if (table === "agent_databases") {
          // last_seen_at/size_bytes are refreshed on every registration;
          // schema_version legitimately advances. Preserve owner + resolved
          // target identity and check the referenced DB's actual owner below.
          for (const row of rows()) registrations.push({ registry: filename, row });
          projected = true;
        } else if (["auth_profile_store", "auth_profile_stores"].includes(table)) {
          for (const row of rows()) {
            const value = JSON.parse(row.store_json);
            credentials(agentId || "main", value);
            if (!tables.includes("auth_profile_state")) authRuntime(agentId || "main", value);
          }
          projected = true;
        } else if (table === "auth_profile_state") {
          for (const row of rows()) authRuntime(agentId || "main", JSON.parse(row.state_json));
          projected = true;
        } else if (table === "installed_plugin_index") {
          for (const row of rows()) pluginInstalls({ installRecords: JSON.parse(row.install_records_json) });
          projected = true;
        } else if (table === "config_machine_state") {
          for (const row of rows()) if (row.state_key === "plugins.installedIndex") {
            const value = JSON.parse(row.value_json);
            pluginInstalls(value.index || value);
          } else if (row.state_key === "authProfiles.store")
            credentials("main", JSON.parse(row.value_json));
          else if (row.state_key === "authProfiles.state")
            authRuntime("main", JSON.parse(row.value_json));
          // Other keys include durable shared auth/machine preferences. Expose
          // them as a coverage gap until mapped, rather than calling them cache.
          const unmapped = rows().filter((row) => !["plugins.installedIndex", "authProfiles.store", "authProfiles.state"].includes(row.state_key)).length;
          if (unmapped) result.coverage.unprojectedNonemptyTables.push({ database: relative, table: "config_machine_state (other keys)", count: unmapped });
          projected = true;
        } else if (table === "cron_jobs") {
          for (const row of rows()) cron(JSON.parse(row.job_json));
          projected = true;
        } else if (table === "cron_job_scratch") {
          for (const row of rows()) {
            if (typeof row.content !== "string") continue;
            entity("cron-scratch", row.job_id, { content: row.content, sourceSha256: row.source_sha256, revision: row.revision });
            const job = jobsById.get(row.job_id);
            if (job?.payload?.kind !== "heartbeat" || job.declarationKey !== `heartbeat:${job.agentId}` ||
                row.source_sha256 !== hash(row.content)) continue;
            const alias = agentWorkspaceAliases.get(job.agentId);
            if (!alias) continue;
            result.workspaceMigrations[`${alias}/HEARTBEAT.md`] ||= { canonicalScratch: [] };
            result.workspaceMigrations[`${alias}/HEARTBEAT.md`].canonicalScratch.push({
              contentSha256: hash(row.content), sourceSha256: row.source_sha256,
              jobId: identifier(row.job_id), enabled: job.enabled,
              everyMs: job.schedule?.kind === "every" ? job.schedule.everyMs : null,
              destinationMode: fs.statSync(filename).mode & 0o777,
            });
          }
          projected = true;
        } else if (table === "cron_run_logs") {
          for (const row of rows()) cronHistory({ ...JSON.parse(row.entry_json), jobId: row.job_id, ts: row.ts });
          projected = true;
        } else if (table === "task_runs") {
          for (const row of rows()) {
            const detail = row.detail_json ? JSON.parse(row.detail_json) : null;
            if (row.runtime === "cron" && detail?.kind === "cron-run")
              cronHistory({ ...detail, jobId: row.source_id, ts: row.ended_at ?? row.last_event_at ?? row.created_at, sessionKey: row.child_session_key });
            const stable = {};
            for (const [key, value] of Object.entries(row))
              if (!["execution_owner_host", "execution_owner_pid", "execution_owner_start_identity"].includes(key) && value !== null)
                stable[key] = key.endsWith("_json") ? JSON.parse(value) : value;
            entity("task", row.task_id, stable);
          }
          projected = true;
        } else if (table === "task_delivery_state") {
          for (const row of rows()) entity("task-delivery", row.task_id, {
            ...(row.requester_origin_json !== null ? { requesterOrigin: JSON.parse(row.requester_origin_json) } : {}),
            ...(row.last_notified_event_at !== null ? { lastNotifiedEventAt: row.last_notified_event_at } : {}),
          });
          projected = true;
        } else if (table === "session_nodes" && agentId) {
          for (const row of rows()) {
            const record = JSON.parse(row.entry_json || "{}");
            record.sessionId ||= row.current_session_id;
            if (tables.includes("session_entry_snapshots"))
              for (const field of db.prepare("SELECT field,value_json FROM session_entry_snapshots WHERE session_key=?").all(row.session_key)) record[field.field] = JSON.parse(field.value_json);
            session(agentId, row.session_key, record);
          }
          projected = true;
        } else if (table === "transcript_events" && agentId) {
          // Database is canonical when present, not retained/mirrored JSONL.
          const sessionIds = db.prepare("SELECT DISTINCT session_id FROM transcript_events").all();
          for (const row of sessionIds) delete result.transcripts[identifier([agentId, row.session_id])];
          for (const row of db.prepare("SELECT * FROM transcript_events ORDER BY session_id,seq").all()) {
            const json = row.event_json ?? zstdDecompressSync(row.event_zstd, { maxOutputLength: 4194304 }).toString("utf8");
            event(agentId, row.session_id, JSON.parse(json));
          }
          projected = true;
        } else if (table === "trajectory_runtime_events" && agentId) {
          for (const row of db.prepare("SELECT * FROM trajectory_runtime_events ORDER BY session_id,seq").all()) {
            const key = identifier([agentId, row.session_id]);
            if (result.coverage.trajectorySources[key] !== "sqlite") result.trajectories[key] = [];
            trajectory(agentId, row.session_id, JSON.parse(row.event_json));
            result.coverage.trajectorySources[key] = "sqlite";
          }
          projected = true;
        } else if (table === "session_transcript_active_events" && agentId) {
          for (const row of db.prepare("SELECT active.*, event.event_json, event.event_zstd FROM session_transcript_active_events AS active LEFT JOIN transcript_events AS event ON event.session_id=active.session_id AND event.seq=active.event_seq ORDER BY active.session_id,active.active_position").all()) {
            if (row.event_json == null && row.event_zstd == null) throw new Error("Active transcript references a missing canonical event");
            const record = JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd, { maxOutputLength: 4194304 }).toString("utf8"));
            (result.activeTranscripts[identifier([agentId, row.session_id])] ||= []).push(digest(record));
          }
          projected = true;
        } else if (table === "session_entry_snapshots" && agentId) {
          // These fields were materialized into their owning session above.
          projected = tables.includes("session_nodes");
        } else if (table === "device_pairing_paired") {
          for (const row of rows()) {
            const record = {};
            for (const [key, value] of Object.entries(row)) {
              const json = key.endsWith("_json");
              const camel = (json ? key.slice(0, -5) : key).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
              record[camel] = json && value !== null ? JSON.parse(value) : value;
            }
            device(record);
          }
          projected = true;
        } else if (["memory_index_sources", "memory_index_chunks", "files", "chunks"].includes(table)) {
          const owner = memoryOwner;
          const source = ["files", "memory_index_sources"].includes(table);
          const fields = source ? ["path", "source", "hash", "size"] : ["id", "path", "source", "start_line", "end_line", "hash", "model", "text", "embedding"];
          for (const row of rows()) {
            const value = Object.fromEntries(fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
            const sourceKey = `memory-source:${identifier([owner, [row.path, row.source]])}`;
            let embedding;
            if (!source && row.embedding !== undefined) {
              embedding = normalizeMemoryEmbedding(row.embedding);
              value.embedding = embedding.vector ?? { invalidStorage: digest(row.embedding) };
            }
            const key = entity(source ? "memory-source" : "memory-chunk", [owner, source ? [row.path, row.source] : row.id], value);
            if (source) {
              const content = memoryContent.get(identifier([row.path, row.source]));
              result.memoryDerivations[key] = {
                kind: "source", vectorRebuildDebt, dirtyFingerprint: row.hash === "",
                contentDigest: content ? digest(content.rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))) : null,
                invalidLegacyVectors: content?.invalid || 0,
                legacyProvenanceBackfill: !!content?.rows.length && content.legacyProvenance === content.rows.length,
              };
            } else if (embedding) result.memoryDerivations[key] = {
              kind: "chunk", sourceKey, vectorRebuildDebt, encoding: embedding.encoding,
              emptyVector: embedding.vector?.length === 0,
              ...!embedding.valid ? { invalidEmbeddingDigest: digest(row.embedding) } : {},
            };
          }
          projected = true;
        } else if (["memory_entry_origins", "cron_run_receipts"].includes(table)) {
          const excluded = new Set(["chunk_rowid", "updated_at", "updated_at_ms", "mtime", "owner_pid", "owner_start_time"]);
          const primary = db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter((row) => row.pk).sort((a, b) => a.pk - b.pk).map((row) => row.name);
          for (const row of rows()) {
            const value = Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key)));
            const category = table.startsWith("memory_") ? "memory-index" : "cron-history";
            entity(category, [agentId || "shared", table, primary.map((key) => row[key])], value);
          }
          projected = true;
        }
        if (count && !projected) result.coverage.unprojectedNonemptyTables.push({ database: relative, table, count });
      }
      result.databases[relative] = schema;
      db.exec("ROLLBACK");
    } finally { db.close(); }
  }
  // Resolve after visiting every database, so a registry read never opens an
  // unscanned/external path and collection order cannot hide an ownership loss.
  for (const { registry, row } of registrations) {
    const resolved = resolveRegisteredDatabasePath(registry, row.path);
    const present = fs.existsSync(resolved);
    const owner = present ? databaseOwners.get(fs.realpathSync(resolved)) : null;
    const target = normalize(resolved);
    entity("agent-database-registration", [normalize(registry), row.agent_id, target], {
      agentId: row.agent_id,
      databasePath: target,
      targetPresent: present,
      targetRole: owner?.role ?? null,
      targetAgentId: owner?.agentId ?? null,
    });
    if (!owner) result.coverage.warnings.push({
      database: path.relative(state, registry), table: "agent_databases",
      target: identifier(target), reason: "Registered database has no captured primary schema owner",
    });
  }
  // Counts must reflect canonical entities after overlap replacement.
  result.coverage.categories = {};
  for (const { category } of Object.values(result.entities)) result.coverage.categories[category] = (result.coverage.categories[category] || 0) + 1;
  return result;
}

export function compareInventories(before, after) {
  if (before.format !== 1 || after.format !== 1) throw new Error("Unsupported inventory format");
  if (before.collectorRevision !== after.collectorRevision)
    throw new Error("Inventory collector revisions differ; recollect both sides with the same script");
  const failures = [];
  const checked = { configFields: 0, workspaceFiles: 0, workspaceCanonicalMigrations: 0, durableFiles: 0, entities: 0, entityFields: 0, transcriptEvents: 0, trajectoryEvents: 0, archivedTrajectoryEvents: 0 };
  const workspaceCanonicalMigrations = [];
  for (const [field, value] of Object.entries(before.config)) {
    checked.configFields++;
    const addedControlUi = field === "/gateway/controlUi" && value === digest({}) &&
      Object.keys(after.config).some((key) => key.startsWith(`${field}/`));
    if (after.config[field] !== value && !addedControlUi) failures.push({ category: "config", field });
  }
  for (const group of ["workspaceFiles", "durableFiles"]) for (const [name, value] of Object.entries(before[group])) {
    checked[group]++;
    if (digest(after[group][name] ?? null) === digest(value)) continue;
    const previous = before.workspaceMigrations?.[name];
    const current = after.workspaceMigrations?.[name];
    let migration;
    if (group === "workspaceFiles" && value.kind === "file") {
      if (name.endsWith("/TOOLS.md") && current?.canonicalToolsSources?.some((source) =>
          source.sha256 === value.sha256 && source.destinationMode === value.mode))
        migration = "complete tool notes retained verbatim in canonical AGENTS.md";
      if (name.endsWith("/AGENTS.md") && after.workspaceFiles[name]?.mode === value.mode &&
          previous?.normalizedInstructionsSha256 && current?.retainedBaseCandidates?.includes(previous.normalizedInstructionsSha256))
        migration = "all original instructions retained with only verified managed guidance and tool-note insertion";
      if (name.endsWith("/HEARTBEAT.md") && previous?.expectedEveryMs > 0 && current?.canonicalScratch?.some((source) =>
          source.contentSha256 === value.sha256 && source.sourceSha256 === value.sha256 &&
          source.enabled === true && source.everyMs === previous.expectedEveryMs &&
          Number.isInteger(source.destinationMode) && (source.destinationMode & ~value.mode) === 0))
        migration = "complete heartbeat instructions retained in canonical cron scratch with equivalent cadence";
    }
    if (migration) {
      checked.workspaceCanonicalMigrations++;
      workspaceCanonicalMigrations.push({ path: name, evidence: migration });
    } else failures.push({ category: group, path: name });
  }
  for (const [key, entity] of Object.entries(before.entities)) {
    checked.entities++;
    const current = after.entities[key];
    if (!current) { failures.push({ category: entity.category, entity: key, reason: "missing entity" }); continue; }
    for (const [field, value] of Object.entries(entity.fields)) {
      checked.entityFields++;
      const oldMemory = before.memoryDerivations?.[key];
      const newMemory = after.memoryDerivations?.[key];
      const regeneratedFingerprint = entity.category === "memory-source" && field === "/hash" &&
        ((oldMemory?.invalidLegacyVectors > 0 && newMemory?.vectorRebuildDebt) ||
          (!oldMemory?.legacyProvenanceBackfill && newMemory?.legacyProvenanceBackfill)) &&
        newMemory?.dirtyFingerprint && oldMemory?.contentDigest &&
        oldMemory.contentDigest === newMemory.contentDigest;
      const explicitRoster = entity.category === "agent" && field === "/" && value === digest({}) &&
        current.fields["/"] === undefined && Object.keys(current.fields).length > 0;
      if (current.fields[field] !== value && !regeneratedFingerprint && !explicitRoster)
        failures.push({ category: entity.category, entity: key, field });
    }
    const oldMemory = before.memoryDerivations?.[key];
    if (oldMemory?.invalidEmbeddingDigest) {
      const next = after.memoryDerivations?.[key];
      const source = after.memoryDerivations?.[next?.sourceKey];
      const unchangedInvalid = next?.invalidEmbeddingDigest === oldMemory.invalidEmbeddingDigest;
      if (!unchangedInvalid && !(next?.encoding === "binary64-le" && next.emptyVector &&
          next.vectorRebuildDebt && source?.dirtyFingerprint && source.vectorRebuildDebt))
        failures.push({ category: "memory-chunk", entity: key, reason: "unverified legacy vector regeneration" });
    }
  }
  for (const [session, events] of Object.entries(before.transcripts)) {
    // Preserve order and duplicate events, while allowing target-appended events.
    const current = after.transcripts[session] || [];
    let position = 0;
    for (const event of events) {
      checked.transcriptEvents++;
      while (position < current.length && current[position] !== event) position++;
      if (position === current.length) { failures.push({ category: "transcript", session, reason: "missing or reordered event" }); break; }
      position++;
    }
  }
  const containsOrdered = (current, expected) => {
    let position = 0;
    for (const value of expected) {
      while (position < current.length && current[position] !== value) position++;
      if (position === current.length) return false;
      position++;
    }
    return true;
  };
  for (const [session, events] of Object.entries(before.trajectories || {})) {
    checked.trajectoryEvents += events.length;
    if (containsOrdered(after.trajectories?.[session] || [], events)) continue;
    if (containsOrdered(after.archivedTrajectories?.[session] || [], events)) {
      checked.archivedTrajectoryEvents += events.length;
      continue;
    }
    failures.push({ category: "diagnostic-trajectory", session, reason: "missing or reordered diagnostic history" });
  }
  return { ok: failures.length === 0, checked, failures, workspaceCanonicalMigrations, baselineCoverage: before.coverage, targetCoverage: after.coverage };
}

if (process.argv[1] === "-" || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  try {
    if (process.argv[2] === "--compare") {
      const comparison = compareInventories(readJson(process.argv[3]), readJson(process.argv[4]));
      process.stdout.write(JSON.stringify(comparison, null, 2) + "\n");
      if (!comparison.ok) process.exitCode = 1;
    } else process.stdout.write(JSON.stringify(collectInventory(), null, 2) + "\n");
  } catch (error) {
    // JSON/SQLite exceptions can contain snippets of the original secret data.
    process.stderr.write(`State inventory failed (${error?.name || "Error"}); source values omitted.\n`);
    process.exitCode = 1;
  }
}
