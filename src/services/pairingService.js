/**
 * services/pairingService.js
 *
 * Manages device pairing state.
 *
 * OpenClaw stores pairing state in:
 *   ~/.openclaw/nodes/pending.json
 *   ~/.openclaw/nodes/paired.json
 *
 * To approve/reject, we call the openclaw CLI:
 *   openclaw devices approve <requestId>
 *   openclaw devices reject <requestId>
 *
 * We also watch the pending.json file with chokidar and emit
 * 'pairingUpdate' events so the admin UI can poll/stream in real time.
 */

import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';
import { OPENCLAW_HOME, DATA_DIR } from '../config/index.js';
import { log } from '../utils/log.js';

const execFileAsync = promisify(execFile);

const PENDING_PATH = path.join(OPENCLAW_HOME, 'nodes', 'pending.json');
const PAIRED_PATH = path.join(OPENCLAW_HOME, 'nodes', 'paired.json');

class PairingService extends EventEmitter {
  constructor() {
    super();
    this._watcher = null;
    this._startWatching();
  }

  async getPending() {
    return readJsonFile(PENDING_PATH, []);
  }

  async getPaired() {
    return readJsonFile(PAIRED_PATH, []);
  }

  /**
   * Approve a pending pair request by calling the openclaw CLI.
   * openclaw writes back to paired.json and removes from pending.json.
   */
  async approve(requestId) {
    log.info(`Approving pairing request: ${requestId}`);
    const env = { ...process.env, HOME: DATA_DIR };
    await execFileAsync('openclaw', ['devices', 'approve', requestId], { env });
    this.emit('pairingUpdate', { action: 'approved', requestId });
  }

  async reject(requestId) {
    log.info(`Rejecting pairing request: ${requestId}`);
    const env = { ...process.env, HOME: DATA_DIR };
    await execFileAsync('openclaw', ['devices', 'reject', requestId], { env });
    this.emit('pairingUpdate', { action: 'rejected', requestId });
  }

  async revoke(deviceId, role) {
    log.info(`Revoking device: ${deviceId} role: ${role}`);
    const env = { ...process.env, HOME: DATA_DIR };
    await execFileAsync('openclaw', ['devices', 'revoke', '--device', deviceId, '--role', role], { env });
    this.emit('pairingUpdate', { action: 'revoked', deviceId });
  }

  _startWatching() {
    // Watch for changes to the pending file so we can push SSE updates
    this._watcher = chokidar.watch(PENDING_PATH, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    this._watcher.on('change', async () => {
      try {
        const pending = await this.getPending();
        this.emit('pendingChanged', pending);
        log.info(`Pairing pending list updated (${pending.length} pending)`);
      } catch { /* file may not exist yet */ }
    });

    this._watcher.on('add', async () => {
      try {
        const pending = await this.getPending();
        this.emit('pendingChanged', pending);
      } catch { /* ignore */ }
    });

    this._watcher.on('error', (err) => {
      log.warn('Pairing file watcher error (non-fatal):', err.message);
    });
  }
}

async function readJsonFile(filePath, defaultVal) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // Normalize: openclaw may store as object map or array
    if (Array.isArray(parsed)) return parsed;
    // Object map: { [id]: {...} }
    return Object.entries(parsed).map(([id, v]) => ({ id, ...v }));
  } catch {
    return defaultVal;
  }
}

export const pairingService = new PairingService();
