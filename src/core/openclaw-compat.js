import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Supported wrapper contracts verified against the 2026.10.4 package. Keep UI
// choice IDs stable; provider IDs and installable plugin IDs are distinct.
export const OPENCLAW_TARGET_VERSION = "2026.10.4";
export const AUTH_CATALOG = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "API key / ChatGPT",
    options: [
      {
        value: "openai-api-key",
        label: "OpenAI API key",
        kind: "key",
        flag: "--openai-api-key",
        provider: "openai",
        plugin: "openai",
      },
      {
        value: "openai-device-code",
        label: "ChatGPT sign-in (device code)",
        hint: "Use a ChatGPT/Codex subscription — no API key",
        kind: "device",
        provider: "openai",
        plugin: "openai",
      },
    ],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "API key",
    options: [
      {
        value: "apiKey",
        label: "Anthropic API key",
        kind: "key",
        flag: "--anthropic-api-key",
        provider: "anthropic",
        plugin: "anthropic",
        tokenProvider: "anthropic",
      },
    ],
  },
  {
    value: "google",
    label: "Google",
    hint: "API key / OAuth",
    options: [
      {
        value: "gemini-api-key",
        label: "Google Gemini API key",
        kind: "key",
        flag: "--gemini-api-key",
        provider: "google",
        plugin: "google",
      },
    ],
  },
  {
    value: "xai",
    label: "xAI (Grok)",
    hint: "API key / OAuth",
    options: [
      {
        value: "xai-api-key",
        label: "xAI API key",
        kind: "key",
        flag: "--xai-api-key",
        provider: "xai",
        plugin: "xai",
      },
      {
        value: "xai-device-code",
        label: "Grok sign-in (device code)",
        hint: "Use a SuperGrok / X Premium subscription — no API key",
        kind: "device",
        provider: "xai",
        plugin: "xai",
      },
    ],
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    hint: "API key",
    options: [
      {
        value: "deepseek-api-key",
        label: "DeepSeek API key",
        kind: "key",
        flag: "--deepseek-api-key",
        provider: "deepseek",
        plugin: "deepseek",
        package: "@openclaw/deepseek-provider",
      },
    ],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key / OAuth",
    options: [
      {
        value: "openrouter-api-key",
        label: "OpenRouter API key",
        kind: "key",
        flag: "--openrouter-api-key",
        provider: "openrouter",
        plugin: "openrouter",
      },
    ],
  },
  {
    value: "mistral",
    label: "Mistral AI",
    hint: "API key",
    options: [
      {
        value: "mistral-api-key",
        label: "Mistral API key",
        kind: "key",
        flag: "--mistral-api-key",
        provider: "mistral",
        plugin: "mistral",
        package: "@openclaw/mistral-provider",
      },
    ],
  },
  {
    value: "together",
    label: "Together AI",
    hint: "API key",
    options: [
      {
        value: "together-api-key",
        label: "Together AI API key",
        kind: "key",
        flag: "--together-api-key",
        provider: "together",
        plugin: "together",
      },
    ],
  },
  {
    value: "huggingface",
    label: "Hugging Face",
    hint: "API key",
    options: [
      {
        value: "huggingface-api-key",
        label: "Hugging Face API key",
        kind: "key",
        flag: "--huggingface-api-key",
        provider: "huggingface",
        plugin: "huggingface",
      },
    ],
  },
  {
    value: "cerebras",
    label: "Cerebras",
    hint: "API key — fast inference",
    options: [
      {
        value: "cerebras-api-key",
        label: "Cerebras API key",
        kind: "key",
        flag: "--cerebras-api-key",
        provider: "cerebras",
        plugin: "cerebras",
        package: "@openclaw/cerebras-provider",
      },
    ],
  },
  {
    value: "fireworks",
    label: "Fireworks AI",
    hint: "API key",
    options: [
      {
        value: "fireworks-api-key",
        label: "Fireworks API key",
        kind: "key",
        flag: "--fireworks-api-key",
        provider: "fireworks",
        plugin: "fireworks",
        package: "@openclaw/fireworks-provider",
      },
    ],
  },
  {
    value: "deepinfra",
    label: "DeepInfra",
    hint: "API key",
    options: [
      {
        value: "deepinfra-api-key",
        label: "DeepInfra API key",
        kind: "key",
        flag: "--deepinfra-api-key",
        provider: "deepinfra",
        plugin: "deepinfra",
        package: "@openclaw/deepinfra-provider",
      },
    ],
  },
  {
    value: "novita",
    label: "Novita AI",
    hint: "API key",
    options: [
      {
        value: "novita-api-key",
        label: "Novita AI API key",
        kind: "key",
        flag: "--novita-api-key",
        provider: "novita",
        plugin: "novita",
        package: "@openclaw/novita-provider",
      },
    ],
  },
  {
    value: "nvidia",
    label: "NVIDIA",
    hint: "API key (build.nvidia.com)",
    options: [
      {
        value: "nvidia-api-key",
        label: "NVIDIA API key",
        kind: "key",
        flag: "--nvidia-api-key",
        provider: "nvidia",
        plugin: "nvidia",
      },
    ],
  },
  {
    value: "gmi",
    label: "GMI Cloud",
    hint: "API key",
    options: [
      {
        value: "gmi-api-key",
        label: "GMI Cloud API key",
        kind: "key",
        flag: "--gmi-api-key",
        provider: "gmi",
        plugin: "gmi",
        package: "@openclaw/gmi-provider",
      },
    ],
  },
  {
    value: "arcee",
    label: "Arcee AI",
    hint: "Direct API key or via OpenRouter",
    options: [
      {
        value: "arceeai-api-key",
        label: "Arcee AI API key",
        kind: "key",
        flag: "--arceeai-api-key",
        provider: "arcee",
        plugin: "arcee",
        package: "@openclaw/arcee-provider",
      },
      {
        value: "arceeai-openrouter",
        label: "Arcee via OpenRouter key",
        kind: "key",
        flag: "--openrouter-api-key",
        provider: "arcee",
        plugin: "arcee",
        package: "@openclaw/arcee-provider",
      },
    ],
  },
  {
    value: "moonshot",
    label: "Moonshot AI",
    hint: "Kimi K2 + Kimi Code",
    options: [
      {
        value: "moonshot-api-key",
        label: "Moonshot AI API key (Global)",
        kind: "key",
        flag: "--moonshot-api-key",
        provider: "moonshot",
        plugin: "moonshot",
        package: "@openclaw/moonshot-provider",
      },
      {
        value: "moonshot-api-key-cn",
        label: "Moonshot AI API key (CN)",
        kind: "key",
        flag: "--moonshot-api-key",
        provider: "moonshot",
        plugin: "moonshot",
        package: "@openclaw/moonshot-provider",
      },
      {
        value: "kimi-code-api-key",
        label: "Kimi Code API key",
        kind: "key",
        flag: "--kimi-code-api-key",
        provider: "kimi",
        plugin: "kimi",
        package: "@openclaw/kimi-provider",
      },
    ],
  },
  {
    value: "zai",
    label: "Z.AI (GLM 4.7)",
    hint: "API key (multiple plans)",
    options: [
      {
        value: "zai-api-key",
        label: "Z.AI API key",
        kind: "key",
        flag: "--zai-api-key",
        provider: "zai",
        plugin: "zai",
        package: "@openclaw/zai-provider",
      },
      {
        value: "zai-coding-global",
        label: "Z.AI Coding (Global)",
        kind: "key",
        flag: "--zai-api-key",
        provider: "zai",
        plugin: "zai",
        package: "@openclaw/zai-provider",
      },
      {
        value: "zai-coding-cn",
        label: "Z.AI Coding (CN)",
        kind: "key",
        flag: "--zai-api-key",
        provider: "zai",
        plugin: "zai",
        package: "@openclaw/zai-provider",
      },
      {
        value: "zai-global",
        label: "Z.AI Standard (Global)",
        kind: "key",
        flag: "--zai-api-key",
        provider: "zai",
        plugin: "zai",
        package: "@openclaw/zai-provider",
      },
      {
        value: "zai-cn",
        label: "Z.AI Standard (CN)",
        kind: "key",
        flag: "--zai-api-key",
        provider: "zai",
        plugin: "zai",
        package: "@openclaw/zai-provider",
      },
    ],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.7 — API key or OAuth",
    options: [
      {
        value: "minimax-global-api",
        label: "MiniMax API key (Global)",
        kind: "key",
        flag: "--minimax-api-key",
        provider: "minimax",
        plugin: "minimax",
      },
      {
        value: "minimax-cn-api",
        label: "MiniMax API key (CN)",
        kind: "key",
        flag: "--minimax-api-key",
        provider: "minimax",
        plugin: "minimax",
      },
    ],
  },
  {
    value: "qwen",
    label: "Qwen / Alibaba Model Studio",
    hint: "DashScope / Model Studio API key",
    options: [
      {
        value: "qwen-api-key",
        label: "Qwen Coding Plan (Global)",
        kind: "key",
        flag: "--modelstudio-api-key",
        provider: "qwen",
        plugin: "qwen",
        package: "@openclaw/qwen-provider",
      },
      {
        value: "qwen-api-key-cn",
        label: "Qwen Coding Plan (CN)",
        kind: "key",
        flag: "--modelstudio-api-key-cn",
        provider: "qwen",
        plugin: "qwen",
        package: "@openclaw/qwen-provider",
      },
      {
        value: "qwen-standard-api-key",
        label: "Qwen Standard (Global)",
        kind: "key",
        flag: "--modelstudio-standard-api-key",
        provider: "qwen",
        plugin: "qwen",
        package: "@openclaw/qwen-provider",
      },
      {
        value: "qwen-standard-api-key-cn",
        label: "Qwen Standard (CN)",
        kind: "key",
        flag: "--modelstudio-standard-api-key-cn",
        provider: "qwen",
        plugin: "qwen",
        package: "@openclaw/qwen-provider",
      },
    ],
  },
  {
    value: "stepfun",
    label: "StepFun",
    hint: "Standard or Plan, Intl/CN",
    options: [
      {
        value: "stepfun-standard-api-key-intl",
        label: "StepFun Standard (Intl)",
        kind: "key",
        flag: "--stepfun-api-key",
        provider: "stepfun",
        plugin: "stepfun",
        package: "@openclaw/stepfun-provider",
      },
      {
        value: "stepfun-standard-api-key-cn",
        label: "StepFun Standard (CN)",
        kind: "key",
        flag: "--stepfun-api-key",
        provider: "stepfun",
        plugin: "stepfun",
        package: "@openclaw/stepfun-provider",
      },
      {
        value: "stepfun-plan-api-key-intl",
        label: "StepFun Plan (Intl)",
        kind: "key",
        flag: "--stepfun-api-key",
        provider: "stepfun-plan",
        plugin: "stepfun",
        package: "@openclaw/stepfun-provider",
      },
      {
        value: "stepfun-plan-api-key-cn",
        label: "StepFun Plan (CN)",
        kind: "key",
        flag: "--stepfun-api-key",
        provider: "stepfun-plan",
        plugin: "stepfun",
        package: "@openclaw/stepfun-provider",
      },
    ],
  },
  {
    value: "tokenhub",
    label: "Tencent TokenHub",
    hint: "API key",
    options: [
      {
        value: "tokenhub-api-key",
        label: "Tencent TokenHub API key",
        kind: "key",
        flag: "--tokenhub-api-key",
        provider: "tencent-tokenhub",
        plugin: "tencent",
        package: "@openclaw/tencent-provider",
      },
    ],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    options: [
      {
        value: "ai-gateway-api-key",
        label: "Vercel AI Gateway API key",
        kind: "key",
        flag: "--ai-gateway-api-key",
        provider: "vercel-ai-gateway",
        plugin: "vercel-ai-gateway",
        package: "@openclaw/vercel-ai-gateway-provider",
      },
    ],
  },
  {
    value: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    hint: "API key + account/gateway IDs",
    options: [
      {
        value: "cloudflare-ai-gateway-api-key",
        label: "Cloudflare AI Gateway API key",
        kind: "key",
        flag: "--cloudflare-ai-gateway-api-key",
        provider: "cloudflare-ai-gateway",
        plugin: "cloudflare-ai-gateway",
        package: "@openclaw/cloudflare-ai-gateway-provider",
      },
    ],
  },
  {
    value: "litellm",
    label: "LiteLLM",
    hint: "Proxy / multi-model router",
    options: [
      {
        value: "litellm-api-key",
        label: "LiteLLM API key",
        kind: "key",
        flag: "--litellm-api-key",
        provider: "litellm",
        plugin: "litellm",
      },
    ],
  },
  {
    value: "venice",
    label: "Venice",
    hint: "API key",
    options: [
      {
        value: "venice-api-key",
        label: "Venice API key",
        kind: "key",
        flag: "--venice-api-key",
        provider: "venice",
        plugin: "venice",
        package: "@openclaw/venice-provider",
      },
    ],
  },
  {
    value: "chutes",
    label: "Chutes",
    hint: "Free tier OAuth or API key",
    options: [
      {
        value: "chutes-api-key",
        label: "Chutes API key",
        kind: "key",
        flag: "--chutes-api-key",
        provider: "chutes",
        plugin: "chutes",
        package: "@openclaw/chutes-provider",
      },
    ],
  },
  {
    value: "kilocode",
    label: "Kilocode",
    hint: "API key",
    options: [
      {
        value: "kilocode-api-key",
        label: "Kilocode API key",
        kind: "key",
        flag: "--kilocode-api-key",
        provider: "kilocode",
        plugin: "kilocode",
        package: "@openclaw/kilocode-provider",
      },
    ],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "Local Copilot proxy",
    options: [
      {
        value: "copilot-proxy",
        label: "Copilot Proxy (local)",
        kind: "none",
        provider: "copilot-proxy",
        plugin: "copilot-proxy",
      },
    ],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    options: [
      {
        value: "synthetic-api-key",
        label: "Synthetic API key",
        kind: "key",
        flag: "--synthetic-api-key",
        provider: "synthetic",
        plugin: "synthetic",
        package: "@openclaw/synthetic-provider",
      },
    ],
  },
  {
    value: "opencode",
    label: "OpenCode",
    hint: "Multi-model proxies",
    options: [
      {
        value: "opencode-zen",
        label: "OpenCode Zen",
        kind: "key",
        flag: "--opencode-zen-api-key",
        provider: "opencode",
        plugin: "opencode",
        package: "@openclaw/opencode-provider",
      },
      {
        value: "opencode-go",
        label: "OpenCode Go",
        kind: "key",
        flag: "--opencode-go-api-key",
        provider: "opencode-go",
        plugin: "opencode-go",
      },
    ],
  },
  {
    value: "regional-cn",
    label: "Other Chinese providers",
    hint: "Xiaomi / Volcengine / BytePlus / Qianfan",
    options: [
      {
        value: "xiaomi-api-key",
        label: "Xiaomi MiMo API key (pay-as-you-go)",
        kind: "key",
        flag: "--xiaomi-api-key",
        provider: "xiaomi",
        plugin: "xiaomi",
        package: "@openclaw/xiaomi-provider",
      },
      {
        value: "xiaomi-token-plan-sgp",
        label: "Xiaomi MiMo Token Plan (Singapore)",
        kind: "key",
        flag: "--xiaomi-token-plan-api-key",
        note: 'Token Plan keys must start with "tp-".',
        provider: "xiaomi-token-plan",
        plugin: "xiaomi",
        package: "@openclaw/xiaomi-provider",
      },
      {
        value: "xiaomi-token-plan-ams",
        label: "Xiaomi MiMo Token Plan (Amsterdam)",
        kind: "key",
        flag: "--xiaomi-token-plan-api-key",
        note: 'Token Plan keys must start with "tp-".',
        provider: "xiaomi-token-plan",
        plugin: "xiaomi",
        package: "@openclaw/xiaomi-provider",
      },
      {
        value: "xiaomi-token-plan-cn",
        label: "Xiaomi MiMo Token Plan (China)",
        kind: "key",
        flag: "--xiaomi-token-plan-api-key",
        note: 'Token Plan keys must start with "tp-".',
        provider: "xiaomi-token-plan",
        plugin: "xiaomi",
        package: "@openclaw/xiaomi-provider",
      },
      {
        value: "volcengine-api-key",
        label: "Volcengine (Doubao) API key",
        kind: "key",
        flag: "--volcengine-api-key",
        provider: "volcengine",
        plugin: "volcengine",
        package: "@openclaw/volcengine-provider",
      },
      {
        value: "byteplus-api-key",
        label: "BytePlus API key",
        kind: "key",
        flag: "--byteplus-api-key",
        provider: "byteplus",
        plugin: "byteplus",
        package: "@openclaw/byteplus-provider",
      },
      {
        value: "qianfan-api-key",
        label: "Baidu Qianfan API key",
        kind: "key",
        flag: "--qianfan-api-key",
        provider: "qianfan",
        plugin: "qianfan",
        package: "@openclaw/qianfan-provider",
      },
    ],
  },
  {
    value: "self-hosted",
    label: "Self-hosted",
    hint: "Ollama / vLLM / SGLang / LM Studio",
    options: [
      {
        value: "ollama",
        label: "Ollama (local)",
        kind: "none",
        note: "Point at a reachable Ollama host; localhost is not available on Railway.",
        provider: "ollama",
        plugin: "ollama",
      },
      {
        value: "ollama-cloud",
        label: "Ollama Cloud",
        kind: "key",
        flag: "--ollama-cloud-api-key",
        provider: "ollama-cloud",
        plugin: "ollama",
      },
      {
        value: "lmstudio",
        label: "LM Studio",
        kind: "key",
        flag: "--lmstudio-api-key",
        provider: "lmstudio",
        plugin: "lmstudio",
      },
      {
        value: "vllm",
        label: "vLLM",
        kind: "none",
        note: "Point at a reachable vLLM server.",
        provider: "vllm",
        plugin: "vllm",
      },
      {
        value: "sglang",
        label: "SGLang",
        kind: "none",
        note: "Point at a reachable SGLang server.",
        provider: "sglang",
        plugin: "sglang",
      },
    ],
  },
  {
    value: "custom",
    label: "Custom provider",
    hint: "OpenAI- or Anthropic-compatible endpoint",
    options: [
      {
        value: "custom-api-key",
        label: "Custom endpoint (base URL + model ID)",
        kind: "key",
        flag: "--custom-api-key",
      },
    ],
  },
];

