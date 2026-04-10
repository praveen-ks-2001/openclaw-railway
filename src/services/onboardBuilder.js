/**
 * services/onboardBuilder.js
 *
 * Delegates openclaw configuration to `openclaw onboard --non-interactive`
 * instead of building openclaw.json by hand. This keeps us compatible with
 * config schema changes across openclaw versions.
 *
 * Exports:
 *  - buildOnboardArgs(data)   — returns the CLI args array for onboard
 *  - runOpenclaw(args)        — spawns `openclaw <args>` and returns { code, output }
 *  - runConfigSet(key, value) — shorthand for `openclaw config set key value`
 *  - runConfigSetJson(key, v) — shorthand for `openclaw config set --json key <json>`
 *  - runModelsSet(model)      — shorthand for `openclaw models set <model>`
 */

import { spawn } from 'child_process';
import {
  DATA_DIR,
  OPENCLAW_HOME,
  OPENCLAW_GATEWAY_TOKEN,
  GATEWAY_PORT,
} from '../config/index.js';
import { log } from '../utils/log.js';

// ─── Provider → authChoice + CLI flag mapping ───────────────────────
//
// Each entry maps our setup form's `provider` value to:
//   authChoice  — the value passed to `--auth-choice`
//   keyFlag     — the CLI flag for the API key (null if no key needed)
//   extra       — additional static flags (e.g. for Groq's custom endpoint)

const PROVIDER_MAP = {
  anthropic: {
    authChoice: 'apiKey',
    keyFlag: '--anthropic-api-key',
  },
  openai: {
    authChoice: 'openai-api-key',
    keyFlag: '--openai-api-key',
  },
  google: {
    authChoice: 'gemini-api-key',
    keyFlag: '--gemini-api-key',
  },
  openrouter: {
    authChoice: 'openrouter-api-key',
    keyFlag: '--openrouter-api-key',
  },
  groq: {
    // Groq has no native authChoice — use custom endpoint (OpenAI-compatible API)
    authChoice: 'custom-api-key',
    keyFlag: '--custom-api-key',
    extra: [
      '--custom-base-url', 'https://api.groq.com/openai/v1',
      '--custom-compatibility', 'openai',
    ],
  },
  moonshot: {
    authChoice: 'moonshot-api-key',
    keyFlag: '--moonshot-api-key',
  },
  zai: {
    authChoice: 'zai-api-key',
    keyFlag: '--zai-api-key',
  },
  minimax: {
    authChoice: 'minimax-global-api',
    keyFlag: '--minimax-api-key',
  },
  ollama: {
    authChoice: 'ollama',
    keyFlag: null, // no API key
  },
};

// ─── Build onboard args ─────────────────────────────────────────────

export function buildOnboardArgs(data) {
  const workspaceDir = `${DATA_DIR}/.openclaw/workspace`;

  const args = [
    'onboard',
    '--non-interactive',
    '--accept-risk',
    '--json',
    '--no-install-daemon',
    '--skip-health',
    '--workspace', workspaceDir,
    '--gateway-bind', 'loopback',
    '--gateway-port', String(GATEWAY_PORT),
    '--gateway-auth', 'token',
    '--gateway-token', OPENCLAW_GATEWAY_TOKEN,
    '--flow', 'quickstart',
  ];

  const mapping = PROVIDER_MAP[data.provider];
  if (!mapping) {
    throw new Error(`Unknown provider: ${data.provider}`);
  }

  args.push('--auth-choice', mapping.authChoice);

  // API key (all providers except ollama)
  if (mapping.keyFlag && data.apiKey) {
    args.push(mapping.keyFlag, data.apiKey);
  }

  // Static extra flags (e.g. Groq's custom base URL)
  if (mapping.extra) {
    args.push(...mapping.extra);
  }

  // Ollama-specific: pass URL and bare model ID via --custom-* flags
  if (data.provider === 'ollama') {
    if (data.ollamaUrl) {
      args.push('--custom-base-url', data.ollamaUrl);
    }
    if (data.model) {
      // Strip "ollama/" prefix — onboard expects bare model ID (e.g. "deepseek-r1:1.5b")
      const bareModel = data.model.startsWith('ollama/')
        ? data.model.slice(7)
        : data.model;
      args.push('--custom-model-id', bareModel);
    }
  }

  return args;
}

// ─── CLI runner ─────────────────────────────────────────────────────

const OPENCLAW_ENV = {
  ...process.env,
  HOME: DATA_DIR,
  OPENCLAW_STATE_DIR: OPENCLAW_HOME,
};

/**
 * Spawns `openclaw <args>` and returns { code, output }.
 * All commands run with HOME=/data so openclaw writes to the volume.
 */
export function runOpenclaw(args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', args, {
      env: OPENCLAW_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr?.on('data', (d) => { out += d.toString('utf8'); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      out += '\n[timeout] openclaw command timed out\n';
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

// ─── Convenience wrappers ───────────────────────────────────────────

export async function runConfigSet(key, value) {
  const result = await runOpenclaw(['config', 'set', key, value]);
  if (result.code !== 0) {
    log.warn(`config set ${key} failed (exit=${result.code}): ${result.output}`);
  }
  return result;
}

export async function runConfigSetJson(key, value) {
  const result = await runOpenclaw([
    'config', 'set', '--json', key, JSON.stringify(value),
  ]);
  if (result.code !== 0) {
    log.warn(`config set --json ${key} failed (exit=${result.code}): ${result.output}`);
  }
  return result;
}

export async function runModelsSet(model) {
  const result = await runOpenclaw(['models', 'set', model]);
  if (result.code !== 0) {
    log.warn(`models set ${model} failed (exit=${result.code}): ${result.output}`);
  }
  return result;
}
