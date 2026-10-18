/**
 * utils/validation.js
 *
 * Validates the setup form submission.
 * Returns { errors: string[], data: object }
 */

export function validateSetupForm(body) {
  const errors = [];
  const data = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {errors: ['Invalid setup form.'], data};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0')) {
      errors.push(`Invalid ${key}: use a text value without null bytes (maximum 16384 characters).`);
    }
  }
  if (errors.length) return {errors, data};

  // ── Provider ──────────────────────────────────────────────────
  data.provider = (body.provider || '').trim();

  const VALID_PROVIDERS = [
    // Major AI labs
    'anthropic', 'openai', 'google', 'deepseek', 'xai', 'mistral',
    // Multi-model gateways
    'openrouter', 'together', 'litellm', 'aigateway', 'synthetic', 'cloudflare',
    'fireworks', 'deepinfra', 'novita', 'gmi',
    // Specialized / other
    'groq', 'huggingface', 'venice', 'chutes', 'kilocode', 'opencode',
    'cerebras', 'nvidia', 'arcee', 'ollamacloud',
    // Asia / regional
    'moonshot', 'zai', 'minimax', 'modelstudio', 'kimi', 'tokenhub',
    'volcengine', 'qianfan', 'xiaomi', 'byteplus',
    // Self-hosted / local
    'ollama', 'vllm', 'sglang', 'custom',
  ];

  if (!data.provider) {
    errors.push('Please select a model provider.');
  } else if (!VALID_PROVIDERS.includes(data.provider)) {
    errors.push('Invalid provider selected.');
  }

  // ── Auth mode (apiKey | oauth) ────────────────────────────────
  // OAuth here means a *device-code* flow (URL + short code, no browser
  // callback) — the only kind that works on a headless Railway container.
  // Keep this list in sync with OAUTH_AUTH_CHOICE in onboardBuilder.js.
  data.authMode = oneOf(body.authMode, ['apiKey', 'oauth'], 'apiKey');
  const OAUTH_SUPPORTED_PROVIDERS = ['openai', 'xai'];
  if (data.authMode === 'oauth' && !OAUTH_SUPPORTED_PROVIDERS.includes(data.provider)) {
    errors.push(`OAuth login is not available for ${data.provider}.`);
  }

  // ── API key ───────────────────────────────────────────────────
  data.apiKey = (body.apiKey || '').trim();
  const NO_API_KEY_PROVIDERS = ['ollama', 'vllm', 'sglang'];
  const isOauth = data.authMode === 'oauth';
  if (!isOauth && !NO_API_KEY_PROVIDERS.includes(data.provider) && !data.apiKey) {
    errors.push('API key is required.');
  }

  // ── Ollama URL ────────────────────────────────────────────────
  data.ollamaUrl = (body.ollamaUrl || '').trim();
  if (data.provider === 'ollama') {
    if (!data.ollamaUrl) {
      errors.push('Ollama base URL is required (e.g. http://localhost:11434).');
    } else if (!/^https?:\/\/.+/.test(data.ollamaUrl)) {
      errors.push('Ollama base URL must start with http:// or https://');
    }
  }

  // ── Custom / vLLM / SGLang base URL ──────────────────────────
  data.customUrl = (body.customUrl || '').trim();
  if (['vllm', 'sglang', 'custom'].includes(data.provider)) {
    if (!data.customUrl) {
      errors.push('Base URL is required for ' + data.provider.toUpperCase() + '.');
    } else if (!/^https?:\/\/.+/.test(data.customUrl)) {
      errors.push('Base URL must start with http:// or https://');
    }
  }

  if (data.provider === 'custom' && !(body.model || '').trim()) errors.push('Model ID is required for a custom endpoint.');

  // ── Cloudflare AI Gateway extra fields ────────────────────────
  data.cloudflareAccountId = (body.cloudflareAccountId || '').trim();
  data.cloudflareGatewayId = (body.cloudflareGatewayId || '').trim();
  if (data.provider === 'cloudflare') {
    if (!data.cloudflareAccountId) errors.push('Cloudflare Account ID is required.');
    if (!data.cloudflareGatewayId) errors.push('Cloudflare Gateway ID is required.');
  }

  // ── Custom compatibility ──────────────────────────────────────
  // 'openai-responses' (OpenAI Responses API) added as a valid mode in 2026.6.x.
  data.customCompatibility = oneOf(body.customCompatibility, ['openai', 'openai-responses', 'anthropic', ''], '');

  // ── Model selection ───────────────────────────────────────────
  data.model = (body.model || '').trim() || undefined;

  // Ollama requires a model (no default — depends on what's pulled locally)
  if (data.provider === 'ollama' && !data.model) {
    errors.push('Model is required for Ollama (e.g. ollama/llama3.3).');
  }

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

  if (Boolean(data.mattermostUrl) !== Boolean(data.mattermostToken)) {
    errors.push('Mattermost requires both a server URL and a token.');
  }

  for (const key of ['ollamaUrl', 'customUrl', 'mattermostUrl', 'telegramWebhookUrl']) {
    if (!data[key]) continue;
    try {
      const url = new URL(data[key]);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new Error();
    } catch { errors.push(`${key} must be an HTTP(S) URL without embedded credentials or a fragment.`); }
  }
  for (const channel of ['telegram', 'discord']) {
    if (data[`${channel}BotToken`] && data[`${channel}DmPolicy`] === 'allowlist' && !data[`${channel}AllowFrom`]) {
      errors.push(`${channel} allowlist policy requires at least one allowed sender.`);
    }
  }
  if (body.sessionResetHour && (!/^\d{1,2}$/.test(body.sessionResetHour) || Number(body.sessionResetHour) > 23)) {
    errors.push('Session reset hour must be an integer from 0 to 23.');
  }

  // ── Session settings ────────────────────────────────────────────
  data.sessionScope = oneOf(
    body.sessionScope,
    ['main','per-peer','per-channel-peer','per-account-channel-peer'],
    'per-channel-peer'
  );
  data.sessionResetMode = oneOf(body.sessionResetMode, ['off','daily','idle',undefined], undefined);
  data.sessionResetHour = body.sessionResetHour ? String(parseInt(body.sessionResetHour, 10)) : undefined;

  return { errors, data };
}

// ─── Helpers ─────────────────────────────────────────────────────

function oneOf(val, allowed, fallback) {
  if (allowed.includes(val)) return val;
  return fallback;
}