export const AUTH_GROUPS_PUBLIC = AUTH_CATALOG.map(
  ({ value, label, hint, options }) => ({
    value,
    label,
    hint,
    options: options.map(({ value, label, hint, kind, note }) => ({
      value,
      label,
      hint,
      kind,
      note,
    })),
  }),
);
export const ALL_AUTH_OPTIONS = AUTH_CATALOG.flatMap((group) => group.options);
export const AUTH_CHOICE_FLAGS = Object.fromEntries(
  ALL_AUTH_OPTIONS.filter((o) => o.flag).map((o) => [o.value, o.flag]),
);
export const VALID_AUTH_CHOICES = new Set(ALL_AUTH_OPTIONS.map((o) => o.value));
export const DEVICE_CODE_AUTH_CHOICES = new Set(
  ALL_AUTH_OPTIONS.filter((o) => o.kind === "device").map((o) => o.value),
);
export const requiresInteractiveOnboarding = (payload) =>
  DEVICE_CODE_AUTH_CHOICES.has(payload?.authChoice);

export function buildOnboardArgs(
  payload,
  { workspaceDir, gatewayPort, gatewayToken },
) {
  const interactive = requiresInteractiveOnboarding(payload);
  const args = [
    "onboard",
    "--accept-risk",
    "--no-install-daemon",
    "--skip-health",
    "--skip-hooks",
    "--skip-channels",
    "--skip-skills",
    "--skip-search",
    "--skip-ui",
    "--suppress-gateway-token-output",
    "--workspace",
    workspaceDir,
    "--mode",
    "local",
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(gatewayPort),
    "--gateway-auth",
    "token",
    "--gateway-token",
    gatewayToken,
    "--flow",
    "quickstart",
  ];
  if (interactive) args.push("--classic");
  else args.push("--non-interactive", "--json");
  const option = ALL_AUTH_OPTIONS.find((o) => o.value === payload.authChoice);
  if (option) {
    args.push("--auth-choice", option.value);
    if (option.tokenProvider)
      args.push("--token-provider", option.tokenProvider);
    if (option.flag && payload.authSecret?.trim())
      args.push(option.flag, payload.authSecret.trim());
    if (option.value === "custom-api-key") {
      args.push(
        "--custom-base-url",
        payload.customBaseUrl.trim(),
        "--custom-model-id",
        payload.customModelId.trim(),
      );
      if (payload.customCompatibility?.trim())
        args.push("--custom-compatibility", payload.customCompatibility.trim());
    }
    if (option.value === "cloudflare-ai-gateway-api-key") {
      args.push(
        "--cloudflare-ai-gateway-account-id",
        payload.cloudflareAccountId.trim(),
        "--cloudflare-ai-gateway-gateway-id",
        payload.cloudflareGatewayId.trim(),
      );
    }
  }
  return args;
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return "Invalid setup payload: must be an object";
  if (
    typeof payload.authChoice !== "string" ||
    !VALID_AUTH_CHOICES.has(payload.authChoice)
  )
    return "Select a supported authentication method";
  const fields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
    "customBaseUrl",
    "customModelId",
    "customCompatibility",
    "cloudflareAccountId",
    "cloudflareGatewayId",
  ];
  for (const field of fields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string")
      return `Invalid ${field}: must be a string`;
    if (typeof payload[field] === "string" && payload[field].length > 16_384)
      return `Invalid ${field}: value is too long`;
    if (typeof payload[field] === "string" && payload[field].includes("\0"))
      return `Invalid ${field}: contains a null byte`;
  }
  if (payload.authChoice === "custom-api-key") {
    try {
      const url = new URL(payload.customBaseUrl?.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      return "Custom provider requires an HTTP(S) base URL without embedded credentials";
    }
    if (!payload.customModelId?.trim())
      return "Custom provider requires a model ID";
    if (
      payload.customCompatibility?.trim() &&
      !["openai", "openai-responses", "anthropic"].includes(
        payload.customCompatibility.trim(),
      )
    )
      return "Invalid customCompatibility: use openai, openai-responses, or anthropic";
  }
  if (
    payload.authChoice === "cloudflare-ai-gateway-api-key" &&
    (!payload.cloudflareAccountId?.trim() ||
      !payload.cloudflareGatewayId?.trim())
  )
    return "Cloudflare AI Gateway requires both account and gateway IDs";
  return null;
}

