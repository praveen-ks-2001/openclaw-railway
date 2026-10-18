import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_CATALOG,
  AUTH_GROUPS_PUBLIC,
  ALL_AUTH_OPTIONS,
  AUTH_CHOICE_FLAGS,
  buildOnboardArgs,
  validatePayload,
  requiredOfficialPlugins,
  ensureRequiredPlugins,
  verifyOnboarding,
} from "./openclaw-compat.js";

const argsFor = (payload) =>
  buildOnboardArgs(payload, {
    workspaceDir: "/data/workspace",
    gatewayPort: 18789,
    gatewayToken: "synthetic-gateway-token",
  });
const tmp = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-compat-test-"));
function pluginAt(root, id, name, version = "2026.10.4") {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({ id }),
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version }),
  );
}

test("public catalog keeps supported choice IDs and hides installation/credential internals", () => {
  assert.equal(
    new Set(ALL_AUTH_OPTIONS.map((o) => o.value)).size,
    ALL_AUTH_OPTIONS.length,
  );
  assert.equal(AUTH_CATALOG.length, AUTH_GROUPS_PUBLIC.length);
  for (const g of AUTH_GROUPS_PUBLIC)
    for (const o of g.options)
      for (const secret of [
        "flag",
        "package",
        "plugin",
        "provider",
        "tokenProvider",
      ])
        assert.equal(Object.hasOwn(o, secret), false);
});

test("every API-key catalog entry reaches its exact CLI credential flag", () => {
  for (const o of ALL_AUTH_OPTIONS.filter((o) => o.kind === "key")) {
    const args = argsFor({
      authChoice: o.value,
      authSecret: "synthetic-key",
      customBaseUrl: "https://example.invalid/v1",
      customModelId: "fixture",
      cloudflareAccountId: "fixture-account",
      cloudflareGatewayId: "fixture-gateway",
    });
    assert.equal(
      args[args.indexOf(AUTH_CHOICE_FLAGS[o.value]) + 1],
      "synthetic-key",
      o.value,
    );
    assert(args.includes("--non-interactive"), o.value);
    assert(!args.includes("--classic"), o.value);
  }
  assert.deepEqual(
    argsFor({ authChoice: "apiKey", authSecret: "fixture" }).slice(-2),
    ["--anthropic-api-key", "fixture"],
  );
  assert(argsFor({ authChoice: "apiKey" }).includes("--token-provider"));
});

test("device-code onboarding retains interactive classic setup and skips every unrelated prompt", () => {
  for (const authChoice of ["openai-device-code", "xai-device-code"]) {
    const args = argsFor({ authChoice });
    assert(!args.includes("--non-interactive"));
    assert(!args.includes("--json"));
    for (const flag of [
      "--classic",
      "--skip-hooks",
      "--skip-channels",
      "--skip-skills",
      "--skip-search",
      "--skip-ui",
      "--suppress-gateway-token-output",
    ])
      assert(args.includes(flag));
  }
});

test("payload validation rejects malformed and incomplete inputs before a subprocess runs", () => {
  for (const bad of [
    null,
    [],
    "x",
    {},
    { authChoice: [] },
    { authChoice: "bad" },
    { authChoice: "openai-api-key", authSecret: [] },
    { authChoice: "openai-api-key", model: "nul\0" },
  ])
    assert.equal(typeof validatePayload(bad), "string");
  for (const customBaseUrl of [
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "invalid",
  ])
    assert(
      validatePayload({
        authChoice: "custom-api-key",
        customBaseUrl,
        customModelId: "fixture",
      }),
    );
  assert(
    validatePayload({
      authChoice: "cloudflare-ai-gateway-api-key",
      cloudflareAccountId: "one",
    }),
  );
  assert.equal(
    validatePayload({
      authChoice: "custom-api-key",
      customBaseUrl: "http://10.0.0.1:8000/v1",
      customModelId: "fixture",
      customCompatibility: "openai-responses",
    }),
    null,
  );
});

test("migration detects external channels/providers from persisted configuration", () => {
  const required = requiredOfficialPlugins({
    config: {
      channels: { discord: { enabled: false }, slack: { enabled: true } },
      models: { providers: { "stepfun-plan": {} } },
      auth: { profiles: { "deepseek:default": { provider: "deepseek" } } },
      agents: {
        defaults: {
          model: { primary: "qwen/model", fallbacks: ["zai/model"] },
        },
      },
    },
  });
  assert.deepEqual(required.map((p) => p.plugin).sort(), [
    "deepseek",
    "discord",
    "qwen",
    "slack",
    "stepfun",
    "zai",
  ]);
  assert(required.every((p) => p.selected === false));
});

test("official plugins install at the host's exact release and preserve existing disabled policy", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  await ensureRequiredPlugins({
    stateDir: root,
    config: { channels: { discord: { enabled: false } } },
    runCli: async (args) => {
      if (args[1] === "inspect") {
        const dir = path.join(root, "extensions", "discord");
        return fs.existsSync(dir)
          ? {
              code: 0,
              output: JSON.stringify({
                plugin: { id: "discord", rootDir: dir },
              }),
            }
          : { code: 1 };
      }
      calls.push(args);
      pluginAt(
        path.join(root, "extensions", "discord"),
        "discord",
        "@openclaw/discord",
      );
      return { code: 0 };
    },
  });
  assert.deepEqual(calls, [
    [
      "plugins",
      "install",
      "@openclaw/discord@2026.10.4",
      "--pin",
      "--force",
      "--no-enable",
    ],
  ]);
});

