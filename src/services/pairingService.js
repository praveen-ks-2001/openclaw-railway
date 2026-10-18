/** Pairing state is owned by OpenClaw. Each SDK call has a short-lived owner. */
import { EventEmitter } from 'node:events';
import { OPENCLAW_GATEWAY_TOKEN, GATEWAY_WS_URL } from '../config/index.js';
import { runSdk, runCli } from './openclawRuntime.js';
import { assertOperationsAvailable, withExclusiveOperation, withStateRead, isOperationActive } from './operations.js';
import { log } from '../utils/log.js';

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) {
    throw Object.assign(new Error(`${label} is required and must be a valid identifier.`), { status: 400 });
  }
  return value.trim();
}

/** Never send paired credential values or public keys back to the dashboard. */
export function sanitizePairing(value) {
  if (Array.isArray(value)) return value.map(sanitizePairing);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(token|secret|privateKey|publicKey|bootstrapToken)$/i.test(key)) continue;
    clean[key] = sanitizePairing(child);
  }
  return clean;
}

export class PairingService extends EventEmitter {
  constructor({ sdk = runSdk, cli = runCli, intervalMs = 5000 } = {}) {
    super();
    this._sdk = sdk;
    this._cli = cli;
    this._intervalMs = intervalMs;
    this._timer = null;
    this._polling = false;
    this._lastPending = null;
    this._generation = 0;
  }

  async listDevices() {
    assertOperationsAvailable();
    if (this._listPromise) return this._listPromise;
    this._listPromise = withStateRead('list-devices', async ({ signal }) => {
      const data = await this._sdk('devices-list', { signal });
      return {
        pending: sanitizePairing(Array.isArray(data?.pending) ? data.pending : []),
        paired: sanitizePairing(Array.isArray(data?.paired) ? data.paired : []),
      };
    });
    try { return await this._listPromise; } finally { this._listPromise = null; }
  }

  async getPending() { return (await this.listDevices()).pending; }
  async getPaired() { return (await this.listDevices()).paired; }

  async approve(requestId) {
    const target = identifier(requestId, 'requestId');
    return withExclusiveOperation('approve-device', async ({ signal }) => {
      const result = await this._sdk('devices-approve', { requestId: target, signal });
      if (!result) throw Object.assign(new Error('This pairing request no longer exists. Refresh the list and match the requesting browser ID.'), { status: 404 });
      if (result.status === 'forbidden') {
        throw Object.assign(new Error(`Device approval was refused by OpenClaw policy (${result.reason || 'forbidden'}).`), { status: 403 });
      }
      const device = sanitizePairing(result.device);
      this.emit('pairingUpdate', { action: 'approved', requestId: target, device });
      return { requestId: target, device };
    });
  }

  async _command(args, signal) {
    const options = [...args, '--url', GATEWAY_WS_URL, '--timeout', '15000', '--json'];
    if (OPENCLAW_GATEWAY_TOKEN) options.push('--token', OPENCLAW_GATEWAY_TOKEN);
    const result = await this._cli(options, { signal, timeoutMs: 25000 });
    if (result.code !== 0) throw new Error('OpenClaw could not update this device. Check that the Gateway is running, then refresh the device list.');
    return result;
  }

  async reject(requestId) {
    const target = identifier(requestId, 'requestId');
    return withExclusiveOperation('reject-device', async ({ signal }) => {
      await this._command(['devices', 'reject', target], signal);
      this.emit('pairingUpdate', { action: 'rejected', requestId: target });
    });
  }

  async revoke(deviceId, role) {
    const target = identifier(deviceId, 'deviceId');
    const targetRole = role == null || role === '' ? null : identifier(role, 'role');
    return withExclusiveOperation('revoke-device', async ({ signal }) => {
      // Both calls must succeed; never describe a best-effort revoke as success.
      if (targetRole) await this._command(['devices', 'revoke', '--device', target, '--role', targetRole], signal);
      await this._command(['devices', 'remove', target], signal);
      this.emit('pairingUpdate', { action: 'revoked', deviceId: target });
    });
  }

  startWatching() {
    if (this._timer) return;
    const generation = ++this._generation;
    const poll = async () => {
      // A full SDK worker is expensive. Unattended deployments have no SSE
      // consumers, so polling must never compete with inference or startup.
      if (!this.listenerCount('pendingChanged') && !this.listenerCount('pairingUpdate')) return;
      if (this._polling || isOperationActive()) return;
      this._polling = true;
      try {
        const pending = await this.getPending();
        if (generation !== this._generation) return;
        const encoded = JSON.stringify(pending);
        if (encoded !== this._lastPending) {
          this._lastPending = encoded;
          this.emit('pendingChanged', pending);
        }
      } catch (error) {
        if (![409, 503].includes(error.status)) log.debug('Pairing refresh failed:', error.message);
      } finally { this._polling = false; }
    };
    this._timer = setInterval(poll, this._intervalMs);
    this._timer.unref();
    void poll();
  }

  stopWatching() {
    ++this._generation;
    clearInterval(this._timer);
    this._timer = null;
    this._lastPending = null;
  }
}

export const pairingService = new PairingService();

/** Explicit boot probe; never import SDK or touch state during module loading. */
export async function probeDeviceBootstrapSdk() {
  await pairingService.listDevices();
  log.info('OpenClaw device bootstrap SDK worker is ready.');
}