const EXTERNAL_CHANNELS = [
  { plugin: "discord", package: "@openclaw/discord", channel: "discord" },
  { plugin: "slack", package: "@openclaw/slack", channel: "slack" },
  { plugin: "mattermost", package: "@openclaw/mattermost", channel: "mattermost" },
  { plugin: "googlechat", package: "@openclaw/googlechat", channel: "googlechat" },
];
const EXTERNAL_PROVIDERS = [
  ...new Map(
    ALL_AUTH_OPTIONS.filter((o) => o.package).map((o) => [
      o.plugin,
      {
        plugin: o.plugin,
        package: o.package,
        providers: [
          ...new Set(
            ALL_AUTH_OPTIONS.filter((c) => c.plugin === o.plugin).map(
              (c) => c.provider,
            ),
          ),
        ],
      },
    ]),
  ).values(),
];

function configuredProviderIds(config) {
  const refs = new Set(Object.keys(config?.models?.providers ?? {}));
  for (const profile of Object.values(config?.auth?.profiles ?? {}))
    if (typeof profile?.provider === "string") refs.add(profile.provider);
  // Old Codex state is migrated by OpenClaw; do not install a replacement plugin.
  const addModel = (model) => {
    if (typeof model === "string" && model.includes("/"))
      refs.add(model.split("/")[0]);
    if (model && typeof model === "object") {
      addModel(model.primary);
      for (const fallback of model.fallbacks ?? []) addModel(fallback);
    }
  };
  addModel(config?.agents?.defaults?.model);
  for (const agent of config?.agents?.list ?? []) addModel(agent?.model);
  for (const agent of Object.values(config?.agents?.entries ?? {}))
    addModel(agent?.model);
  return refs;
}

