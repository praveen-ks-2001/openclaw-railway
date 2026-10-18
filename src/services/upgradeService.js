import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, WORKSPACE_DIR, RECOVERY_ROOT,
  OPENCLAW_NODE, OPENCLAW_GATEWAY_TOKEN, PORT } from '../config/index.js';
import { PINNED_OPENCLAW_VERSION, assertPinnedRuntime } from '../utils/version.js';
import { createUpgradeRecovery } from '../core/upgrade-recovery.js';
import { migrateWrapperConfig, readSourceStateSchema } from '../core/config-migration.js';
import { migrateRetiredPluginIndex } from '../core/legacy-migration.js';
import { ensureRequiredPlugins } from '../core/openclaw-compat.js';
import { runCommand } from '../core/command-runner.js';
import { runCli, openclawRoot, openclawEnvironment } from './openclawRuntime.js';
import { gatewayManager, assertGatewayAbsent } from './gatewayManager.js';
import { withExclusiveOperation, getBootFailure, setBootFailure } from './operations.js';
import { log } from '../utils/log.js';
import { recoverConfigEdit } from './configEditor.js';
import { stopAllTerminalSessions } from './terminalService.js';

let recovery;
export function getUpgradeRecovery() {
  recovery ||= createUpgradeRecovery({
    stateDir: OPENCLAW_STATE_DIR, workspaceDir: WORKSPACE_DIR, configPath: OPENCLAW_CONFIG_PATH,
    recoveryRoot: RECOVERY_ROOT, openclawRoot, version: PINNED_OPENCLAW_VERSION,
  });
  return recovery;
}
export async function recoverBeforeStartup() {
  assertPinnedRuntime(); // Read package metadata only; no target CLI or SDK.
  await assertGatewayAbsent();
  const result = getUpgradeRecovery().recover();
  if (result.blocked) setBootFailure('An interrupted or failed upgrade was recovered. Original data is restored. Retry upgrade deliberately from Admin, or restore a compatible backup.');
  return result;
}
export async function prepareGateway({ signal, installPlugins = true, migrateLegacy = true } = {}) {
  signal?.throwIfAborted();
  const sourceConfig = config.readConfigSync();
  if (!sourceConfig) throw new Error('No OpenClaw configuration');
  const sourceStateSchema = readSourceStateSchema(OPENCLAW_STATE_DIR);
  if (sourceConfig.channels?.mattermost?.team !== undefined)
    log.warn('The retired Mattermost team field has no supported target equivalent. Its original value is retained in the pre-upgrade snapshot and config backup; review channel access after upgrade.');
  if (migrateLegacy) {
    await migrateRetiredPluginIndex({
      stateDir: OPENCLAW_STATE_DIR, configPath: OPENCLAW_CONFIG_PATH,
      toolsDir: path.join(DATA_DIR, '.wrapper-migration-tools'), node: OPENCLAW_NODE,
      env: openclawEnvironment(), log: (line) => log.info(line),
      run: (cmd,args,options={}) => runCommand(cmd,args,{ ...options, signal, env:openclawEnvironment(),
        secrets: [OPENCLAW_GATEWAY_TOKEN], onOutput: (line) => log.info(line.trim()) }),
    });
  }
  const current = config.readConfigSync();
  signal?.throwIfAborted();
  const patched = migrateWrapperConfig(current, {
    publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN?.trim(), localPort: PORT,
    sourceConfig, sourceStateSchema,
  });
  patched.gateway ||= {};
  patched.gateway.auth ||= {};
  patched.gateway.auth.mode = 'token';
  patched.gateway.auth.token = OPENCLAW_GATEWAY_TOKEN;
  patched.gateway.bind = 'loopback';
  patched.gateway.port = config.GATEWAY_PORT;
  if (JSON.stringify(patched) !== JSON.stringify(current)) {
    if (!fs.existsSync(OPENCLAW_CONFIG_PATH + '.before-wrapper-upgrade.bak'))
      fs.copyFileSync(OPENCLAW_CONFIG_PATH, OPENCLAW_CONFIG_PATH + '.before-wrapper-upgrade.bak');
    await config.writeConfig(patched);
  }
  if (installPlugins) await ensureRequiredPlugins({
    config: config.readConfigSync(), payload: {}, openclawRoot, stateDir: OPENCLAW_STATE_DIR,
    version: PINNED_OPENCLAW_VERSION,
    runCli: (args) => runCli(args, { timeoutMs: 300000, signal }),
    log: (line) => log.info(String(line).trim()),
  });
}
async function checked(args, signal) {
  const result = await runCli(args, { timeoutMs: 300000, signal });
  if (result.code !== 0) throw new Error(`OpenClaw ${args[0]} failed (exit ${result.code}); recovery data is retained`);
}
export async function runBootUpgrade({ force = false } = {}) {
  if (getBootFailure() && !force) return { blocked: true };
  return withExclusiveOperation(force ? 'retry upgrade' : 'boot upgrade', async ({ signal }) => {
    let attempt;
    let committed = false;
    try {
      await stopAllTerminalSessions();
      await gatewayManager.stop();
      signal.throwIfAborted();
      await recoverConfigEdit();
      attempt = getUpgradeRecovery().begin({ force });
      setBootFailure(null);
      if (attempt.needed) {
        log.info('Durable pre-upgrade snapshot retained:', attempt.snapshotPath);
        gatewayManager.setCanary(true);
        await prepareGateway({ signal, installPlugins: false });
        await checked(['doctor', '--non-interactive', '--repair'], signal);
        await prepareGateway({ signal, migrateLegacy: false });
        await checked(['config', 'validate'], signal);
        await gatewayManager.start({ signal });
        signal.throwIfAborted();
        getUpgradeRecovery().commit();
        committed = true;
        await gatewayManager.stop();
        gatewayManager.setCanary(false);
      }
      signal.throwIfAborted();
      await gatewayManager.start({ signal });
      setBootFailure(null);
      return { ok: true, migrated: Boolean(attempt.needed) };
    } catch (error) {
      let safeToRestore = false;
      try { await gatewayManager.stop(); safeToRestore = true; } catch (stopError) { log.error('Gateway stop requires attention:', stopError.message); }
      gatewayManager.setCanary(false);
      if (attempt?.needed && !committed && safeToRestore) {
        try { getUpgradeRecovery().rollback(); log.warn('Original data restored; failed generation and snapshot retained.'); }
        catch (restoreError) { log.error('Upgrade recovery requires attention:', restoreError.message); }
      }
      setBootFailure('Upgrade failed. Recovery data is retained. Review logs and use Retry upgrade deliberately.');
      throw error;
    }
  }, { allowBootFailure: force });
}
export function adoptVerifiedSetup() { return getUpgradeRecovery().adopt(); }
export function forgetResetRecovery() { return getUpgradeRecovery().forget(); }
