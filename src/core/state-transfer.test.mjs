import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeStagedTree,
  createDirectoryTransaction,
  findStagedDataRoot,
  inspectZipArchive,
  readOfficialBackupLayout,
  readStagedLayout,
  requireFreeSpace,
} from "./state-transfer.js";

test("import refuses a volume without room for staged replacement and recovery reserve", () => {
  const options = {
    reserveBytes: 64,
    statfs: () => ({ bavail: 10n, bsize: 16n }),
  };
  requireFreeSpace("unused", 96, options);
  assert.throws(
    () => requireFreeSpace("unused", 97, options),
    /Not enough free volume space/,
  );
});

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wrapper-state-transfer-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, value = name) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

// Central-directory fixture lets malformed archives hit the pre-extraction boundary.
function zipMember(
  name,
  { mode = 0x8000, size = 1, localName = name, extra = Buffer.alloc(0) } = {},
) {
  const centralName = Buffer.from(name);
  const localNameBytes = Buffer.from(localName);
  const local = Buffer.alloc(30 + localNameBytes.length + 1);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(1, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(localNameBytes.length, 26);
  localNameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + centralName.length + extra.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(1, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(centralName.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  centralName.copy(central, 46);
  extra.copy(central, 46 + centralName.length);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

test("ZIP preflight accepts the actual password ZIP format used by export", (t) => {
  const root = fixture(t);
  write(root, "data/.openclaw/openclaw.json", "{}");
  write(root, "data/workspace/SOUL.md", "hello");
  const archive = path.join(root, "export.zip");
  execFileSync(
    "zip",
    ["-qr", "-P", "synthetic-test-password", archive, "data"],
    { cwd: root },
  );
  const result = inspectZipArchive(fs.readFileSync(archive));
  assert.equal(result.encrypted, true);
  assert.equal(result.uncompressedBytes, 7);
});

test("ZIP preflight rejects traversal, absolute, Windows, and link members", () => {
  for (const name of [
    "../escape",
    "/absolute",
    "data/../../escape",
    "C:/escape",
    "data\\escape",
    "data//escape",
  ]) {
    assert.throws(() => inspectZipArchive(zipMember(name)), /unsafe|traversal/);
  }
  assert.throws(
    () => inspectZipArchive(zipMember("data/link", { mode: 0xa000 })),
    /links/,
  );
  assert.throws(
    () => inspectZipArchive(zipMember("data/pipe", { mode: 0x1000 })),
    /special/,
  );
});

test("ZIP preflight rejects metadata disagreement and expansion bombs before unzip", () => {
  assert.throws(
    () =>
      inspectZipArchive(zipMember("data/config", { localName: "../outside" })),
    /disagree/,
  );
  assert.throws(
    () => inspectZipArchive(zipMember("data/config", { size: 2000 })),
    /compression-ratio/,
  );
  assert.throws(
    () =>
      inspectZipArchive(zipMember("data/config", { size: 11 }), {
        maxUncompressedBytes: 10,
      }),
    /expanded-size/,
  );
  assert.throws(
    () => inspectZipArchive(Buffer.from("not a zip")),
    /Invalid ZIP/,
  );
});

test("ZIP Unicode metadata cannot override a checked member path", () => {
  const alternate = Buffer.from("../outside");
  const extra = Buffer.alloc(9 + alternate.length);
  extra.writeUInt16LE(0x7075, 0);
  extra.writeUInt16LE(5 + alternate.length, 2);
  extra.writeUInt8(1, 4);
  alternate.copy(extra, 9);
  assert.throws(
    () => inspectZipArchive(zipMember("data/safe", { extra })),
    /traversal/,
  );
  const mismatchedSize = zipMember("data/file");
  mismatchedSize.writeUInt32LE(50, 22);
  assert.throws(() => inspectZipArchive(mismatchedSize), /sizes disagree/);
});

test("staged tree validation rejects links without following their contents", (t) => {
  const root = fixture(t);
  const stage = path.join(root, "stage");
  write(stage, "data/.openclaw/openclaw.json", "{}");
  fs.symlinkSync(root, path.join(stage, "loop"));
  assert.throws(() => assertSafeStagedTree(stage), /link/);
  fs.unlinkSync(path.join(stage, "loop"));
  assert.throws(() => assertSafeStagedTree(stage, { maxBytes: 1 }), /size/);
});

test("legacy staging recognizes both separate and nested workspaces", (t) => {
  const root = fixture(t);
  write(root, "data/.openclaw/openclaw.json", "{}");
  write(root, "data/.openclaw/workspace/AGENTS.md");
  assert.equal(
    findStagedDataRoot(root).workspaceDir,
    path.join(root, "data/.openclaw/workspace"),
  );
  write(root, "data/workspace/SOUL.md");
  assert.equal(
    findStagedDataRoot(root).workspaceDir,
    path.join(root, "data/workspace"),
  );
});

test("staging metadata cannot direct apply outside extracted state", (t) => {
  const root = fixture(t);
  const stage = path.join(root, "stage");
  write(stage, "data/.openclaw/openclaw.json", "{}");
  write(
    stage,
    ".staging-meta.json",
    JSON.stringify({ stateDir: root, workspaceDir: root }),
  );
  assert.throws(() => readStagedLayout(stage), /outside/);
  fs.writeFileSync(
    path.join(stage, ".staging-meta.json"),
    JSON.stringify(findStagedDataRoot(stage)),
  );
  assert.equal(
    readStagedLayout(stage).stateDir,
    path.join(stage, "data/.openclaw"),
  );
});

for (const layout of ["siblings", "workspace-in-state", "state-in-workspace"]) {
  test(`failed import restores original state and workspace: ${layout}`, (t) => {
    const root = fixture(t);
    const stateDir = path.join(
      root,
      layout === "state-in-workspace"
        ? "live/workspace/.openclaw"
        : "live/.openclaw",
    );
    const workspaceDir = path.join(
      root,
      layout === "workspace-in-state"
        ? "live/.openclaw/workspace"
        : "live/workspace",
    );
    write(stateDir, "openclaw.json", "original-config");
    write(stateDir, "openclaw.sqlite", "original-database");
    write(workspaceDir, "SOUL.md", "original-workspace");
    const sourceState = path.join(root, "stage/.openclaw");
    const sourceWorkspace = path.join(root, "stage/workspace");
    write(sourceState, "openclaw.json", "imported-config");
    write(sourceWorkspace, "SOUL.md", "imported-workspace");
    const transaction = createDirectoryTransaction({
      stateDir,
      workspaceDir,
      rollbackBase: path.join(root, "rollback/import"),
    });
    transaction.replaceFrom({
      stateDir: sourceState,
      workspaceDir: sourceWorkspace,
    });
    assert.equal(
      fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
      "imported-config",
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"),
      "imported-workspace",
    );
    assert.ok(
      transaction.rollbackPaths.length > 0,
      "snapshot remains available during startup validation",
    );
    transaction.rollback();
    assert.equal(
      fs.readFileSync(path.join(stateDir, "openclaw.sqlite"), "utf8"),
      "original-database",
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"),
      "original-workspace",
    );
  });
}

test("healthy import removes snapshots only at explicit commit", (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, "live/.openclaw");
  const workspaceDir = path.join(stateDir, "workspace");
  write(stateDir, "openclaw.json", "original");
  write(workspaceDir, "old.md");
  const stagedState = path.join(root, "stage/.openclaw");
  const stagedWorkspace = path.join(stagedState, "workspace");
  write(stagedState, "openclaw.json", "new");
  write(stagedWorkspace, "new.md");
  const transaction = createDirectoryTransaction({
    stateDir,
    workspaceDir,
    rollbackBase: path.join(root, "rollback"),
  });
  transaction.replaceFrom({
    stateDir: stagedState,
    workspaceDir: stagedWorkspace,
  });
  const snapshots = transaction.rollbackPaths;
  assert.ok(snapshots.every((snapshot) => fs.existsSync(snapshot)));
  assert.ok(fs.existsSync(path.join(workspaceDir, "new.md")));
  assert.equal(fs.existsSync(path.join(workspaceDir, "old.md")), false);
  transaction.commit();
  assert.ok(snapshots.every((snapshot) => !fs.existsSync(snapshot)));
  assert.throws(() => transaction.rollback(), /current phase/);
});

test("rollback restores the absence of a previously missing workspace", (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, "live/.openclaw");
  const workspaceDir = path.join(root, "live/workspace");
  const sourceState = path.join(root, "stage/.openclaw");
  write(stateDir, "openclaw.json", "original");
  write(sourceState, "openclaw.json", "new");
  const transaction = createDirectoryTransaction({
    stateDir,
    workspaceDir,
    rollbackBase: path.join(root, "rollback"),
  });
  transaction.replaceFrom({ stateDir: sourceState });
  transaction.rollback();
  assert.equal(fs.existsSync(workspaceDir), false);
  assert.equal(
    fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
    "original",
  );
});

test("a partial snapshot failure restores only directories actually moved", (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, "live/state");
  const workspaceDir = path.join(root, "live/workspace");
  const sourceState = path.join(root, "stage/state");
  write(stateDir, "openclaw.json", "original");
  write(workspaceDir, "SOUL.md", "untouched-workspace");
  write(sourceState, "openclaw.json", "new");
  const transaction = createDirectoryTransaction({
    stateDir,
    workspaceDir,
    rollbackBase: path.join(root, "rollback"),
  });
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from, to) => {
    if (from.endsWith("/live/workspace"))
      throw new Error("simulated second rename failure");
    return rename(from, to);
  });
  assert.throws(
    () => transaction.replaceFrom({ stateDir: sourceState }),
    /simulated/,
  );
  fault.mock.restore();
  transaction.rollback();
  assert.equal(
    fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
    "original",
  );
  assert.equal(
    fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"),
    "untouched-workspace",
  );
});

