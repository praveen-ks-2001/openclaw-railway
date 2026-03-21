/**
 * services/configBuilder.js
 *
 * Takes validated form data and produces a valid openclaw.json object.
 *
 * Design: each section is its own builder function, so adding a new
 * channel or feature is just adding a new function here — nothing else
 * in the codebase needs to change.
 */

/**
 * @param {object} formData — validated fields from the setup form
 * @returns {object} — openclaw.json config object
 */
export function buildOpenclaWConfig(formData) {
  const cfg = {};

  // ── Agent / Model ──────────────────────────────────────────────
  cfg.agents = buildAgentsSection(formData);

  // ── Channels ──────────────────────────────────────────────────
  const channels = {};

  if (formData.telegramBotToken) {
    channels.telegram = buildTelegramSection(formData);
  }
  if (formData.discordBotToken) {
    channels.discord = buildDiscordSection(formData);
  }
  if (formData.slackBotToken && formData.slackAppToken) {
    channels.slack = buildSlackSection(formData);
  }
  if (formData.googleChatServiceAccount) {
    channels.googlechat = buildGoogleChatSection(formData);
  }
  if (formData.mattermostUrl && formData.mattermostToken) {
    channels.mattermost = buildMattermostSection(formData);
  }

  if (Object.keys(channels).length > 0) {
    cfg.channels = channels;
  }

  // ── Gateway ────────────────────────────────────────────────────
  cfg.gateway = buildGatewaySection(formData);

  // ── Session ────────────────────────────────────────────────────
  if (formData.sessionScope) {
    cfg.session = buildSessionSection(formData);
  }

  // ── Env vars (API keys) ────────────────────────────────────────
  // We write these to ~/.openclaw/.env, not into the JSON,
  // to keep secrets out of the config file.
  // The JSON references them via ${VAR_NAME} substitution.

  return cfg;
}

/**
 * Provider → env var mapping.
 * The setup form sends a single provider + apiKey pair.
 */
const PROVIDER_ENV_MAP = {
  anthropic:   'ANTHROPIC_API_KEY',
  openai:      'OPENAI_API_KEY',
  google:      'GOOGLE_API_KEY',
  openrouter:  'OPENROUTER_API_KEY',
  groq:        'GROQ_API_KEY',
};

/**
 * Returns the env vars that should go in ~/.openclaw/.env
 * Separate from the JSON config so secrets aren't in openclaw.json.
 */
export function buildEnvVars(formData) {
  const env = {};
  const envKey = PROVIDER_ENV_MAP[formData.provider];
  if (envKey && formData.apiKey) {
    env[envKey] = formData.apiKey;
  }
  return env;
}

import { OPENCLAW_GATEWAY_TOKEN } from '../config/index.js';

// ─── Section builders ──────────────────────────────────────────────

const PROVIDER_DEFAULT_MODEL = {
  anthropic:  'anthropic/claude-sonnet-4',
  openai:     'openai/gpt-4.1',
  google:     'google/gemini-2.5-pro',
  openrouter: 'openrouter/auto',
  groq:       'groq/llama-3.3-70b-versatile',
};

function buildAgentsSection(formData) {
  const model = formData.model || PROVIDER_DEFAULT_MODEL[formData.provider] || 'anthropic/claude-sonnet-4';
  const workspace = '/data/.openclaw/workspace';

  return {
    defaults: {
      model: {
        primary: model,
        ...(formData.fallbackModel ? { fallbacks: [formData.fallbackModel] } : {}),
      },
      workspace,
    },
  };
}

function buildGatewaySection(formData) {
  const section = {
    // Required: tells openclaw this is a self-hosted local deployment
    mode: 'local',
    // Always loopback — our Express wrapper is the public face
    bind: 'loopback',
    port: 18789,
    reload: { mode: 'hybrid' },
  };

  // Gateway token — always from env var (set in Railway Variables)
  if (OPENCLAW_GATEWAY_TOKEN) {
    section.auth = {
      mode: 'token',
      token: OPENCLAW_GATEWAY_TOKEN,
    };
  }

  // Trust our Express wrapper on loopback — fixes "Proxy headers from untrusted address" warning
  // and restores local client detection for WebSocket connections
  section.trustedProxies = ['127.0.0.1', '::1'];

  // Allow the wrapper's origin to access the Control UI.
  // allowInsecureAuth lets the gateway accept token-based auth from the
  // proxy without requiring device pairing for browser sessions.
  section.controlUi = {
    allowedOrigins: ['*'],
    allowInsecureAuth: true,
  };

  return section;
}

function buildTelegramSection(formData) {
  return {
    botToken: formData.telegramBotToken,
    dmPolicy: formData.telegramDmPolicy || 'pairing',
    ...(formData.telegramAllowFrom
      ? { allowFrom: parseAllowFrom(formData.telegramAllowFrom) }
      : {}),
    ...(formData.telegramWebhookUrl
      ? { webhookUrl: formData.telegramWebhookUrl }
      : {}),
  };
}

function buildDiscordSection(formData) {
  return {
    token: formData.discordBotToken,
    dmPolicy: formData.discordDmPolicy || 'pairing',
    ...(formData.discordAllowFrom
      ? { allowFrom: parseAllowFrom(formData.discordAllowFrom) }
      : {}),
  };
}

function buildSlackSection(formData) {
  return {
    botToken: formData.slackBotToken,
    appToken: formData.slackAppToken,
    dmPolicy: formData.slackDmPolicy || 'pairing',
  };
}

function buildGoogleChatSection(formData) {
  return {
    serviceAccount: formData.googleChatServiceAccount,
  };
}

function buildMattermostSection(formData) {
  return {
    url: formData.mattermostUrl,
    token: formData.mattermostToken,
    ...(formData.mattermostTeam ? { team: formData.mattermostTeam } : {}),
  };
}

function buildSessionSection(formData) {
  return {
    dmScope: formData.sessionScope || 'per-channel-peer',
    reset: formData.sessionResetMode
      ? {
          mode: formData.sessionResetMode,
          ...(formData.sessionResetHour
            ? { atHour: parseInt(formData.sessionResetHour, 10) }
            : {}),
        }
      : undefined,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseAllowFrom(raw) {
  if (!raw) return undefined;
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}