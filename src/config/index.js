import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import JSON5 from 'json5';

export const DATA_DIR = path.resolve(process.env.OPENCLAW_DATA_DIR || '/data');
export const OPENCLAW_HOME = path.join(DATA_DIR, '.openclaw');
export const OPENCLAW_STATE_DIR = OPENCLAW_HOME;
export const WORKSPACE_DIR = path.join(OPENCLAW_HOME, 'workspace');
export const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const OPENCLAW_ENV_PATH = path.join(OPENCLAW_HOME, '.env');
export const SETUP_INCOMPLETE_PATH = path.join(OPENCLAW_HOME, '.wrapper-setup-incomplete');
export const RECOVERY_ROOT = path.join(DATA_DIR, '.wrapper-upgrade-recovery');
export const GATEWAY_PORT = 18789;
export const GATEWAY_HOST = '127.0.0.1';
export const GATEWAY_INTERNAL_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
export const GATEWAY_WS_URL = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;
export const PORT = Number.parseInt(process.env.PORT || '3000', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
export const WRAPPER_ADMIN_PASSWORD = process.env.WRAPPER_ADMIN_PASSWORD || null;
export let OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || null;
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || null;
export const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || '/usr/local/lib/node_modules/openclaw/dist/entry.js';
export const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || process.execPath;

// Establish paths only. Recovery must run before SDKs, CLIs or state writes.
process.env.HOME = DATA_DIR;
process.env.OPENCLAW_STATE_DIR = OPENCLAW_HOME;
process.env.OPENCLAW_WORKSPACE_DIR = WORKSPACE_DIR;
process.env.OPENCLAW_CONFIG_PATH = OPENCLAW_CONFIG_PATH;
process.env.OPENCLAW_NO_AUTO_UPDATE = '1';
process.env.OPENCLAW_SUPERVISOR_MODE = 'external';
process.env.OPENCLAW_SERVICE_REPAIR_POLICY = 'external';

export function readConfigSync() {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) return null;
  const value = JSON5.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OpenClaw config must be an object');
  return value;
}
export function isAlreadyConfiguredSync() {
  return fs.existsSync(OPENCLAW_CONFIG_PATH) && !fs.existsSync(SETUP_INCOMPLETE_PATH);
}
export function atomicWrite(filename, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.wrapper-${crypto.randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
    const parent = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
export function initializeGatewayToken() {
  if (!OPENCLAW_GATEWAY_TOKEN) {
    const existing = readConfigSync()?.gateway?.auth?.token;
    if (typeof existing === 'string' && existing.trim()) OPENCLAW_GATEWAY_TOKEN = existing.trim();
    else {
      try { OPENCLAW_GATEWAY_TOKEN = fs.readFileSync(path.join(OPENCLAW_HOME, 'gateway.token'), 'utf8').trim(); } catch {}
    }
    OPENCLAW_GATEWAY_TOKEN ||= crypto.randomBytes(32).toString('hex');
  }
  process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
  return OPENCLAW_GATEWAY_TOKEN;
}
export const config = {
  DATA_DIR, OPENCLAW_HOME, OPENCLAW_CONFIG_PATH, OPENCLAW_ENV_PATH, OPENCLAW_STATE_DIR,
  WORKSPACE_DIR, SETUP_INCOMPLETE_PATH, GATEWAY_PORT, GATEWAY_HOST, GATEWAY_INTERNAL_URL,
  GATEWAY_WS_URL, PORT, WRAPPER_ADMIN_PASSWORD,
  get OPENCLAW_GATEWAY_TOKEN() { return OPENCLAW_GATEWAY_TOKEN; },
  readConfigSync, isAlreadyConfiguredSync,
  async isAlreadyConfigured() { return isAlreadyConfiguredSync(); },
  async readConfig() { return readConfigSync(); },
  async writeConfig(value) { atomicWrite(OPENCLAW_CONFIG_PATH, JSON.stringify(value, null, 2) + '\n'); },
  async writeEnvFile(values) {
    const lines = Object.entries(values).filter(([,v]) => v && String(v).trim()).map(([k,v]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n\0]/.test(String(v))) throw new Error('Invalid environment entry');
      return `${k}=${v}`;
    });
    atomicWrite(OPENCLAW_ENV_PATH, lines.join('\n') + '\n');
  },
};
export default config;