export function requiredOfficialPlugins({ config = {}, payload = {} } = {}) {
  const required = new Map();
  const selected = ALL_AUTH_OPTIONS.find((o) => o.value === payload.authChoice);
  const providers = configuredProviderIds(config);
  // OpenAI selections use the separately packaged Codex runtime, including the
  // provider default chosen during API-key onboarding. Old volumes may use its
  // former openai-codex provider ID.
  if (
    selected?.provider === "openai" ||
    providers.has("openai") ||
    providers.has("openai-codex") ||
    config?.agents?.defaults?.runtime === "codex" ||
    config?.plugins?.entries?.codex?.enabled === true
  ) {
    required.set("codex", {
      plugin: "codex",
      package: "@openclaw/codex",
      selected: selected?.provider === "openai",
    });
  }
  for (const plugin of EXTERNAL_PROVIDERS) {
    if (
      selected?.plugin === plugin.plugin ||
      plugin.providers.some((p) => providers.has(p)) ||
      config?.plugins?.entries?.[plugin.plugin]?.enabled === true
    )
      required.set(plugin.plugin, plugin);
  }
  for (const plugin of EXTERNAL_CHANNELS) {
    const requested =
      plugin.channel === "discord"
        ? payload.discordToken?.trim()
        : plugin.channel === "slack"
          ? payload.slackBotToken?.trim() || payload.slackAppToken?.trim()
          : plugin.channel === "mattermost"
            ? payload.mattermostToken?.trim()
            : payload.googleChatServiceAccount?.trim();
    if (
      requested ||
      config?.channels?.[plugin.channel] ||
      config?.plugins?.entries?.[plugin.plugin]?.enabled === true
    )
      required.set(plugin.plugin, { ...plugin, requested: Boolean(requested) });
  }
  return [...required.values()].map((plugin) => ({
    ...plugin,
    selected:
      Boolean(plugin.selected) ||
      selected?.plugin === plugin.plugin ||
      Boolean(plugin.requested),
  }));
}

