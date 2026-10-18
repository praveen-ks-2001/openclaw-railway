/** Preserve this template's form IDs while adapting to the pinned OpenClaw CLI. */
import pty from 'node-pty';
import { createOutputFilter } from '../core/command-runner.js';
import { buildOnboardArgs as makeOnboardArgs, ensureRequiredPlugins } from '../core/openclaw-compat.js';
import { config, WORKSPACE_DIR, OPENCLAW_HOME, OPENCLAW_CONFIG_PATH, OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD, GATEWAY_PORT, OPENCLAW_ENTRY, OPENCLAW_NODE } from '../config/index.js';
import { PINNED_OPENCLAW_VERSION } from '../utils/version.js';
import { runCli, runSdk, openclawRoot, openclawEnvironment } from './openclawRuntime.js';

export const OAUTH_AUTH_CHOICE = {
  // provider:authMode → openclaw --auth-choice value
  //
  // Only *device-code* OAuth flows are listed here — they print a short URL +
  // code to stdout and poll, which is the only OAuth style that works on a
  // headless Railway container (no localhost browser callback needed). Redirect
  // /PKCE flows (e.g. openrouter-oauth, qwen-oauth) require a localhost:3000
  // callback the user's browser can't reach, so they are intentionally omitted.
  //
  // NOTE: 'openai-codex-device-code' was renamed to 'openai-device-code' in
  // OpenClaw 2026.6.x. Using the old value breaks OpenAI OAuth onboarding.
  'openai:oauth': 'openai-device-code',
  'xai:oauth':    'xai-device-code',
};

export function isOauthRequest(data) {
  if (!data?.authMode || data.authMode === 'apiKey') return false;
  const key = `${data.provider}:${data.authMode}`;
  return Boolean(OAUTH_AUTH_CHOICE[key]);
}

// ─── Provider → authChoice + CLI flag mapping ───────────────────────
//
// Each entry maps our setup form's `provider` value to:
//   authChoice  — the value passed to `--auth-choice`
//   keyFlag     — the CLI flag for the API key (null if no key needed)
//   extra       — additional static flags (e.g. for Groq's custom endpoint)

