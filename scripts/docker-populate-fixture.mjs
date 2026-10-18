// Populate ONLY an explicitly opted-in disposable 2026.6.6 Docker fixture.
// docker exec -i -u openclaw -e OPENCLAW_FIXTURE_DISPOSABLE=1 NAME \
//   node --input-type=module - < scripts/docker-populate-fixture.mjs
// Never emits CLI output, credentials, device tokens, or configuration values.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const state = path.resolve(process.env.OPENCLAW_STATE_DIR || "/data/.openclaw");
const workspace = path.resolve(process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace");
const entry = process.env.OPENCLAW_ENTRY || "/usr/local/lib/node_modules/openclaw/dist/entry.js";
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(state, "openclaw.json");
const summary = { officialCli: [], authoredFiles: 0, customizedBootstrapFiles: 0, approvedSyntheticDevices: 0, disabledChannels: 0, cronJobs: 0, completedCommandRuns: 0 };
function assert(value, message) { if (!value) throw new Error(message); }
function json(filename, fallback = {}) { return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : fallback; }
function atomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.fixture-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, filename);
}
async function cli(args, timeout = 120000, mayApproveFixtureCli = true) {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, HOME: "/home/openclaw" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  // Stderr can contain credentials from an upstream diagnostic. Deliberately
  // discard all external output on failures, rather than leaking a useful tail.
  child.stdout.on("data", (chunk) => { stdout += chunk; assert(stdout.length < 5_000_000, "Excessive fixture CLI output"); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-100000); });
  let killTimer;
  const timer = setTimeout(() => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 5000); }, timeout);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timer);
  clearTimeout(killTimer);
  if (code !== 0 && mayApproveFixtureCli && /scope upgrade pending approval|pairing required/.test(stdout + stderr)) {
    const sdk = await import(pathToFileURL(path.join(path.dirname(entry), "plugin-sdk", "device-bootstrap.js")).href);
    let approved = 0;
    for (const pending of (await sdk.listDevicePairing(state)).pending) {
      if (pending.clientId !== "cli") continue;
      const result = await sdk.approveDevicePairing(pending.requestId, { callerScopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"] }, state);
      assert(result?.status === "approved", "Owned fixture CLI scope upgrade could not be approved");
      approved++;
    }
    if (approved) return cli(args, timeout, false);
  }
  assert(code === 0, `Fixture CLI ${args.slice(0, 2).join(" ")} failed; source output omitted`);
  summary.officialCli.push(args.slice(0, 2).join(" "));
  return stdout;
}
function outputJson(output) {
  try { return JSON.parse(output); } catch {}
  const start = Math.min(...[output.indexOf("{"), output.indexOf("[")].filter((n) => n >= 0));
  assert(Number.isFinite(start), "CLI did not return JSON");
  return JSON.parse(output.slice(start));
}
function write(relative, content, mode = 0o600, root = workspace) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content, { mode });
  fs.chmodSync(filename, mode);
  summary.authoredFiles++;
}