function readPlugin(root, pluginId) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"),
    );
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    return manifest.id === pluginId
      ? { version: pkg.version, name: pkg.name }
      : null;
  } catch {
    return null;
  }
}

function pathIsWithin(root, candidate) {
  try {
    const relative = path.relative(
      fs.realpathSync(root),
      fs.realpathSync(candidate),
    );
    return (
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}

function parseCliJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    // Some CLI diagnostics are emitted on stderr alongside an otherwise valid
    // machine-readable document; runCli may merge both streams.
    const begin = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (begin >= 0 && end > begin) {
      try {
        return JSON.parse(output.slice(begin, end + 1));
      } catch {}
    }
    return null;
  }
}

async function inspectPlugin(runCli, pluginId) {
  const result = await runCli(["plugins", "inspect", pluginId, "--json"]);
  const report = parseCliJson(result.output || "");
  if (result.code === 0 && !report)
    throw new Error(
      `Could not inspect installed plugin ${pluginId}: CLI returned unreadable metadata`,
    );
  return result.code === 0 && report?.plugin?.id === pluginId ? report : null;
}

// runCli must use the same state/config as the caller and bound execution time.
// Plugin paths and install provenance are read through the official CLI because
// modern releases store the plugin registry in SQLite and npm project roots.
export async function ensureRequiredPlugins({
  config = {},
  payload = {},
  openclawRoot,
  stateDir,
  version = OPENCLAW_TARGET_VERSION,
  runCli,
  log = () => {},
  allowOperatorPaths = true,
}) {
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(
      "Cannot resolve official plugin release from the OpenClaw version",
    );
  const installed = [];
  for (const plugin of requiredOfficialPlugins({ config, payload })) {
    if (
      openclawRoot &&
      readPlugin(
        path.join(openclawRoot, "dist", "extensions", plugin.plugin),
        plugin.plugin,
      )
    )
      continue;
    const report = await inspectPlugin(runCli, plugin.plugin);
    const record =
      report?.install ?? config?.plugins?.installs?.[plugin.plugin];
    const candidate =
      report?.plugin?.rootDir ||
      record?.installPath ||
      path.join(stateDir, "extensions", plugin.plugin);
    const managedCandidate = pathIsWithin(stateDir, candidate);
    const existing = managedCandidate
      ? readPlugin(candidate, plugin.plugin)
      : null;
    if (
      record?.source === "path" ||
      ((report?.plugin?.origin === "workspace" ||
        report?.plugin?.origin === "config") &&
        !record)
    ) {
      if (!managedCandidate && !allowOperatorPaths)
        throw new Error(
          `Imported plugin ${plugin.plugin} points outside the staged state; reinstall it for this deployment`,
        );
      if (!(existing ?? readPlugin(candidate, plugin.plugin)))
        throw new Error(
          `Operator-managed plugin ${plugin.plugin} is missing at its recorded path`,
        );
      log(
        `[plugins] ${plugin.plugin} uses an operator-managed path; retain and verify its host compatibility.\n`,
      );
      continue;
    }
    if (existing && existing.name !== plugin.package)
      throw new Error(
        `Plugin ${plugin.plugin} is provided by a different package; verify it before upgrading`,
      );
    if (existing?.version === version) {
      if (plugin.selected && report?.plugin?.enabled === false) {
        const enabled = await runCli(["plugins", "enable", plugin.plugin]);
        if (enabled.code !== 0)
          throw new Error(
            `Required plugin ${plugin.plugin} could not be enabled (exit ${enabled.code}).`,
          );
      }
      continue;
    }
    const spec = `${plugin.package}@${version}`;
    log(`[plugins] Installing ${spec} for the selected OpenClaw release...\n`);
    const args = ["plugins", "install", spec, "--pin", "--force"];
    // --force acknowledges the fixed official npm source. Installation-policy
    // blocks remain effective; preserve allow/deny and disabled state on upgrade.
    if (!plugin.selected) args.push("--no-enable");
    const result = await runCli(args);
    if (result.code !== 0)
      throw new Error(
        `Required plugin ${plugin.plugin} could not be installed (exit ${result.code}). ${result.output || ""}`,
      );
    const installedReport = await inspectPlugin(runCli, plugin.plugin);
    const actual =
      installedReport?.plugin?.rootDir &&
      pathIsWithin(stateDir, installedReport.plugin.rootDir)
        ? readPlugin(installedReport.plugin.rootDir, plugin.plugin)
        : null;
    if (!actual || actual.name !== plugin.package || actual.version !== version)
      throw new Error(
        `Plugin ${plugin.plugin} install did not produce the expected ${spec} artifact`,
      );
    installed.push(plugin.plugin);
  }
  return installed;
}

