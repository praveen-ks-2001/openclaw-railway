/** Existing setup/download contracts with serialized, authenticated state owners. */
import { Router } from 'express';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { config, atomicWrite, OPENCLAW_HOME, WORKSPACE_DIR, SETUP_INCOMPLETE_PATH, OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD, OLLAMA_BASE_URL, PORT } from '../config/index.js';
import { adoptVerifiedSetup, forgetResetRecovery } from '../services/upgradeService.js';
import { gatewayManager } from '../services/gatewayManager.js';
import { pairingService } from '../services/pairingService.js';
import { stopAllTerminalSessions } from '../services/terminalService.js';
import { withExclusiveOperation } from '../services/operations.js';
import { requireAdminAuth } from '../middleware/auth.js';
import {
  buildOnboardArgs, runOpenclaw, runOpenclawPty, runConfigSet, runConfigSetJson,
  runModelsSet, isOauthRequest, ensureProviderPlugins, verifyProviderPersistence,
} from '../services/onboardBuilder.js';
import { runCommand } from '../core/command-runner.js';
import { migrateWrapperConfig } from '../core/config-migration.js';
import { createNormalizedSnapshot } from '../core/state-backup.js';
import { inspectZipArchive } from '../core/state-transfer.js';
import { validateSetupForm } from '../utils/validation.js';
import { log } from '../utils/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const setupRoutes = Router();
setupRoutes.use(requireAdminAuth);