test("rollback can resume after one original directory was already restored", (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, "live/state");
  const workspaceDir = path.join(root, "live/workspace");
  const sourceState = path.join(root, "stage/state");
  write(stateDir, "openclaw.json", "original");
  write(workspaceDir, "SOUL.md", "original-workspace");
  write(sourceState, "openclaw.json", "new");
  const transaction = createDirectoryTransaction({
    stateDir,
    workspaceDir,
    rollbackBase: path.join(root, "rollback"),
  });
  transaction.replaceFrom({ stateDir: sourceState });
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from, to) => {
    if (to.endsWith("/live/state"))
      throw new Error("simulated restore failure");
    return rename(from, to);
  });
  assert.throws(() => transaction.rollback(), /simulated restore/);
  fault.mock.restore();
  transaction.rollback();
  assert.equal(
    fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
    "original",
  );
  assert.equal(
    fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"),
    "original-workspace",
  );
});

test("snapshot cleanup failure cannot trigger a rollback after commit", (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, "live/state");
  const workspaceDir = path.join(root, "live/workspace");
  const sourceState = path.join(root, "stage/state");
  write(stateDir, "openclaw.json", "original");
  write(sourceState, "openclaw.json", "new");
  const transaction = createDirectoryTransaction({
    stateDir,
    workspaceDir,
    rollbackBase: path.join(root, "rollback"),
  });
  transaction.replaceFrom({ stateDir: sourceState });
  const remove = fs.rmSync;
  const fault = t.mock.method(fs, "rmSync", (target, options) => {
    if (target.startsWith(path.join(fs.realpathSync(root), "rollback")))
      throw new Error("simulated cleanup failure");
    return remove(target, options);
  });
  const result = transaction.commit();
  fault.mock.restore();
  assert.equal(transaction.phase, "committed");
  assert.equal(result.cleanupErrors.length, 1);
  assert.throws(() => transaction.rollback(), /current phase/);
  assert.equal(
    fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
    "new",
  );
});