// Checks local persistence only. This neither contacts a provider nor establishes
// that an API key, subscription, model entitlement, or remote endpoint works.
export async function verifyOnboarding({
  payload,
  openclawRoot,
  stateDir,
  configPath,
}) {
  const option = ALL_AUTH_OPTIONS.find((o) => o.value === payload?.authChoice);
  if (!option)
    return { ok: false, error: "Unknown selected authentication method" };
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {
      ok: false,
      error: "Onboarding did not write a readable configuration",
    };
  }
  const roster = Object.entries(config.agents?.entries ?? {});
  const entry =
    roster.find(([, agent]) => agent?.default)?.[1] ??
    roster[0]?.[1] ??
    config.agents?.list?.[0];
  const agentDir =
    entry?.agentDir ??
    path.join(stateDir, "agents", roster[0]?.[0] ?? "main", "agent");
  const model =
    typeof config.agents?.defaults?.model === "string"
      ? config.agents.defaults.model
      : config.agents?.defaults?.model?.primary;
  if (typeof model !== "string" || !model.trim())
    return { ok: false, error: "Onboarding did not persist a default model" };
  if (option.value === "custom-api-key") {
    const match = Object.entries(config.models?.providers ?? {}).find(
      ([, p]) =>
        p?.baseUrl?.replace(/\/$/, "") ===
          payload.customBaseUrl.trim().replace(/\/$/, "") &&
        p.models?.some((m) => m.id === payload.customModelId.trim()),
    );
    if (!match)
      return {
        ok: false,
        error: "Custom provider endpoint and model were not persisted",
      };
    if (payload.authSecret?.trim() && !match[1].apiKey)
      return {
        ok: false,
        error: "Custom provider credential was not persisted",
      };
    return { ok: true, provider: match[0], method: option.kind };
  }
  const provider =
    option.value === "arceeai-openrouter" ? "openrouter" : option.provider;
  if (option.kind === "none") {
    const modelProvider = model.split("/")[0];
    const configured =
      modelProvider === provider ||
      Object.hasOwn(config.models?.providers ?? {}, provider);
    return configured
      ? { ok: true, provider, method: option.kind }
      : {
          ok: false,
          error: `Onboarding did not persist the selected ${provider} provider`,
        };
  }
  const sdk = await import(
    pathToFileURL(
      path.join(openclawRoot, "dist", "plugin-sdk", "provider-auth.js"),
    ).href
  );
  if (
    typeof sdk.ensureAuthProfileStore !== "function" ||
    typeof sdk.listProfilesForProvider !== "function"
  )
    return {
      ok: false,
      error:
        "Installed OpenClaw does not expose the expected credential inspection API",
    };
  const store = await sdk.ensureAuthProfileStore(agentDir, {
    config,
    readOnly: true,
    syncExternalCli: false,
    allowKeychainPrompt: false,
  });
  const ids = sdk.listProfilesForProvider(store, provider);
  const profiles = ids.map((id) => store.profiles?.[id]).filter(Boolean);
  const hasKey = profiles.some(
    (p) =>
      p.type === "api_key" &&
      ((typeof p.key === "string" && p.key.trim()) || p.keyRef),
  );
  const hasOAuth = profiles.some(
    (p) =>
      p.type === "oauth" &&
      typeof p.access === "string" &&
      p.access.trim() &&
      (p.expires == null || p.expires > Date.now()),
  );
  const configuredKey =
    typeof sdk.isProviderApiKeyConfigured === "function" &&
    Boolean(
      await sdk.isProviderApiKeyConfigured({ provider, cfg: config, agentDir }),
    );
  const ok = option.kind === "device" ? hasOAuth : hasKey || configuredKey;
  return ok
    ? { ok: true, provider, method: option.kind, profileCount: profiles.length }
    : {
        ok: false,
        error: `Onboarding did not persist a usable local ${provider} ${option.kind === "device" ? "OAuth profile" : "API-key credential"}`,
      };
}
