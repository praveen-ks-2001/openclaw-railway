import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNormalizedSnapshot,
  restoreOfficialArchive,
} from "./state-backup.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-state-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, contents = name) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function restoredTree(target, mutate = () => {}) {
  const archiveRoot = "synthetic-openclaw-backup";
  const stateArchive = `${archiveRoot}/payload/posix/data/.openclaw`;
  const workspaceArchive = `${archiveRoot}/payload/posix/data/workspace`;
  const manifest = {
    schemaVersion: 1,
    archiveRoot,
    paths: {
      stateDir: "/data/.openclaw",
      configPath: "/data/.openclaw/openclaw.json",
      oauthDir: "/data/.openclaw/credentials",
      workspaceDirs: ["/data/workspace"],
      agentRoots: [
        { agentId: "main", sourcePath: "/data/.openclaw/agents/main/agent" },
      ],
    },
    assets: [
      {
        kind: "state",
        sourcePath: "/data/.openclaw",
        archivePath: stateArchive,
      },
      {
        kind: "workspace",
        sourcePath: "/data/workspace",
        archivePath: workspaceArchive,
      },
    ],
    sqliteSnapshots: [
      { role: "global", sourcePath: "/data/.openclaw/openclaw.sqlite" },
    ],
  };
  write(
    target,
    `${stateArchive}/openclaw.json`,
    '{"agents":{"defaults":{"workspace":"/data/workspace"}}}',
  );
  write(
    target,
    `${stateArchive}/openclaw.sqlite`,
    "official-verified-snapshot",
  );
  write(
    target,
    `${stateArchive}/credentials/provider.json`,
    "synthetic-credential",
  );
  write(target, `${workspaceArchive}/SOUL.md`, "workspace");
  mutate(
    manifest,
    path.join(target, stateArchive),
    path.join(target, workspaceArchive),
  );
  write(target, `${archiveRoot}/manifest.json`, JSON.stringify(manifest));
}

function fakeCli(calls, mutate) {
  return async (args) => {
    calls.push(args);
    if (args[1] === "create")
      fs.writeFileSync(args[args.indexOf("--output") + 1], "verified-archive");
    else if (args[1] === "restore")
      restoredTree(args[args.indexOf("--target") + 1], mutate);
    else assert.fail(`Unexpected CLI operation: ${args[1]}`);
    return { code: 0, output: "not parsed: warnings can precede JSON" };
  };
}

test("export captures with official backup owner and normalizes verified snapshots for legacy ZIP", async (t) => {
  const root = fixture(t);
  const calls = [];
  const layout = await createNormalizedSnapshot({
    runCli: fakeCli(calls),
    scratchDir: root,
  });
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ["backup", "create"],
      ["backup", "restore"],
    ],
  );
  assert.ok(calls[0].includes("--verify"));
  assert.ok(calls.every((call) => call.includes("--json")));
  assert.equal(
    fs.readFileSync(path.join(layout.stateDir, "openclaw.sqlite"), "utf8"),
    "official-verified-snapshot",
  );
  assert.equal(
    fs.readFileSync(path.join(layout.workspaceDir, "SOUL.md"), "utf8"),
    "workspace",
  );
  assert.equal(
    fs.readFileSync(
      path.join(layout.stateDir, "credentials/provider.json"),
      "utf8",
    ),
    "synthetic-credential",
  );
  assert.equal(path.basename(layout.dataRoot), "data");
  assert.ok(layout.stateDir.startsWith(layout.operationDir));
});

