import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpgradeSnapshot } from "./upgrade-snapshot.js";
test("upgrade recovery snapshot survives subsequent migrations and boots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"),
    workspaceDir = path.join(stateDir, "workspace"),
    configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(configPath, '{"old":true}');
  fs.writeFileSync(path.join(stateDir, "database-wal"), "pre-migration");
  fs.writeFileSync(path.join(workspaceDir, "memory"), "preserved");
  const options = { stateDir, workspaceDir, configPath, version: "2026.10.4" };
  const first = createUpgradeSnapshot(options);
  fs.writeFileSync(configPath, '{"migrated":true}');
  assert.equal(createUpgradeSnapshot(options).created, false);
  assert.equal(
    fs.readFileSync(path.join(first.path, "state", "openclaw.json"), "utf8"),
    '{"old":true}',
  );
  assert.equal(
    fs.readFileSync(path.join(first.path, "workspace", "memory"), "utf8"),
    "preserved",
  );
  assert.throws(
    () => createUpgradeSnapshot({ ...options, workspaceDir: root }),
    /overlaps/,
  );
});
