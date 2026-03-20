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
 * Returns the env vars that should go in ~/.openclaw/.env
 * Separate from the JSON config so secrets aren't in openclaw.json.
 */
export function buildEnvVars(formData) {
  const env = {};

  if (formData.anthropicApiKey) env.ANTHROPIC_API_KEY = formData.anthropicApiKey;
  if (formData.openaiApiKey) env.OPENAI_API_KEY = formData.openaiApiKey;
  if (formData.openrouterApiKey) env.OPENROUTER_API_KEY = formData.openrouterApiKey;
  if (formData.groqApiKey) env.GROQ_API_KEY = formData.groqApiKey;
  if (formData.googleApiKey) env.GOOGLE_API_KEY = formData.googleApiKey;

  return env;
}

// ─── Section builders ──────────────────────────────────────────────

function buildAgentsSection(formData) {
  const model = formData.model || 'anthropic/claude-opus-4-6';
  const workspace = '/data/.openclaw/workspace';

  return {
    defaults: {
      model: {
        primary: model,
        ...(formData.fallbackModel ? { fallbacks: [formData.fallbackModel] } : {}),
      },
      workspace,
      ...(formData.heartbeatEvery
        ? { heartbeat: { every: formData.heartbeatEvery, target: 'last' } }
        : {}),
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

  // Gateway auth — token protects the Control UI
  if (formData.gatewayToken) {
    section.auth = {
      mode: 'token',
      token: formData.gatewayToken,
    };
  }

  // Allow the wrapper's origin to access the Control UI
  section.controlUi = {
    allowedOrigins: ['*'],
    dangerouslyDisableDeviceAuth: true,
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