try {
  assert(process.env.OPENCLAW_FIXTURE_DISPOSABLE === "1", "Set OPENCLAW_FIXTURE_DISPOSABLE=1 for an owned disposable test volume");
  assert(state.startsWith("/data/") && workspace.startsWith("/data/"), "Fixture must use /data paths inside Docker");
  assert(fs.existsSync(configPath), "Onboard the baseline before populating it");
  assert(/2026\.6\.6/.test(await cli(["--version"])), "Fixture supports exact baseline 2026.6.6 only");

  // Author schedules through the real baseline Gateway API via its CLI. Both
  // stay disabled; only the deterministic local command is manually executed.
  let listed = outputJson(await cli(["cron", "list", "--all", "--json"]));
  let jobs = Array.isArray(listed) ? listed : listed.jobs || [];
  let command = jobs.find((job) => job.name === "upgrade-fixture-command-history");
  if (!command) command = outputJson(await cli([
    "cron", "add", "--name", "upgrade-fixture-command-history", "--description", "Local deterministic migration history fixture", "--disabled", "--cron", "0 0 1 1 *", "--tz", "UTC", "--exact", "--agent", "main", "--session", "isolated", "--no-deliver", "--command-argv", JSON.stringify([process.execPath, "-e", 'process.stdout.write("upgrade-history-local-command-731\\n")']), "--command-cwd", workspace, "--timeout-seconds", "15", "--json",
  ]));
  assert(command.id && command.enabled === false, "Command fixture must remain disabled");
  if (!jobs.some((job) => job.name === "upgrade-fixture-future-reminder")) await cli([
    "cron", "add", "--name", "upgrade-fixture-future-reminder", "--description", "Never executed; tests authored prompt/model/schedule retention", "--disabled", "--cron", "15 7 * * 1", "--tz", "Asia/Kolkata", "--exact", "--agent", "main", "--session", "isolated", "--message", "Keep the migration fixture reminder amber-cabin-731", "--no-deliver", "--json",
  ]);
  await cli(["cron", "run", command.id, "--wait", "--wait-timeout", "1m", "--timeout", "90000"], 100000);
  const database = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"), { readOnly: true, allowExtension: false });
  try {
    const count = Number(database.prepare("SELECT COUNT(*) AS n FROM cron_run_logs WHERE job_id=?").get(command.id).n);
    assert(count > 0, "Command run must produce actual retained cron history");
    summary.completedCommandRuns = count;
    summary.cronJobs = Number(database.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE name LIKE 'upgrade-fixture-%' AND enabled=0").get().n);
    assert(summary.cronJobs === 2, "Both fixture schedules must remain disabled");
  } finally { database.close(); }

  // The public old SDK exposes approval but not request creation. Seed only
  // one valid synthetic pending request; official approval owns token creation.
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const deviceId = createHash("sha256").update(publicKey).digest("hex");
  const requestId = randomUUID();
  const pendingPath = path.join(state, "devices", "pending.json");
  const pending = json(pendingPath);
  pending[requestId] = { requestId, deviceId, publicKey: publicKey.toString("base64url"), displayName: "Upgrade fixture approved browser", platform: "linux", clientId: "openclaw-control-ui", clientMode: "webchat", role: "operator", roles: ["operator"], scopes: ["operator.read"], ts: Date.now() };
  atomicJson(pendingPath, pending);
  const sdk = await import(pathToFileURL(path.join(path.dirname(entry), "plugin-sdk", "device-bootstrap.js")).href);
  const approval = await sdk.approveDevicePairing(requestId, { callerScopes: ["operator.admin", "operator.read"] }, state);
  assert(approval?.status === "approved", "Public SDK must approve synthetic browser");
  assert((await sdk.listDevicePairing(state)).paired.some((record) => record.deviceId === deviceId), "Public SDK must read committed synthetic approval");
  summary.approvedSyntheticDevices = 1;

  // Second workspace is inside state, so the wrapper's existing recovery
  // coverage includes it. No extra model call is made for this agent.
  const secondary = path.join(state, "workspace-archivist");
  const agents = outputJson(await cli(["agents", "list", "--json"]));
  const roster = Array.isArray(agents) ? agents : agents.agents || [];
  if (!roster.some((agent) => agent.id === "archivist")) await cli(["agents", "add", "archivist", "--workspace", secondary, "--non-interactive", "--json"]);
  write("MEMORY.md", "# Archivist fixture memory\nThe archived migration marker is violet-ledger-284.\n", 0o600, secondary);
  write("memory/2026-10-16.md", "An authored second-agent note must survive the OpenClaw version migration.\n", 0o600, secondary);

  write("projects/upgrade-fixture/README.md", "# Existing user project\nThis project was created on the old image and must retain its contents.\n");
  write("projects/upgrade-fixture/notes/नमस्ते-你好.md", "नमस्ते · 你好 · Existing-user Unicode content\n");
  write("projects/upgrade-fixture/assets/binary.bin", Buffer.from(Array.from({ length: 256 }, (_, index) => index)));
  write("projects/upgrade-fixture/bin/verify.sh", "#!/bin/sh\nprintf 'existing-user-executable-731\\n'\n", 0o700);
  write("memory/2026-10-16-upgrade-fixture.md", "# Upgrade verification memory\nThe existing-user retention marker is amber-cabin-731.\nRetain this authored daily memory across upgrades.\n");
  const memoryPath = path.join(workspace, "MEMORY.md");
  const currentMemory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, "utf8") : "# Long-term memory\n";
  write("MEMORY.md", currentMemory + (currentMemory.includes("amber-cabin-731") ? "" : "\n## Existing user upgrade fixture\nThe retention marker is amber-cabin-731.\n"));

  // Make generated bootstrap documents user-authored too. An upstream refresh
  // of pristine templates must never conceal overwriting real user additions.
  for (const root of [workspace, secondary]) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filename = path.join(root, entry.name);
      const marker = `Preserve this original user addition in ${entry.name} (retention-fixture-942).`;
      if (!fs.readFileSync(filename, "utf8").includes(marker)) {
        fs.appendFileSync(filename, `\n## Authored existing-user customization\n${marker}\n`);
        summary.authoredFiles++;
      }
      summary.customizedBootstrapFiles++;
    }
  }

  // Preserve real provider state without reading or emitting credential files.
  // Only this disposable fixture receives obviously invalid disabled channels.
  const config = json(configPath);
  const original = fs.readFileSync(configPath);
  config.channels ||= {};
  config.channels.telegram = { enabled: false, botToken: "0000000000:TEST_ONLY_NOT_A_REAL_TELEGRAM_TOKEN", dmPolicy: "allowlist", allowFrom: ["100000001"], groupPolicy: "allowlist", groupAllowFrom: ["-100000002"], streaming: { mode: "partial" } };
  config.channels.discord = { enabled: false, token: "TEST_ONLY_NOT_A_REAL_DISCORD_TOKEN", groupPolicy: "allowlist", dm: { policy: "pairing" } };
  config.channels.slack = { enabled: false, botToken: "xoxb-test-only-not-valid", appToken: "xapp-test-only-not-valid", groupPolicy: "allowlist", dm: { enabled: true, policy: "pairing" }, channels: { C12345678: { enabled: true, requireMention: true } } };
  config.agents ||= {};
  config.agents.defaults ||= {};
  config.agents.defaults.memorySearch = { enabled: true, provider: "none", sources: ["memory"] };
  atomicJson(configPath, config);
  try { await cli(["config", "validate", "--json"]); }
  catch (error) { fs.writeFileSync(configPath, original, { mode: 0o600 }); throw error; }
  summary.disabledChannels = 3;
  // provider=none is the official lexical/FTS mode; no embedding request,
  // local model download, provider key lookup, or AI inference is required.
  await cli(["memory", "index", "--agent", "main", "--force"], 180000);
  await cli(["memory", "index", "--agent", "archivist", "--force"], 180000);
  process.stdout.write(JSON.stringify({ ok: true, ...summary }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: "Disposable fixture population failed", stage: summary.officialCli.at(-1) || "preflight", errorType: error?.name || "Error", ...summary }) + "\n");
  process.exitCode = 1;
}
