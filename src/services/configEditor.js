/** Redacted editing with retained secrets, stale-write checks, and crash recovery. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSON5 from 'json5';
import { DATA_DIR, OPENCLAW_CONFIG_PATH } from '../config/index.js';
import { gatewayManager } from './gatewayManager.js';
import { runCli } from './openclawRuntime.js';
import { stopAllTerminalSessions } from './terminalService.js';
import { withExclusiveOperation, withStateRead, setBootFailure } from './operations.js';

export const REDACTED = '[redacted]';
const transactionDir = path.join(DATA_DIR, '.openclaw-wrapper');
const transactionPath = path.join(transactionDir, 'config-editor-transaction.json');
const revisionOf = (raw) => createHash('sha256').update(raw).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);

function sensitiveKey(key, parentKey) {
  return /^(?:api[-_]?key|access[-_]?key|secret[-_]?key|token|bot[-_]?token|app[-_]?token|access[-_]?token|refresh[-_]?token|password|passphrase|secret|client[-_]?secret|private[-_]?key|service[-_]?account|credential|credentials|authorization|auth|key)$/i.test(key) || /^(?:headers|httpHeaders)$/i.test(parentKey || '');
}

export function redactConfig(value, parentKey = '') {
  if (Array.isArray(value)) return value.map((child) => redactConfig(child, parentKey));
  if (!plain(value)) return value;
  const result = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    result[key] = typeof child === 'string' && child && sensitiveKey(key, parentKey) ? REDACTED : redactConfig(child, key);
  }
  return result;
}

function hasPlaceholder(value) {
  if (value === REDACTED) return true;
  return value && typeof value === 'object' && Object.values(value).some(hasPlaceholder);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
export function retainConfigSecrets(incoming, previous, parentKey = '') {
  if (Array.isArray(incoming)) {
    // A fixed placeholder cannot identify a secret after its list item moves.
    // Refuse ambiguous edits instead of silently binding another item's key.
    if (hasPlaceholder(incoming) && JSON.stringify(canonical(redactConfig(incoming))) !== JSON.stringify(canonical(redactConfig(previous)))) {
      throw fail('An edited or reordered list contains hidden secrets. Keep that list unchanged, or enter its secret values explicitly before saving.');
    }
    return incoming.map((child, index) => retainConfigSecrets(child, previous?.[index], parentKey));
  }
  if (!plain(incoming)) return incoming;
  const result = Object.create(null);
  for (const [key, child] of Object.entries(incoming)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail('This config contains an unsupported object key.');
    if (child === REDACTED) {
      if (!sensitiveKey(key, parentKey) || !Object.hasOwn(previous || {}, key) || typeof previous[key] !== 'string') {
        throw fail('A redacted placeholder has no matching saved secret. Reload the config before saving.');
      }
      result[key] = previous[key];
    } else result[key] = retainConfigSecrets(child, previous?.[key], key);
  }
  return result;
}

async function syncDir(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableReplace(filename, contents) {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filename);
    await syncDir(directory);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

async function clearTransaction() {
  await fs.rm(transactionPath, { force: true });
  await syncDir(transactionDir);
}

/** Called during wrapper boot, before any Gateway or SDK can open user state. */
export async function recoverConfigEdit() {
  let raw;
  try { raw = await fs.readFile(transactionPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let record;
  try { record = JSON.parse(raw); } catch { throw fail('An interrupted config edit has an unreadable recovery record. Preserve the volume and restore its config backup.', 503); }
  if (record.schema !== 1 || typeof record.previous !== 'string' || !/^[a-f0-9]{64}$/.test(record.previousRevision || '') || !/^[a-f0-9]{64}$/.test(record.candidateRevision || '')) {
    throw fail('An interrupted config edit has an invalid recovery record. Preserve the volume and restore its config backup.', 503);
  }
  const previous = Buffer.from(record.previous, 'base64');
  if (revisionOf(previous) !== record.previousRevision) throw fail('The saved config recovery checksum does not match. Automatic recovery was stopped.', 503);
  const current = await fs.readFile(OPENCLAW_CONFIG_PATH);
  const revision = revisionOf(current);
  if (revision === record.candidateRevision) await durableReplace(OPENCLAW_CONFIG_PATH, previous);
  else if (revision !== record.previousRevision) throw fail('The config changed after an interrupted edit. Automatic recovery will not overwrite it. Preserve the volume and inspect the recovery backup.', 503);
  await clearTransaction();
  return true;
}

export async function readEditableConfig() {
  return withStateRead('read-config', async () => {
    let raw;
    try { raw = await fs.readFile(OPENCLAW_CONFIG_PATH); } catch (error) { if (error.code === 'ENOENT') throw fail('No config found.', 404); throw error; }
    let parsed;
    try { parsed = JSON5.parse(raw.toString()); } catch { throw fail('The saved config is not valid JSON. Preserve a backup and repair it before using this editor.', 409); }
    return { config: redactConfig(parsed), revision: revisionOf(raw) };
  });
}

/** Dependency injection lets regressions verify rollback with actual filesystem IO. */
export function createConfigEditor({ gateway = gatewayManager, cli = runCli, stopTerminals = stopAllTerminalSessions } = {}) {
  return async function updateConfig(incoming, revision) {
    if (!plain(incoming)) throw fail('config must be a JSON object.');
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw fail('Reload the config before saving; its revision is required.', 409);
    return withExclusiveOperation('save-config', async ({ signal }) => {
      const previous = await fs.readFile(OPENCLAW_CONFIG_PATH);
      if (revisionOf(previous) !== revision) throw fail('The config changed since you loaded it. Copy your draft, reload the saved config, and apply your edits again.', 409);
      const candidate = retainConfigSecrets(incoming, JSON5.parse(previous.toString()));
      const candidateRaw = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
      await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
      const scratch = await fs.mkdtemp(path.join(transactionDir, 'config-check-'));
      try {
        const candidatePath = path.join(scratch, 'openclaw.json');
        await durableReplace(candidatePath, candidateRaw);
        const result = await cli(['config', 'validate', '--json'], { signal, timeoutMs: 90000, env: { OPENCLAW_CONFIG_PATH: candidatePath } });
        // Avoid returning upstream diagnostics that can contain submitted secrets.
        let validation;
        try {
          const output = result.output.trim();
          const end = output.lastIndexOf('}');
          for (let start = output.indexOf('{'); start >= 0; start = output.indexOf('{', start + 1)) {
            try { validation = JSON.parse(output.slice(start, end + 1)); break; } catch { /* skip diagnostics before JSON */ }
          }
        } catch { /* fail closed below */ }
        if (result.code !== 0 || validation?.valid !== true) throw fail('OpenClaw rejected this configuration. Your saved config was not changed. Check the fields against the current OpenClaw schema.');
      } finally { await fs.rm(scratch, { recursive: true, force: true }); }

      await stopTerminals();
      const wasRunning = gateway.isRunning();
      await gateway.stop();
      if (revisionOf(await fs.readFile(OPENCLAW_CONFIG_PATH)) !== revision) {
        if (wasRunning) await gateway.start();
        throw fail('The Gateway changed its config while saving. Copy your draft and reload the current config before retrying.', 409);
      }
      try {
        await durableReplace(transactionPath, JSON.stringify({ schema: 1, previous: previous.toString('base64'), previousRevision: revision, candidateRevision: revisionOf(candidateRaw) }) + '\n');
        await durableReplace(OPENCLAW_CONFIG_PATH, candidateRaw);
        if (wasRunning) await gateway.start();
        await clearTransaction();
        return { revision: revisionOf(await fs.readFile(OPENCLAW_CONFIG_PATH)), message: wasRunning ? 'Config saved and Gateway startup verified.' : 'Config saved and validated. The Gateway remains stopped.' };
      } catch (error) {
        try {
          await gateway.stop();
          await durableReplace(OPENCLAW_CONFIG_PATH, previous);
          if (wasRunning) await gateway.start();
          await clearTransaction();
        } catch {
          setBootFailure('Config edit rollback requires attention. Preserve the volume and recover the saved configuration before retrying.');
          throw fail('The config could not be applied, and its recovery could not finish. Your previous config is retained in the private recovery journal. Preserve the volume before recovery.', 503);
        }
        throw fail('The Gateway could not start with your edit. The previous config was restored. Reload the saved config before trying again.', 500);
      }
    });
  };
}

export const updateEditableConfig = createConfigEditor();
