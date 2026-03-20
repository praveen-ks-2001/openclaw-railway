/**
 * utils/validation.js
 *
 * Validates the setup form submission.
 * Returns { errors: string[], data: object }
 */

export function validateSetupForm(body) {
  const errors = [];
  const data = {};

  // ── Model provider — at least one API key required ─────────────
  const hasAnyKey =
    body.anthropicApiKey ||
    body.openaiApiKey    ||
    body.openrouterApiKey ||
    body.groqApiKey      ||
    body.googleApiKey;

  if (!hasAnyKey) {
    errors.push('At least one model provider API key is required.');
  }

  // Copy all provider API keys (strip whitespace)
  for (const key of ['anthropicApiKey','openaiApiKey','openrouterApiKey','groqApiKey','googleApiKey']) {
    data[key] = (body[key] || '').trim();
  }

  // ── Model selection ─────────────────────────────────────────────
  data.model = (body.model || 'anthropic/claude-opus-4-6').trim();
  data.fallbackModel = (body.fallbackModel || '').trim();

  // ── Gateway token ───────────────────────────────────────────────
  // If not provided we generate a random one
  data.gatewayToken = (body.gatewayToken || '').trim() || generateToken(32);

  // ── Channels ────────────────────────────────────────────────────

  // Telegram
  data.telegramBotToken  = (body.telegramBotToken  || '').trim();
  data.telegramDmPolicy  = oneOf(body.telegramDmPolicy, ['pairing','allowlist','open','disabled'], 'pairing');
  data.telegramAllowFrom = (body.telegramAllowFrom || '').trim();
  data.telegramWebhookUrl = (body.telegramWebhookUrl || '').trim();

  if (data.telegramBotToken && !/^\d+:[A-Za-z0-9_-]{35,}$/.test(data.telegramBotToken)) {
    errors.push('Telegram bot token format looks invalid (expected format: 123456:ABCDEF...).');
  }

  // Discord
  data.discordBotToken  = (body.discordBotToken  || '').trim();
  data.discordDmPolicy  = oneOf(body.discordDmPolicy, ['pairing','allowlist','open','disabled'], 'pairing');
  data.discordAllowFrom = (body.discordAllowFrom || '').trim();

  // Slack
  data.slackBotToken = (body.slackBotToken || '').trim();
  data.slackAppToken = (body.slackAppToken || '').trim();
  data.slackDmPolicy = oneOf(body.slackDmPolicy, ['pairing','allowlist','open','disabled'], 'pairing');

  if (data.slackBotToken && !data.slackAppToken) {
    errors.push('Slack requires both a Bot Token and an App Token.');
  }
  if (data.slackAppToken && !data.slackBotToken) {
    errors.push('Slack requires both a Bot Token and an App Token.');
  }

  // Mattermost
  data.mattermostUrl   = (body.mattermostUrl   || '').trim();
  data.mattermostToken = (body.mattermostToken || '').trim();
  data.mattermostTeam  = (body.mattermostTeam  || '').trim();

  if (data.mattermostUrl && !data.mattermostToken) {
    errors.push('Mattermost requires both a server URL and a token.');
  }

  // ── Session settings ────────────────────────────────────────────
  data.sessionScope = oneOf(
    body.sessionScope,
    ['main','per-peer','per-channel-peer','per-account-channel-peer'],
    'per-channel-peer'
  );
  data.sessionResetMode = oneOf(body.sessionResetMode, ['off','daily','idle',undefined], undefined);
  data.sessionResetHour = body.sessionResetHour ? String(parseInt(body.sessionResetHour, 10)) : undefined;

  // ── Heartbeat ───────────────────────────────────────────────────
  data.heartbeatEvery = (body.heartbeatEvery || '').trim() || undefined;

  return { errors, data };
}

// ─── Helpers ─────────────────────────────────────────────────────

function oneOf(val, allowed, fallback) {
  if (allowed.includes(val)) return val;
  return fallback;
}

function generateToken(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < bytes; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