test("backup failures clean temporary state and do not reflect subprocess secret output", async (t) => {
  const root = fixture(t);
  await assert.rejects(
    createNormalizedSnapshot({
      runCli: async () => ({ code: 1, output: "secret-token-do-not-return" }),
      scratchDir: root,
    }),
    (error) => {
      assert.match(error.message, /backup creation/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test("normalization resolves authored paths against canonical backup assets", async (t) => {
  const root = fixture(t);
  const runCli = fakeCli([], (manifest) => {
    manifest.paths.stateDir = "/alias/data/.openclaw";
    manifest.paths.configPath = "/alias/data/.openclaw/openclaw.json";
    manifest.paths.oauthDir = "/alias/data/.openclaw/credentials";
    manifest.paths.workspaceDirs = ["/alias/data/workspace"];
    // The durable agent owner is canonical while manifest.paths retains authored aliases.
    manifest.paths.agentRoots = [
      { agentId: "main", sourcePath: "/data/.openclaw/agents/main/agent" },
    ];
  });
  const result = await restoreOfficialArchive("synthetic.tar.gz", {
    runCli,
    scratchDir: root,
  });
  assert.equal(
    fs.readFileSync(path.join(result.workspaceDir, "SOUL.md"), "utf8"),
    "workspace",
  );
  assert.equal(
    fs.readFileSync(path.join(result.stateDir, "openclaw.sqlite"), "utf8"),
    "official-verified-snapshot",
  );
});

test("local capture resolves ancestor aliases for existing config and missing credentials", async (t) => {
  const root = fixture(t);
  const original = path.join(fs.realpathSync(root), "original");
  write(
    original,
    ".openclaw/openclaw.json",
    '{"original":"never read for payload"}',
  );
  fs.mkdirSync(path.join(original, "workspace"));
  const alias = path.join(root, "authored-alias");
  fs.symlinkSync(original, alias);
  const runCli = fakeCli([], (manifest) => {
    manifest.paths.stateDir = path.join(original, ".openclaw");
    manifest.paths.configPath = path.join(alias, ".openclaw/openclaw.json");
    manifest.paths.oauthDir = path.join(alias, ".openclaw/credentials");
    manifest.paths.workspaceDirs = [path.join(alias, "workspace")];
    manifest.paths.agentRoots = [
      {
        agentId: "main",
        sourcePath: path.join(original, ".openclaw/agents/main/agent"),
      },
    ];
    manifest.assets[0].sourcePath = path.join(original, ".openclaw");
    manifest.assets[1].sourcePath = path.join(original, "workspace");
  });
  const result = await restoreOfficialArchive("synthetic.tar.gz", {
    runCli,
    scratchDir: root,
  });
  assert.equal(
    fs.readFileSync(path.join(result.workspaceDir, "SOUL.md"), "utf8"),
    "workspace",
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(result.stateDir, "openclaw.json"), "utf8"),
    /never read/,
  );
});

for (const [description, mutate, expected] of [
  [
    "multiple workspaces",
    (m) => {
      m.paths.workspaceDirs.push("/another/workspace");
    },
    /multiple workspaces|required configured source/,
  ],
  [
    "external agent databases",
    (m) => {
      m.paths.agentRoots[0].sourcePath = "/elsewhere/agent";
    },
    /agent database/,
  ],
  [
    "external credential directories",
    (m) => {
      m.paths.oauthDir = "/elsewhere/credentials";
    },
    /Credentials/,
  ],
  [
    "external active config",
    (m) => {
      m.paths.configPath = "/elsewhere/config.json";
    },
    /active configuration/,
  ],
  [
    "external managed resources",
    (m) => {
      m.assets.push({
        kind: "managed skill",
        sourcePath: "/elsewhere/skill",
        archivePath: `${m.archiveRoot}/payload/posix/elsewhere/skill`,
      });
    },
    /additional external/,
  ],
  [
    "configuration includes",
    (_m, state) => {
      fs.writeFileSync(
        path.join(state, "openclaw.json"),
        '{"$include":"local.json"}',
      );
    },
    /\$include/,
  ],
  [
    "workspace symlinks",
    (_m, _state, workspace) => {
      fs.symlinkSync("SOUL.md", path.join(workspace, "link"));
    },
    /link/,
  ],
]) {
  test(`normalization refuses ${description} instead of silently discarding data`, async (t) => {
    const root = fixture(t);
    await assert.rejects(
      restoreOfficialArchive("synthetic.tar.gz", {
        runCli: fakeCli([], mutate),
        scratchDir: root,
      }),
      expected,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

function nestedWorkspaceTree(manifest, state, oldExternalWorkspace) {
  fs.rmSync(oldExternalWorkspace,{recursive:true,force:true});
  manifest.paths.workspaceDirs=['/data/.openclaw/workspace-archivist','/data/.openclaw/workspace'];
  manifest.assets=manifest.assets.filter(asset=>asset.kind==='state');
  fs.writeFileSync(path.join(state,'openclaw.json'),JSON.stringify({agents:{defaults:{workspace:'/data/.openclaw/workspace'},entries:{main:{workspace:'/data/.openclaw/workspace'},archivist:{workspace:'/data/.openclaw/workspace-archivist'}}}}));
  write(state,'workspace/MEMORY.md','main workspace remains main');
  write(state,'workspace-archivist/memory/नोट.md','secondary authored bytes');
  write(state,'workspace-archivist/custom.bin',Buffer.from([0,1,128,255]));
  fs.chmodSync(write(state,'workspace-archivist/tool.sh','#!/bin/sh\nexit 0\n'),0o755);
}

test('nested multi-agent workspaces retain every root without using manifest order as the main workspace',async t=>{
  const root=fixture(t);
  const snapshot=await createNormalizedSnapshot({scratchDir:root,runCli:fakeCli([],nestedWorkspaceTree)});
  assert.equal(snapshot.workspacesWithinState,true);
  assert.equal(snapshot.workspaceDir,path.join(snapshot.stateDir,'workspace'));
  assert.equal(fs.readFileSync(path.join(snapshot.workspaceDir,'MEMORY.md'),'utf8'),'main workspace remains main');
  assert.equal(fs.readFileSync(path.join(snapshot.stateDir,'workspace-archivist/memory/नोट.md'),'utf8'),'secondary authored bytes');
  assert.deepEqual(fs.readFileSync(path.join(snapshot.stateDir,'workspace-archivist/custom.bin')),Buffer.from([0,1,128,255]));
  assert.equal(fs.statSync(path.join(snapshot.stateDir,'workspace-archivist/tool.sh')).mode&0o777,0o755);
  assert.equal(fs.existsSync(path.join(snapshot.dataRoot,'workspace')),false,'nested workspaces need no duplicate external root');
  const config=JSON.parse(fs.readFileSync(path.join(snapshot.stateDir,'openclaw.json'),'utf8'));
  assert.equal(config.agents.entries.archivist.workspace,'/data/.openclaw/workspace-archivist');
});

test('a separately represented nested workspace asset is overlaid at its exact state-relative location',async t=>{
  const root=fixture(t);
  const runCli=fakeCli([], (manifest,state,external)=>{
    nestedWorkspaceTree(manifest,state,external);
    const archivePath=`${manifest.archiveRoot}/payload/secondary-asset`;
    // Resolve relative to the verified archive root, not the live source path.
    const restoredRoot=state.slice(0,state.indexOf(manifest.archiveRoot));
    const payload=path.join(restoredRoot,archivePath);
    fs.renameSync(path.join(state,'workspace-archivist'),payload);
    manifest.assets.push({kind:'workspace',sourcePath:'/data/.openclaw/workspace-archivist',archivePath});
  });
  const snapshot=await restoreOfficialArchive('synthetic.tar.gz',{runCli,scratchDir:root});
  assert.equal(fs.readFileSync(path.join(snapshot.stateDir,'workspace-archivist/memory/नोट.md'),'utf8'),'secondary authored bytes');
  assert.equal(fs.readFileSync(path.join(snapshot.workspaceDir,'MEMORY.md'),'utf8'),'main workspace remains main');
});

test('multiple workspace archives refuse external, absent, or ambiguous payload owners',async t=>{
  for(const issue of ['external','missing','ambiguous']){
    const root=fixture(t);
    const runCli=fakeCli([], (manifest,state,external)=>{
      nestedWorkspaceTree(manifest,state,external);
      const restoredRoot=state.slice(0,state.indexOf(manifest.archiveRoot));
      if(issue==='external'){
        const archivePath=`${manifest.archiveRoot}/payload/external-workspace`;
        write(path.join(restoredRoot,archivePath),'private.md','must not omit this external root');
        manifest.paths.workspaceDirs.push('/external/workspace');
        manifest.assets.push({kind:'workspace',sourcePath:'/external/workspace',archivePath});
      }else if(issue==='missing'){
        fs.rmSync(path.join(state,'workspace-archivist'),{recursive:true});
      }else{
        for(const name of ['first','second']){
          const archivePath=`${manifest.archiveRoot}/payload/${name}`;
          write(path.join(restoredRoot,archivePath),'different.md',name);
          manifest.assets.push({kind:'workspace',sourcePath:'/data/.openclaw/workspace-archivist',archivePath});
        }
      }
    });
    await assert.rejects(restoreOfficialArchive('synthetic.tar.gz',{runCli,scratchDir:root}),/external root|missing|ambiguous/i);
    assert.deepEqual(fs.readdirSync(root),[]);
  }
});
