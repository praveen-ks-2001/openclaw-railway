import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

const FORMAT = 1;
const RELEASE = /^\d{4}\.\d+\.\d+(?:-[\w.-]+)?$/;
const ATTEMPT = /^[a-f0-9]{24}$/;

function inside(parent, value) {
  const rel = path.relative(parent, value);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function exists(value) {
  try { fs.lstatSync(value); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function canonical(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  while (!exists(cursor)) {
    suffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Cannot resolve upgrade recovery path");
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeJson(filename, value) {
  const temporary = `${filename}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function walk(root, visit) {
  const stat = fs.lstatSync(root);
  visit(root, stat);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(root)) walk(path.join(root, name), visit);
  }
}

function durableTree(root) {
  const directories = [];
  walk(root, (filename, stat) => {
    if (stat.isDirectory()) directories.push(filename);
    else if (stat.isFile()) {
      const fd = fs.openSync(filename, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else if (!stat.isSymbolicLink()) {
      throw new Error("Upgrade recovery cannot capture special files");
    }
  });
  for (const directory of directories.reverse()) syncDirectory(directory);
}

function copy(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  durableTree(destination);
  syncDirectory(path.dirname(destination));
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function olderRelease(candidate, previous) {
  const parts = (value) => value.split("-")[0].split(".").map(Number);
  const a = parts(candidate), b = parts(previous);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return candidate.includes("-") && !previous.includes("-");
}

/**
 * One upgrade transaction, outside the directories it protects. The caller must
 * exclude other writers and prove the old gateway has stopped before begin(),
 * rollback(), or recover(). Call recover() before reading/writing live tokens or
 * config on boot. No OpenClaw process is started by this module.
 *
 * A successful target is never rolled back by a later ordinary restart. A failed
 * target remains blocked until a deliberately forced attempt or a different
 * release; snapshots and failed target directories are retained for inspection.
 */
export function createUpgradeRecovery({
  stateDir,
  workspaceDir,
  configPath,
  version,
  recoveryRoot,
  openclawRoot,
  env = process.env,
  reserveBytes = 32 * 1024 * 1024,
  statfs = fs.statfsSync,
  checkpoint = () => {},
}) {
  if (!RELEASE.test(version)) throw new Error("Invalid upgrade release identifier");
  const state = canonical(stateDir);
  const workspace = canonical(workspaceDir);
  const config = canonical(configPath);
  const root = canonical(recoveryRoot || path.join(path.dirname(state), ".wrapper-upgrade-recovery"));
  const identity = { stateDir: state, workspaceDir: workspace, configPath: config };
  const activePath = path.join(root, "active.json");
  const successPath = path.join(root, "last-success.json");
  let installedCodeRoot = null;
  if (openclawRoot) {
    try {
      const candidate = canonical(openclawRoot);
      const metadata = readJson(path.join(candidate, "package.json"));
      if (metadata.name === "openclaw" && metadata.version === version)
        installedCodeRoot = candidate;
    } catch { /* Unverified code roots never exempt an external link. */ }
  }
  for (const live of [state, workspace, config]) {
    if (live === path.parse(live).root || inside(live, root) || inside(root, live))
      throw new Error("Upgrade recovery storage must be separate from live state, workspace, and config");
  }
  // A symlinked storage root can change identity between journal writes.
  if (exists(recoveryRoot || path.join(path.dirname(state), ".wrapper-upgrade-recovery")) &&
      fs.lstatSync(recoveryRoot || path.join(path.dirname(state), ".wrapper-upgrade-recovery")).isSymbolicLink())
    throw new Error("Upgrade recovery storage must not be a symbolic link");

  function prepareRoot() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.statSync(root).isDirectory()) throw new Error("Upgrade recovery storage is not a directory");
  }

  function attemptDirectory(id) { return path.join(root, "attempts", id); }
  function paths(record, id, index) {
    return {
      snapshot: path.join(attemptDirectory(id), "snapshot", String(index)),
      stage: path.join(path.dirname(record.target), `.wrapper-upgrade-restore-${id}-${index}`),
      failed: path.join(path.dirname(record.target), `.wrapper-upgrade-failed-${id}-${index}`),
    };
  }

  function readActive() {
    if (!exists(activePath)) return null;
    const journal = readJson(activePath);
    if (journal.format !== FORMAT || !ATTEMPT.test(journal.id) || !RELEASE.test(journal.version) ||
        !["migrating", "restoring", "rolled-back", "committed"].includes(journal.status) ||
        Object.entries(identity).some(([key, value]) => journal[key] !== value) ||
        !Array.isArray(journal.records) || !journal.records.length)
      throw new Error("Upgrade recovery journal is incompatible; live data was not changed");
    const allowed = [...new Set([state, workspace, config])].filter((candidate, index, all) =>
      !all.some((parent, other) => index !== other && inside(parent, candidate)));
    const seen = new Set();
    for (const record of journal.records) {
      if (!allowed.includes(record.target) || seen.has(record.target) ||
          typeof record.existed !== "boolean" || !["file", "directory", "absent"].includes(record.kind) ||
          ![undefined, "prepared", "moving", "installing", "restored"].includes(record.step))
        throw new Error("Upgrade recovery journal has unsafe roots; live data was not changed");
      seen.add(record.target);
    }
    if (seen.size !== allowed.length || allowed.some((target) => !seen.has(target)) || journal.records.some((record, index, all) =>
      all.some((other, otherIndex) => index !== otherIndex && inside(other.target, record.target))))
      throw new Error("Upgrade recovery journal has incomplete or overlapping roots");
    return journal;
  }

  function save(journal, point) {
    writeJson(activePath, journal);
    checkpoint(point, { id: journal.id, status: journal.status });
  }

  function successfulRelease() {
    if (!exists(successPath)) return null;
    const marker = readJson(successPath);
    if (marker.format !== FORMAT || !RELEASE.test(marker.version) ||
        Object.entries(identity).some(([key, value]) => marker[key] !== value))
      throw new Error("Upgrade success marker is incompatible with configured paths");
    return marker.version;
  }

  function finishCommit(journal) {
    writeJson(successPath, { format: FORMAT, ...identity, version: journal.version, completedAt: journal.completedAt });
    fs.unlinkSync(activePath);
    syncDirectory(root);
  }

  function restore(journal) {
    if (journal.status === "rolled-back") return;
    journal.status = "restoring";
    save(journal, "restore-started");
    for (const [index, record] of journal.records.entries()) {
      const { snapshot, stage, failed } = paths(record, journal.id, index);
      if (record.step === "restored") continue;
      if (!record.step) {
        if (exists(stage)) fs.rmSync(stage, { recursive: true, force: true });
        if (record.existed) {
          if (!exists(snapshot)) throw new Error("Required upgrade snapshot is missing; recovery stopped without deleting live data");
          copy(snapshot, stage);
        }
        record.step = "prepared";
        save(journal, `restore-prepared-${index}`);
      }
      if (record.step === "prepared") {
        if (exists(failed)) throw new Error("Failed-state recovery path already exists unexpectedly");
        record.hadLive = exists(record.target);
        record.step = "moving";
        save(journal, `restore-moving-${index}`);
      }
      if (record.step === "moving") {
        if (record.hadLive && !exists(failed)) {
          fs.renameSync(record.target, failed);
          syncDirectory(path.dirname(record.target));
          checkpoint(`restore-live-moved-${index}`, { id: journal.id });
        }
        record.step = "installing";
        save(journal, `restore-installing-${index}`);
      }
      if (record.step === "installing") {
        if (record.existed && exists(stage)) {
          if (exists(record.target)) throw new Error("Unexpected live writer during upgrade recovery; failed state and snapshot retained");
          fs.renameSync(stage, record.target);
          syncDirectory(path.dirname(record.target));
          checkpoint(`restore-snapshot-installed-${index}`, { id: journal.id });
        } else if (record.existed && !exists(record.target)) {
          throw new Error("Recovered root is missing; recovery snapshot retained");
        } else if (!record.existed && exists(record.target)) {
          throw new Error("Unexpected live writer during absent-root recovery");
        }
        record.step = "restored";
        save(journal, `restore-completed-${index}`);
      }
    }
    journal.status = "rolled-back";
    journal.recoveredAt = new Date().toISOString();
    save(journal, "restore-completed");
  }

  function result(journal, extra = {}) {
    return { needed: true, version: journal.version, snapshotPath: attemptDirectory(journal.id), ...extra };
  }

  function checkCoverage() {
    if (!exists(state) || !fs.lstatSync(state).isDirectory())
      throw new Error("Configured upgrade requires an existing state directory");
    const configObject = JSON5.parse(fs.readFileSync(config, "utf8"));
    const covered = [...new Set([state, workspace])].filter((candidate, index, all) =>
      !all.some((parent, other) => index !== other && inside(parent, candidate)));
    const checkPath = (value, label) => {
      if (typeof value !== "string" || !value.trim()) return;
      let expanded = value.trim();
      if (expanded === "~" || expanded.startsWith("~/")) expanded = path.join(env.HOME || os.homedir(), expanded.slice(2));
      if (expanded.includes("$") || !path.isAbsolute(expanded) ||
          !covered.some((parent) => inside(parent, canonical(expanded))))
        throw new Error(`Upgrade snapshot does not cover ${label}; original data was retained. Use a complete-volume backup and migrate this custom layout explicitly.`);
    };
    const stack = [configObject];
    while (stack.length) {
      const object = stack.pop();
      if (!object || typeof object !== "object") continue;
      if (Object.hasOwn(object, "$include"))
        throw new Error("Automatic upgrade does not support config $include graphs; original data was retained. Migrate this layout with a complete-volume backup.");
      for (const value of Object.values(object)) if (value && typeof value === "object") stack.push(value);
    }
    checkPath(env.OPENCLAW_OAUTH_DIR, "external credentials");
    checkPath(env.OPENCLAW_AGENT_DIR, "external agent directory");
    checkPath(env.PI_CODING_AGENT_DIR, "external agent directory");
    checkPath(configObject.agents?.defaults?.workspace, "default agent workspace");
    checkPath(configObject.agents?.defaults?.memorySearch?.store?.path, "memory search database");
    checkPath(configObject.session?.store, "legacy session store");
    checkPath(configObject.cron?.store, "legacy schedule store");
    const list = configObject.agents?.list;
    const agents = [
      ...(Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : []),
      ...Object.values(configObject.agents?.entries || {}),
    ];
    for (const agent of agents) {
      checkPath(agent?.agentDir, "agent database directory");
      checkPath(agent?.workspace, "agent workspace");
      checkPath(agent?.memorySearch?.store?.path, "agent memory search database");
    }
    // Preserve internal links verbatim. External links could hide a writable
    // database/workspace outside snapshot coverage. The generated skill index
    // points into immutable installed plugin code and is not user state.
    for (const directory of covered) if (exists(directory)) walk(directory, (filename, stat) => {
      if (!stat.isSymbolicLink() || (filename !== path.join(state, "plugin-skills") && inside(path.join(state, "plugin-skills"), filename))) return;
      const target = canonical(path.resolve(path.dirname(filename), fs.readlinkSync(filename)));
      // Official npm plugin projects link their OpenClaw peer to the installed
      // host package. Capture that link verbatim, never the external code tree.
      // This exception cannot cover credentials or arbitrary external roots.
      const managedHostPeer = installedCodeRoot && target === installedCodeRoot &&
        inside(path.join(state, "npm", "projects"), filename) &&
        path.basename(filename) === "openclaw" && path.basename(path.dirname(filename)) === "node_modules";
      if (managedHostPeer) return;
      if (![...covered, config].some((parent) => inside(parent, target)))
        throw new Error("Upgrade snapshot cannot cover an external state/workspace symbolic link; original data was retained. Back up and migrate the complete layout explicitly.");
    });
  }

  return {
    recover() {
      const journal = readActive();
      if (!journal) return { recovered: false, blocked: false, version: successfulRelease() };
      if (journal.status === "committed") {
        finishCommit(journal);
        return { recovered: false, blocked: false, version: journal.version };
      }
      const interrupted = journal.status !== "rolled-back";
      restore(journal);
      return result(journal, { recovered: interrupted, blocked: journal.version === version });
    },
    begin({ force = false } = {}) {
      const previous = readActive();
      if (previous && !["rolled-back", "committed"].includes(previous.status))
        throw new Error("An interrupted upgrade must be recovered before another attempt");
      if (previous?.status === "committed") finishCommit(previous);
      if (!force && previous?.status === "rolled-back" && previous.version === version)
        throw new Error("This release failed a previous upgrade; the original data is restored and a deliberate recovery attempt is required");
      const previousVersion = successfulRelease();
      if (previousVersion && olderRelease(version, previousVersion))
        throw new Error("An older OpenClaw release cannot open a volume successfully migrated by a newer release; restore its matching pre-upgrade snapshot first");
      if (!force && previousVersion === version) return { needed: false, version };
      checkCoverage();
      prepareRoot();
      const targets = [...new Set([state, workspace, config])].filter((candidate, index, all) =>
        !all.some((parent, other) => index !== other && inside(parent, candidate)));
      const records = targets.map((target) => {
        const stat = exists(target) ? fs.lstatSync(target) : null;
        if (stat && !stat.isFile() && !stat.isDirectory()) throw new Error("Upgrade root must be a regular file or directory");
        // Renaming a mounted directory cannot provide recoverable replacement.
        if (stat?.isDirectory() && stat.dev !== fs.statSync(path.dirname(target)).dev)
          throw new Error("Automatic upgrade cannot replace a mounted state/workspace root; preserve the complete volume and migrate this layout explicitly");
        return { target, existed: Boolean(stat), kind: stat ? stat.isDirectory() ? "directory" : "file" : "absent" };
      });
      let bytes = 0;
      for (const record of records) {
        let rootBytes = 0;
        if (record.existed) walk(record.target, (_filename, stat) => {
          if (stat.isFile()) rootBytes += stat.size;
          else if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("Upgrade recovery cannot capture special files");
        });
        bytes += rootBytes;
        const destinationSpace = statfs(path.dirname(record.target), { bigint: true });
        if (destinationSpace.bavail * destinationSpace.bsize < BigInt(Math.ceil(rootBytes + reserveBytes)))
          throw new Error("Not enough disk space to restore the configured state/workspace after an upgrade failure; original data was not changed");
      }
      const available = statfs(root, { bigint: true });
      if (available.bavail * available.bsize < BigInt(Math.ceil(bytes * 2 + reserveBytes)))
        throw new Error("Not enough disk space for upgrade snapshot and automatic recovery; original data was not changed");
      const journal = { format: FORMAT, id: crypto.randomBytes(12).toString("hex"), ...identity,
        version, previousVersion, status: "migrating", records, createdAt: new Date().toISOString() };
      const directory = attemptDirectory(journal.id);
      fs.mkdirSync(path.join(directory, "snapshot"), { recursive: true, mode: 0o700 });
      syncDirectory(path.dirname(directory));
      syncDirectory(directory);
      try {
        for (const [index, record] of records.entries()) if (record.existed) {
          copy(record.target, paths(record, journal.id, index).snapshot);
          checkpoint(`snapshot-copied-${index}`, { id: journal.id });
        }
        writeJson(path.join(directory, "manifest.json"), journal);
        if (previous?.status === "rolled-back") writeJson(path.join(attemptDirectory(previous.id), "result.json"), previous);
        save(journal, "migration-started");
      } catch (error) {
        // Once active.json points here, never discard the only recovery copy.
        if (!exists(activePath) || readJson(activePath).id !== journal.id)
          fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return result(journal);
    },
    commit() {
      const journal = readActive();
      if (!journal || journal.status !== "migrating" || journal.version !== version)
        throw new Error("Only the active migrating target can be committed");
      journal.status = "committed";
      journal.completedAt = new Date().toISOString();
      save(journal, "migration-committed");
      finishCommit(journal);
      return result(journal, { committed: true });
    },
    rollback() {
      const journal = readActive();
      if (!journal || !["migrating", "restoring", "rolled-back"].includes(journal.status))
        throw new Error("No failed migration is available for rollback");
      restore(journal);
      return result(journal, { recovered: true, blocked: journal.version === version });
    },
    // Call only after replacement/import/setup is independently verified ready.
    // This does not migrate or validate the new live state itself.
    adopt() {
      prepareRoot();
      const journal = readActive();
      if (journal && !["rolled-back", "committed"].includes(journal.status))
        throw new Error("Cannot adopt replacement state while an upgrade is active");
      const completedAt = new Date().toISOString();
      if (journal) {
        writeJson(path.join(attemptDirectory(journal.id), "result.json"), journal);
        journal.status = "committed";
        journal.version = version;
        journal.completedAt = completedAt;
        journal.adoptedVerifiedReplacement = true;
        save(journal, "replacement-adopted");
        finishCommit(journal);
      } else {
        writeJson(successPath, { format: FORMAT, ...identity, version, completedAt });
      }
      return { version, committed: true };
    },
    // Invalidate success when a reset changes live state. Full wipe may clear a
    // terminal block too, but snapshots remain unless the wipe owner removes
    // recovery storage explicitly. Never forget an interrupted transaction.
    forget({ successOnly = false } = {}) {
      const journal = readActive();
      if (journal && !["rolled-back", "committed"].includes(journal.status))
        throw new Error("An active upgrade must be recovered before its metadata can be reset");
      if (journal && (!successOnly || journal.status === "committed")) {
        writeJson(path.join(attemptDirectory(journal.id), "result.json"), journal);
        fs.unlinkSync(activePath);
        syncDirectory(root);
      }
      if (exists(successPath)) {
        fs.unlinkSync(successPath);
        syncDirectory(root);
      }
    },
    status() {
      const journal = readActive();
      return journal ? { ...result(journal), status: journal.status, blocked: journal.status === "rolled-back" && journal.version === version }
        : { needed: successfulRelease() !== version, version: successfulRelease(), blocked: false };
    },
  };
}