export const PROVIDER_MAP = {
  // ── Major AI Labs ────────────────────────────────────────────────
  anthropic:   { authChoice: 'apiKey',                keyFlag: '--anthropic-api-key' },
  openai:      { authChoice: 'openai-api-key',        keyFlag: '--openai-api-key' },
  google:      { authChoice: 'gemini-api-key',        keyFlag: '--gemini-api-key' },
  deepseek:    { authChoice: 'deepseek-api-key',      keyFlag: '--deepseek-api-key' },
  xai:         { authChoice: 'xai-api-key',           keyFlag: '--xai-api-key' },
  mistral:     { authChoice: 'mistral-api-key',       keyFlag: '--mistral-api-key' },

  // ── Multi-Model Gateways ─────────────────────────────────────────
  openrouter:  { authChoice: 'openrouter-api-key',   keyFlag: '--openrouter-api-key' },
  together:    { authChoice: 'together-api-key',     keyFlag: '--together-api-key' },
  litellm:     { authChoice: 'litellm-api-key',      keyFlag: '--litellm-api-key' },
  aigateway:   { authChoice: 'ai-gateway-api-key',   keyFlag: '--ai-gateway-api-key' },
  synthetic:   { authChoice: 'synthetic-api-key',    keyFlag: '--synthetic-api-key' },
  cloudflare:  { authChoice: 'cloudflare-ai-gateway-api-key', keyFlag: '--cloudflare-ai-gateway-api-key' },
  // Added in 2026.6.x — verified to write a valid auth profile via onboard.
  fireworks:   { authChoice: 'fireworks-api-key',    keyFlag: '--fireworks-api-key' },
  deepinfra:   { authChoice: 'deepinfra-api-key',    keyFlag: '--deepinfra-api-key' },
  novita:      { authChoice: 'novita-api-key',       keyFlag: '--novita-api-key' },
  gmi:         { authChoice: 'gmi-api-key',          keyFlag: '--gmi-api-key' },

  // ── Specialized / Other ──────────────────────────────────────────
  groq: {
    // Groq has no native authChoice — use custom endpoint (OpenAI-compatible)
    authChoice: 'custom-api-key',
    keyFlag: '--custom-api-key',
    extra: ['--custom-base-url', 'https://api.groq.com/openai/v1', '--custom-compatibility', 'openai'],
  },
  huggingface: { authChoice: 'huggingface-api-key',  keyFlag: '--huggingface-api-key' },
  venice:      { authChoice: 'venice-api-key',       keyFlag: '--venice-api-key' },
  chutes:      { authChoice: 'chutes-api-key',       keyFlag: '--chutes-api-key' },
  kilocode:    { authChoice: 'kilocode-api-key',     keyFlag: '--kilocode-api-key' },
  opencode:    { authChoice: 'opencode-zen',         keyFlag: '--opencode-zen-api-key' },
  // Added in 2026.6.x — verified to write a valid auth profile via onboard.
  cerebras:    { authChoice: 'cerebras-api-key',     keyFlag: '--cerebras-api-key' },
  nvidia:      { authChoice: 'nvidia-api-key',       keyFlag: '--nvidia-api-key' },
  arcee:       { authChoice: 'arceeai-api-key',      keyFlag: '--arceeai-api-key' },
  // Ollama Cloud is the hosted Ollama service — needs an API key, NOT a base
  // URL (unlike self-hosted `ollama`), so it behaves like a normal key provider.
  ollamacloud: { authChoice: 'ollama-cloud',         keyFlag: '--ollama-cloud-api-key' },

  // ── Asia / Regional ──────────────────────────────────────────────
  moonshot:    { authChoice: 'moonshot-api-key',     keyFlag: '--moonshot-api-key' },
  zai:         { authChoice: 'zai-api-key',          keyFlag: '--zai-api-key' },
  minimax:     { authChoice: 'minimax-global-api',   keyFlag: '--minimax-api-key' },
  // ModelStudio = Alibaba's Qwen Cloud (DashScope). The provider/auth-choice is
  // `qwen-api-key` (Coding Plan, Global/Intl); the key is passed via the
  // `--modelstudio-api-key` flag. The old `modelstudio-api-key` auth-choice was
  // never valid (crashed onboard on both 2026.5.x and 2026.6.x).
  modelstudio: { authChoice: 'qwen-api-key',         keyFlag: '--modelstudio-api-key' },
  // Kimi Coding Plan subscription (Moonshot) — distinct from `moonshot` PAYG.
  kimi:        { authChoice: 'kimi-code-api-key',    keyFlag: '--kimi-code-api-key' },
  tokenhub:    { authChoice: 'tokenhub-api-key',     keyFlag: '--tokenhub-api-key' },
  volcengine:  { authChoice: 'volcengine-api-key',   keyFlag: '--volcengine-api-key' },
  qianfan:     { authChoice: 'qianfan-api-key',      keyFlag: '--qianfan-api-key' },
  xiaomi:      { authChoice: 'xiaomi-api-key',       keyFlag: '--xiaomi-api-key' },
  byteplus:    { authChoice: 'byteplus-api-key',     keyFlag: '--byteplus-api-key' },

  // ── Self-Hosted / Local ──────────────────────────────────────────
  ollama:  { authChoice: 'ollama',         keyFlag: null },
  vllm:    { authChoice: 'vllm',           keyFlag: null },
  sglang:  { authChoice: 'sglang',         keyFlag: null },
  custom:  { authChoice: 'custom-api-key', keyFlag: '--custom-api-key' },
};