test("selected official provider installs before onboarding and is enabled intentionally", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  await ensureRequiredPlugins({
    stateDir: root,
    payload: { authChoice: "deepseek-api-key" },
    runCli: async (args) => {
      if (args[1] === "inspect") {
        const dir = path.join(root, "extensions", "deepseek");
        return fs.existsSync(dir)
          ? {
              code: 0,
              output: JSON.stringify({
                plugin: { id: "deepseek", rootDir: dir },
              }),
            }
          : { code: 1 };
      }
      calls.push(args);
      pluginAt(
        path.join(root, "extensions", "deepseek"),
        "deepseek",
        "@openclaw/deepseek-provider",
      );
      return { code: 0 };
    },
  });
  assert(!calls[0].includes("--no-enable"));
  assert(calls[0].includes("@openclaw/deepseek-provider@2026.10.4"));
});

test("plugin installation cannot claim success on exit 0 without the expected artifact", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = {
    stateDir: root,
    payload: { discordToken: "fixture" },
    runCli: async (args) => ({ code: args[1] === "inspect" ? 1 : 0 }),
  };
  await assert.rejects(ensureRequiredPlugins(opts), /expected.*artifact/);
  await assert.rejects(
    ensureRequiredPlugins({
      ...opts,
      runCli: async () => ({ code: 1, output: "policy blocked" }),
    }),
    /could not be installed/,
  );
  await assert.rejects(
    ensureRequiredPlugins({ ...opts, version: "latest" }),
    /resolve official plugin release/,
  );
});

test("bundled plugins are reused and local operator-managed replacements are retained", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  pluginAt(
    path.join(root, "dist", "extensions", "discord"),
    "discord",
    "@openclaw/discord",
  );
  await ensureRequiredPlugins({
    openclawRoot: root,
    stateDir: root,
    payload: { discordToken: "fixture" },
    runCli: async () => {
      throw new Error("must not install bundled plugin");
    },
  });
  const local = path.join(root, "custom-discord");
  pluginAt(local, "discord", "local-discord");
  await ensureRequiredPlugins({
    stateDir: root,
    config: {
      channels: { discord: {} },
      plugins: {
        installs: { discord: { source: "path", installPath: local } },
      },
    },
    runCli: async (args) => {
      assert.equal(args[1], "inspect");
      return { code: 1 };
    },
  });
});

test("npm registry paths from another state volume are never treated as installed", async (t) => {
  const root = tmp();
  const outside = tmp();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  pluginAt(outside, "discord", "@openclaw/discord");
  const calls = [];
  await assert.rejects(
    ensureRequiredPlugins({
      stateDir: root,
      payload: { discordToken: "fixture" },
      runCli: async (args) => {
        calls.push(args);
        return args[1] === "inspect"
          ? {
              code: 0,
              output: JSON.stringify({
                plugin: { id: "discord", rootDir: outside },
                install: { source: "npm" },
              }),
            }
          : { code: 0 };
      },
    }),
    /expected.*artifact/,
  );
  assert(calls.some((c) => c[1] === "install"));
  await assert.rejects(
    ensureRequiredPlugins({
      stateDir: root,
      config: {
        channels: { discord: {} },
        plugins: {
          installs: { discord: { source: "path", installPath: outside } },
        },
      },
      allowOperatorPaths: false,
      runCli: async () => ({ code: 1 }),
    }),
    /outside the staged state/,
  );
});

test("OpenAI selections and legacy provider references require the separate Codex runtime", () => {
  for (const input of [
    { config: { plugins: { entries: { codex: { enabled: true } } } } },
    { payload: { authChoice: "openai-device-code" } },
    { payload: { authChoice: "openai-api-key" } },
    {
      config: {
        agents: { entries: { main: { model: "openai-codex/fixture" } } },
      },
    },
  ])
    assert(
      requiredOfficialPlugins(input).some(
        (p) => p.plugin === "codex" && p.package === "@openclaw/codex",
      ),
    );
});

test("onboarding cannot claim success from config existence or auth metadata alone", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdkDir = path.join(root, "dist", "plugin-sdk");
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(sdkDir, "provider-auth.js"),
    "export const ensureAuthProfileStore = () => ({profiles:{}}); export const listProfilesForProvider = () => []; export const isProviderApiKeyConfigured = () => false;",
  );
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { defaults: { model: { primary: "anthropic/fixture" } } },
      auth: {
        profiles: {
          "anthropic:default": { provider: "anthropic", mode: "api_key" },
        },
      },
    }),
  );
  const result = await verifyOnboarding({
    payload: { authChoice: "apiKey" },
    stateDir: root,
    openclawRoot: root,
    configPath,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /credential/);
});

test("enabled official channel plugins remain dependencies before channel credentials exist", () => {
  const required = requiredOfficialPlugins({
    config: {
      plugins: {
        entries: { discord: { enabled: true }, slack: { enabled: true } },
      },
    },
  });
  assert.deepEqual(required.map((p) => p.plugin).sort(), ["discord", "slack"]);
});

test('modular template retains split Mattermost and Google Chat for configured installations', () => {
 const required=requiredOfficialPlugins({config:{channels:{mattermost:{enabled:true},googlechat:{enabled:false,serviceAccount:{source:'env',provider:'default',id:'GOOGLE_CHAT_SERVICE_ACCOUNT'}}}}});
 assert.deepEqual(required.map(item=>[item.plugin,item.package,item.selected]),[
  ['mattermost','@openclaw/mattermost',false],['googlechat','@openclaw/googlechat',false],
 ]);
});
