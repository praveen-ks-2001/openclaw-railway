/** Bound CLI/SDK processes that use the same persistent roots as the Gateway. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../core/command-runner.js';
import {
  DATA_DIR, OPENCLAW_HOME, WORKSPACE_DIR, OPENCLAW_CONFIG_PATH,
  OPENCLAW_ENTRY, OPENCLAW_NODE, OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD,
} from '../config/index.js';

export const openclawRoot = path.dirname(path.dirname(path.resolve(OPENCLAW_ENTRY)));
const sdkWorker = fileURLToPath(new URL('../core/sdk-worker.js', import.meta.url));

export function openclawEnvironment(overrides = {}) {
  return {
    ...process.env,
    HOME: DATA_DIR,
    OPENCLAW_STATE_DIR: OPENCLAW_HOME,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    OPENCLAW_CONFIG_PATH,
    OPENCLAW_NO_AUTO_UPDATE: '1',
    ...overrides,
  };
}

function argumentSecrets(args) {
  const values = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (/^--(?:.*(?:api-key|token|secret|password))$/.test(args[i])) values.push(args[i + 1]);
  }
  return values;
}

export function runCli(args, options = {}) {
  return runCommand(OPENCLAW_NODE, [OPENCLAW_ENTRY, ...args], {
    ...options,
    env: openclawEnvironment(options.env),
    secrets: [OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD, ...argumentSecrets(args), ...(options.secrets || [])],
  });
}

function deviceSdkPath() {
  try {
    return createRequire(path.resolve(OPENCLAW_ENTRY)).resolve('openclaw/plugin-sdk/device-bootstrap');
  } catch {
    return path.join(openclawRoot, 'dist', 'plugin-sdk', 'device-bootstrap.js');
  }
}

/** The worker exits after each operation so SQLite owners never survive a reset. */
export async function runSdk(action, payload = {}) {
  const request = typeof action === 'object' ? { ...action } : { ...payload, action };
  const { signal, timeoutMs = 60_000, env, ...message } = request;
  if (message.action?.startsWith('devices-')) message.sdkPath ||= deviceSdkPath();
  const result = await runCommand(OPENCLAW_NODE, [sdkWorker], {
    env: openclawEnvironment({ ...env, WRAPPER_SDK_REQUEST: JSON.stringify(message) }),
    signal,
    timeoutMs,
    secrets: [OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD],
  });
  const encoded = result.output.match(/WRAPPER_SDK_RESULT:([A-Za-z0-9+/=]+)/)?.[1];
  if (!encoded) throw new Error(`OpenClaw state operation did not complete (exit ${result.code})`);
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (result.code !== 0 || decoded.error) throw new Error(decoded.error || 'OpenClaw state operation failed');
  return decoded.result;
}