export function toAuthPayload(data) {
  const interactive = isOauthRequest(data);
  const mapping = PROVIDER_MAP[data.provider];
  if (!mapping) throw new Error(`Unknown provider: ${data.provider}`);
  const authChoice = interactive ? OAUTH_AUTH_CHOICE[`${data.provider}:${data.authMode}`] : mapping.authChoice;
  return {
    authChoice, authSecret: data.apiKey || '',
    customBaseUrl: data.provider === 'groq' ? 'https://api.groq.com/openai/v1' : data.customUrl || data.ollamaUrl || '',
    customModelId: data.provider === 'groq' ? (data.model?.replace(/^groq\//, '') || 'llama-3.3-70b-versatile') : data.model || '',
    customCompatibility: data.provider === 'groq' ? 'openai' : data.customCompatibility || '',
    cloudflareAccountId: data.cloudflareAccountId || '', cloudflareGatewayId: data.cloudflareGatewayId || '',
    discordToken: data.discordBotToken || '', slackBotToken: data.slackBotToken || '', slackAppToken: data.slackAppToken || '',
    mattermostToken: data.mattermostToken || '', googleChatServiceAccount: data.googleChatServiceAccount || '',
  };
}

export function buildOnboardArgs(data) {
  const payload = toAuthPayload(data);
  const args = makeOnboardArgs(payload, { workspaceDir: WORKSPACE_DIR, gatewayPort: GATEWAY_PORT, gatewayToken: OPENCLAW_GATEWAY_TOKEN });
  if (['ollama', 'vllm', 'sglang'].includes(data.provider)) {
    if (payload.customBaseUrl) args.push('--custom-base-url', payload.customBaseUrl);
    if (data.model) args.push('--custom-model-id', data.provider === 'ollama' ? data.model.replace(/^ollama\//, '') : data.model);
  }
  return args;
}

export async function ensureProviderPlugins(data = {}, options = {}) {
  return ensureRequiredPlugins({
    config: await config.readConfig() || {}, payload: data.provider ? toAuthPayload(data) : {},
    openclawRoot, stateDir: OPENCLAW_HOME, version: PINNED_OPENCLAW_VERSION,
    runCli: args => runCli(args, { ...options, timeoutMs: 300_000 }),
  });
}

export async function verifyProviderPersistence(data, options = {}) {
  const payload = toAuthPayload(data);
  // Only credential presence is needed by this read-only SDK inspection.
  payload.authSecret = payload.authSecret ? 'provided' : '';
  const result = await runSdk('verify-provider', {
    ...options, options: { payload, openclawRoot, stateDir: OPENCLAW_HOME, configPath: OPENCLAW_CONFIG_PATH },
  });
  if (!result?.ok) throw new Error(result?.error || 'Provider credentials were not persisted');
  return result;
}

export function runOpenclaw(args, options = {}) {
  return runCli(args, typeof options === 'number' ? { timeoutMs: options } : options);
}

export function stripAnsi(value) {
  return String(value).replace(/\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\/g, '').replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '');
}

export function cleanPtyOutput(value) {
  const cleaned = stripAnsi(value).split(/\r|\n/).filter(line => line && !/^[\s◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏.-]*(Requesting device code|Waiting for device authorization|Exchanging device code)/.test(line)).join('\n');
  return cleaned ? cleaned + '\n' : '';
}

/** Bounded interactive device-code flow, with chunk-safe credential redaction. */
export function runOpenclawPty(args, options = {}) {
  return new Promise(resolve => {
    let proc, timer, killTimer, reason, finished = false, raw = '', output = '', pendingDisplay = '';
    const emitLine = line => {
      const chunk = cleanPtyOutput(line);
      if (chunk) { output = (output + chunk).slice(-4 * 1024 * 1024); options.onOutput?.(chunk); }
    };
    const sent = new Set();
    const filter = createOutputFilter([OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD, ...(options.secrets || [])], chunk => {
      pendingDisplay += chunk;
      const lines = pendingDisplay.split(/\r|\n/);
      pendingDisplay = lines.pop();
      for (const line of lines) emitLine(line);
      if (pendingDisplay.length > 64 * 1024) { emitLine(pendingDisplay.slice(0, -16 * 1024)); pendingDisplay = pendingDisplay.slice(-16 * 1024); }
    });
    const finish = code => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (reason) filter.write(`\n[${reason}] onboarding did not complete\n`);
      filter.end(); if (pendingDisplay) emitLine(pendingDisplay); pendingDisplay = ''; resolve({ code: reason === 'timeout' ? 124 : reason ? 130 : code, output });
    };
    const stop = why => {
      if (finished || reason) return;
      reason = why;
      try { proc?.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { proc?.kill('SIGKILL'); } catch {} }, options.killAfterMs || 2_000);
    };
    const abort = () => stop('aborted');
    if (options.signal?.aborted) { reason = 'aborted'; finish(130); return; }
    try {
      proc = (options.spawnPty || pty.spawn)(OPENCLAW_NODE, [OPENCLAW_ENTRY, ...args], {
        name: 'xterm-color', cols: 100, rows: 30, cwd: process.cwd(),
        env: openclawEnvironment({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', SSH_CLIENT: '', SSH_TTY: '', SSH_CONNECTION: '', FORCE_COLOR: '0', NO_COLOR: '1' }),
      });
    } catch (err) { filter.write(`\n[spawn error] ${err.message}\n`); finish(127); return; }
    proc.onData(data => {
      raw = (raw + stripAnsi(data)).slice(-64 * 1024);
      for (const {pattern, input} of options.autoInputs || []) {
        if (!sent.has(String(pattern)) && pattern.test(raw)) { sent.add(String(pattern)); proc.write(input); }
      }
      // Redact before adding display line breaks; otherwise a secret split by
      // PTY chunks could be exposed as two separately rendered fragments.
      filter.write(stripAnsi(data));
    });
    proc.onExit(({exitCode, signal}) => finish(exitCode ?? (signal ? 128 : 1)));
    timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 15 * 60_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

async function checked(args, label, options) {
  const result = await runCli(args, options);
  if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code})`);
  return result;
}
export const runConfigSet = (key, value, options = {}) => checked(['config', 'set', key, value], `Configuring ${key}`, options);
export const runConfigSetJson = (key, value, options = {}) => checked(['config', 'set', '--strict-json', key, JSON.stringify(value)], `Configuring ${key}`, options);
export const runModelsSet = (model, options = {}) => checked(['models', 'set', model], 'Setting the model', options);
