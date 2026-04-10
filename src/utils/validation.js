/**
 * utils/validation.js
 *
 * Validates the setup form submission.
 * Returns { errors: string[], data: object }
 */

export function validateSetupForm(body) {
  const errors = [];
  const data = {};

  // ── Provider ──────────────────────────────────────────────────
  data.provider = (body.provider || '').trim();

  const VALID_PROVIDERS = [
    // Major AI labs
    'anthropic', 'openai', 'google', 'deepseek', 'xai', 'mistral',
    // Multi-model gateways
    'openrouter', 'together', 'litellm', 'aigateway', 'synthetic', 'cloudflare',
    // Specialized / other
    'groq', 'huggingface', 'venice', 'chutes', 'kilocode', 'opencode',
    // Asia / regional
    'moonshot', 'zai', 'minimax', 'modelstudio', 'volcengine', 'qianfan', 'xiaomi', 'byteplus',
    // Self-hosted / local
    'ollama', 'vllm', 'sglang', 'custom',
  ];

  if (!data.provider) {
    errors.push('Please select a model provider.');
  } else if (!VALID_PROVIDERS.includes(data.provider)) {
    errors.push('Invalid provider selected.');
  }

  // ── API key ───────────────────────────────────────────────────
  data.apiKey = (body.apiKey || '').trim();
  const NO_API_KEY_PROVIDERS = ['ollama', 'vllm', 'sglang'];
  if (!NO_API_KEY_PROVIDERS.includes(data.provider) && !data.apiKey) {
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

  // ── Cloudflare AI Gateway extra fields ────────────────────────
  data.cloudflareAccountId = (body.cloudflareAccountId || '').trim();
  data.cloudflareGatewayId = (body.cloudflareGatewayId || '').trim();
  if (data.provider === 'cloudflare') {
    if (!data.cloudflareAccountId) errors.push('Cloudflare Account ID is required.');
    if (!data.cloudflareGatewayId) errors.push('Cloudflare Gateway ID is required.');
  }

  // ── Custom compatibility ──────────────────────────────────────
  data.customCompatibility = oneOf(body.customCompatibility, ['openai', 'anthropic', ''], '');

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

  return { errors, data };
}

// ─── Helpers ─────────────────────────────────────────────────────

function oneOf(val, allowed, fallback) {
  if (allowed.includes(val)) return val;
  return fallback;
}