test("unsafe rollback and staged overlaps fail before original data moves", (t) => {
  const root = fixture(t);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  write(stateDir, "openclaw.json", "original");
  assert.throws(
    () =>
      createDirectoryTransaction({
        stateDir,
        workspaceDir,
        rollbackBase: path.join(stateDir, "rollback"),
      }),
    /outside/,
  );
  const transaction = createDirectoryTransaction({
    stateDir,
    workspaceDir,
    rollbackBase: path.join(root, "rollback"),
  });
  assert.throws(() => transaction.replaceFrom({ stateDir }), /overlaps/);
  assert.equal(
    fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
    "original",
  );
});

test("official manifest resolves nested resources through their covering state asset", (t) => {
  const root = fixture(t);
  const archiveRoot = "2026-backup";
  const archivePath = `${archiveRoot}/payload/posix/custom/state`;
  write(root, `${archivePath}/openclaw.json`, "{}");
  write(root, `${archivePath}/workspace/SOUL.md`);
  write(
    root,
    `${archiveRoot}/manifest.json`,
    JSON.stringify({
      schemaVersion: 1,
      archiveRoot,
      paths: {
        stateDir: "/custom/state",
        workspaceDirs: ["/custom/state/workspace"],
      },
      assets: [{ kind: "state", sourcePath: "/custom/state", archivePath }],
    }),
  );
  const layout = readOfficialBackupLayout(root);
  assert.equal(layout.stateDir, path.join(root, archivePath));
  assert.equal(layout.workspaceDir, path.join(root, archivePath, "workspace"));
  assert.throws(
    () => layout.resolveSource("/not-captured/agent"),
    /required configured source/,
  );
});