const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const failure = (res, error) => {
  if (!res.headersSent && !res.destroyed) res.status(error.statusCode || error.status || 500).json({ ok: false, error: error.message });
};
const secretValues = data => [data.apiKey, data.telegramBotToken, data.discordBotToken, data.slackBotToken, data.slackAppToken, data.mattermostToken, data.googleChatServiceAccount].filter(Boolean);
const redact = (text, secrets = []) => {
  for (const value of [OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD, ...secrets].filter(Boolean)) text = String(text).split(value).join('[REDACTED]');
  return String(text);
};
function listAllowed(raw, policy) {
  const values = (raw || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  return policy === 'open' ? [...new Set([...values, '*'])] : values;
}

setupRoutes.get('/', route(async (_req, res) => {
  if (gatewayManager.isRunning()) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../../public/setup.html'));
}));
setupRoutes.get('/api/ollama-config', (_req, res) => res.json({ ollamaBaseUrl: OLLAMA_BASE_URL || null }));
setupRoutes.get('/api/ollama-models', route(async (req, res) => {
  const input = typeof req.query.url === 'string' ? req.query.url : OLLAMA_BASE_URL || '';
  let base;
  try {
    base = new URL(input.trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash) throw new Error();
  } catch { return res.status(400).json({ error: 'Provide an HTTP(S) Ollama URL without embedded credentials.' }); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${base.href.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
    if (!response.ok) return res.status(502).json({ error: `Ollama returned HTTP ${response.status}` });
    const json = await response.json();
    res.json({ models: (Array.isArray(json.models) ? json.models : []).map(m => m.name).filter(name => typeof name === 'string') });
  } catch (error) { res.status(502).json({ error: error.name === 'AbortError' ? 'Request timed out — check that your Ollama URL is reachable.' : 'Could not reach the Ollama server.' }); }
  finally { clearTimeout(timer); }
}));

export async function applyPostOnboardConfig(data, options = {}) {
  const emit = options.onOutput || (() => {});
  emit('Configuring gateway settings...\n');
  const patched = migrateWrapperConfig(await config.readConfig(), { publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN?.trim(), localPort: PORT });
  await config.writeConfig(patched);
  await runConfigSet('gateway.auth.token', OPENCLAW_GATEWAY_TOKEN, options);
  if (data.model && !['ollama', 'vllm', 'sglang', 'custom', 'groq'].includes(data.provider)) await runModelsSet(data.model, options);
  if (data.telegramBotToken) {
    await runConfigSetJson('channels.telegram', {
      enabled: true, botToken: data.telegramBotToken, dmPolicy: data.telegramDmPolicy || 'pairing',
      groupPolicy: 'open', streaming: { mode: 'partial' },
      ...(listAllowed(data.telegramAllowFrom, data.telegramDmPolicy).length ? {allowFrom: listAllowed(data.telegramAllowFrom, data.telegramDmPolicy)} : {}),
      ...(data.telegramWebhookUrl ? {webhookUrl: data.telegramWebhookUrl} : {}),
    }, options);
  }
  if (data.discordBotToken) {
    await runConfigSetJson('channels.discord', {
      enabled: true, token: data.discordBotToken, groupPolicy: 'open', dmPolicy: data.discordDmPolicy || 'pairing',
      ...(listAllowed(data.discordAllowFrom, data.discordDmPolicy).length ? {allowFrom: listAllowed(data.discordAllowFrom, data.discordDmPolicy)} : {}),
    }, options);
  }
  if (data.slackBotToken && data.slackAppToken) {
    await runConfigSetJson('channels.slack', {
      enabled: true, botToken: data.slackBotToken, appToken: data.slackAppToken, dmPolicy: data.slackDmPolicy || 'pairing',
      ...(data.slackDmPolicy === 'open' ? { allowFrom: ['*'] } : {}),
    }, options);
  }
  if (data.mattermostUrl && data.mattermostToken) {
    await runConfigSetJson('channels.mattermost', { enabled: true, baseUrl: data.mattermostUrl, botToken: data.mattermostToken }, options);
  }
  if (data.sessionScope) {
    await runConfigSetJson('session', {
      dmScope: data.sessionScope,
      ...(data.sessionResetMode && data.sessionResetMode !== 'off' ? {reset: {mode: data.sessionResetMode, ...(data.sessionResetHour ? {atHour: Number(data.sessionResetHour)} : {})}} : {}),
    }, options);
  }
  const validate = await runOpenclaw(['config', 'validate', '--json'], options);
  if (validate.code !== 0) throw new Error('The saved configuration did not pass OpenClaw validation. Setup has not completed.');
  await verifyProviderPersistence(data, options);
}

setupRoutes.post('/save', route(async (req, res) => {
  const {errors, data} = validateSetupForm(req.body);
  if (errors.length) return res.status(400).json({ok: false, errors});
  const interactive = isOauthRequest(data);
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', close);
  const stream = chunk => { if (chunk && !res.destroyed && !res.writableEnded) res.write(chunk); };
  try {
    await withExclusiveOperation('setup', async ({signal: operationSignal} = {}) => {
      if (gatewayManager.isRunning() || gatewayManager.getState() === 'starting' || await config.isAlreadyConfigured()) {
        const error = new Error('This installation is already configured. Use Admin settings or Reset configuration to rerun setup.'); error.statusCode = 409; throw error;
      }
      await stopAllTerminalSessions();
      await gatewayManager.stop();
      await fs.mkdir(OPENCLAW_HOME, {recursive: true});
      await fs.mkdir(WORKSPACE_DIR, {recursive: true});
      atomicWrite(SETUP_INCOMPLETE_PATH, 'Setup has not completed. Retry setup after correcting the reported error.\n');
      const signal = operationSignal ? AbortSignal.any([operationSignal, controller.signal]) : controller.signal;
      const options = {signal, secrets: secretValues(data)};
      if (interactive) {
        res.set({'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'});
        stream('Starting sign-in. Open the device-code URL below, then keep this page open until setup completes.\n\n');
      }
      await ensureProviderPlugins(data, options);
      const args = buildOnboardArgs(data);
      log.info(`Starting ${interactive ? 'device-code' : 'API-key'} onboarding for ${data.provider}`);
      const onboard = interactive
        ? await runOpenclawPty(args, {...options, onOutput: stream})
        : await runOpenclaw(args, options);
      if (onboard.code !== 0) throw new Error(`OpenClaw onboarding failed (exit ${onboard.code}). Setup has not completed.`);
      if (!await config.readConfig()) throw new Error('OpenClaw onboarding did not persist a readable configuration.');
      await verifyProviderPersistence(data, options);
      await applyPostOnboardConfig(data, {...options, onOutput: interactive ? stream : undefined});
      signal.throwIfAborted();
      await fs.rm(SETUP_INCOMPLETE_PATH, {force: true});
      try {
        await gatewayManager.start({signal});
        signal.throwIfAborted();
        if (!gatewayManager.isRunning()) throw new Error('The Gateway did not become ready. Check Admin logs before retrying.');
        await adoptVerifiedSetup();
        pairingService.startWatching();
      }
      catch (error) {
        atomicWrite(SETUP_INCOMPLETE_PATH, 'Gateway startup after setup failed. Retry setup after inspection.\n');
        await gatewayManager.stop(); throw error;
      }
      if (interactive) { stream('\n[setup] Complete. Open OpenClaw, then approve the matching browser request in Admin → Pairing if prompted.\n'); res.end(); }
      else res.json({ok: true, message: 'Configuration saved. Gateway is ready. Open OpenClaw and approve your browser in Admin → Pairing if prompted.'});
    }, {signal: controller.signal});
  } catch (error) {
    const message = redact(error.message, secretValues(data));
    log.error(`Setup failed: ${message}`);
    if (interactive && res.headersSent) { stream(`\n[setup] Failed: ${message}\n`); if (!res.destroyed) res.end(); }
    else failure(res, Object.assign(new Error(message), {statusCode: error.statusCode || error.status}));
  } finally { res.off('close', close); }
}));

setupRoutes.post('/pairing/approve', route(async (req, res) => {
  const {channel, code} = req.body || {};
  if (typeof channel !== 'string' || !['telegram','discord','slack','mattermost','googlechat'].includes(channel) || typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
    return res.status(400).json({ok: false, error: 'Provide a supported channel and its pairing code.'});
  }
  try {
    await withExclusiveOperation('channel-pairing', async ({signal} = {}) => {
      const result = await runOpenclaw(['pairing', 'approve', channel, code], {signal, timeoutMs: 30_000});
      if (result.code !== 0) throw new Error('Channel pairing failed. Check the code and try again.');
      res.json({ok: true, output: result.output});
    });
  } catch (error) { failure(res, error); }
}));

setupRoutes.post('/reset', route(async (req, res) => {
  const {mode} = req.body || {};
  if (mode !== undefined && !['full', 'config'].includes(mode)) return res.status(400).json({ok: false, error: 'Reset mode must be config or full.'});
  try {
    await withExclusiveOperation('reset', async () => {
      pairingService.stopWatching();
      await stopAllTerminalSessions();
      await gatewayManager.stop();
      if (mode === 'full') {
        // This repo owns nested workspace state. External/custom roots are never deleted.
        await fs.rm(OPENCLAW_HOME, {recursive: true, force: true});
        await fs.mkdir(WORKSPACE_DIR, {recursive: true});
        await fs.mkdir(path.join(OPENCLAW_HOME, 'nodes'), {recursive: true});
        // Recovery journals/snapshots live outside state and deliberately survive reset.
      } else {
        await fs.rm(config.OPENCLAW_CONFIG_PATH, {force: true});
        await fs.rm(config.OPENCLAW_ENV_PATH, {force: true});
        await fs.rm(SETUP_INCOMPLETE_PATH, {force: true});
      }
      forgetResetRecovery();
      // A recovered failed upgrade remains blocked until the explicit Doctor flow.
      res.json({ok: true, message: mode === 'full' ? 'Full reset complete. Data owned by this installation was removed.' : 'Configuration reset. Gateway stopped; stored conversations and workspace files retained.'});
    }, {allowBootFailure: false});
  } catch (error) { failure(res, error); }
}));

setupRoutes.get('/export', route(async (_req, res) => {
  try {
    await withExclusiveOperation('export', async ({signal} = {}) => {
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-export-'));
      const archive = path.join(scratch, 'export.zip');
      const running = gatewayManager.isRunning();
      try {
        await stopAllTerminalSessions();
        await gatewayManager.stop();
        const snapshot = await createNormalizedSnapshot({scratchDir: scratch, runCli: args => runOpenclaw(args, {signal, timeoutMs: 300_000})});
        if (snapshot.sourceWorkspaceDirs.length && !snapshot.workspacesWithinState) {
          const error = new Error('This installation has a workspace outside its OpenClaw state directory. This ZIP export supports nested workspaces only. Use the OpenClaw backup CLI to preserve all configured roots.');
          error.statusCode = 422;
          throw error;
        }
        // Preserve this template's familiar data/.openclaw/workspace ZIP layout.
        // This is staged data from the official SQLite-consistent backup owner.
        if (!snapshot.workspacesWithinState) {
          await fs.cp(snapshot.workspaceDir, path.join(snapshot.stateDir, 'workspace'), {recursive: true, force: true});
        }
        const zip = await runCommand('zip', ['-r', '-P', WRAPPER_ADMIN_PASSWORD, archive, 'data/.openclaw'], {
          cwd: path.dirname(snapshot.dataRoot), signal, timeoutMs: 300_000,
          secrets: [WRAPPER_ADMIN_PASSWORD, OPENCLAW_GATEWAY_TOKEN],
        });
        if (zip.code !== 0) throw new Error('Could not create the protected export archive.');
        inspectZipArchive(await fs.readFile(archive));
        if (running) await gatewayManager.start();
        await new Promise((resolve, reject) => res.download(archive, `openclaw-export-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`, error => error ? reject(error) : resolve()));
      } finally {
        await fs.rm(scratch, {recursive: true, force: true});
        if (running && !gatewayManager.isRunning()) await gatewayManager.start();
      }
    });
  } catch (error) { failure(res, error); }
}));
