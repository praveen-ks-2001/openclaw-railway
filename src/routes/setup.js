/**
 * routes/setup.js
 *
 * GET  /setup       — serve the setup UI HTML
 * POST /setup/save  — write config + launch gateway
 */

import { Router } from 'express';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config, DATA_DIR, OPENCLAW_HOME, OPENCLAW_GATEWAY_TOKEN, WRAPPER_ADMIN_PASSWORD, OLLAMA_BASE_URL } from '../config/index.js';
import { gatewayManager } from '../services/gatewayManager.js';
import {
  buildOnboardArgs, runOpenclaw,
  runConfigSet, runConfigSetJson, runModelsSet,
} from '../services/onboardBuilder.js';
import { validateSetupForm } from '../utils/validation.js';
import { log } from '../utils/log.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const setupRoutes = Router();

// ── GET /setup — redirect to / if gateway already running ──────────

setupRoutes.get('/', async (req, res) => {
  if (gatewayManager.isRunning()) {
    return res.redirect('/');
  }
  // Serve the setup UI HTML (built separately, or served inline)
  const htmlPath = path.join(__dirname, '../../public/setup.html');
  try {
    await fs.access(htmlPath);
    res.sendFile(htmlPath);
  } catch {
    // Fallback: redirect to embedded inline setup
    res.redirect('/api/setup-ui');
  }
});

// ── POST /setup/save — write config and launch ─────────────────────

// ── GET /setup/api/ollama-config — return OLLAMA_BASE_URL env var ──
// Used by the setup page to pre-fill the Ollama URL field on load.

setupRoutes.get('/api/ollama-config', (req, res) => {
  res.json({ ollamaBaseUrl: OLLAMA_BASE_URL || null });
});

// ── GET /setup/api/ollama-models — fetch model list from Ollama ────
// Proxies to {url}/api/tags and returns the list of pulled model names.
// Query param: url (the Ollama base URL entered by the user).

setupRoutes.get('/api/ollama-models', async (req, res) => {
  const baseUrl = (req.query.url || OLLAMA_BASE_URL || '').trim().replace(/\/$/, '');
  if (!baseUrl) {
    return res.status(400).json({ error: 'No Ollama URL provided' });
  }
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) {
      return res.status(502).json({ error: `Ollama returned HTTP ${r.status}` });
    }
    const json = await r.json();
    const models = (json.models || []).map((m) => m.name);
    res.json({ models });
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Request timed out — is the Ollama URL correct and reachable?'
      : `Could not reach Ollama: ${err.message}`;
    res.status(502).json({ error: msg });
  }
});

// ── POST /setup/save — write config + launch gateway ───────────────

setupRoutes.post('/save', async (req, res) => {
  if (gatewayManager.isRunning() || gatewayManager.getState() === 'starting') {
    return res.status(409).json({
      ok: false,
      error: 'Gateway is already running or starting. Use /api/config to update config.',
    });
  }

  const { errors, data } = validateSetupForm(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  try {
    // ── 1. Run openclaw onboard ──────────────────────────────────
    const onboardArgs = buildOnboardArgs(data);
    log.info(`Running: openclaw ${onboardArgs.join(' ').replace(/--\S+-api-key\s+\S+/g, '--***-api-key ***')}`);

    const onboard = await runOpenclaw(onboardArgs);
    log.info(`Onboard exit=${onboard.code} configured=${await config.isAlreadyConfigured()}`);

    if (onboard.code !== 0 || !(await config.isAlreadyConfigured())) {
      log.error('Onboard failed:', onboard.output);
      return res.status(500).json({
        ok: false,
        error: `Onboard failed (exit ${onboard.code}). Check logs for details.`,
        output: onboard.output,
      });
    }

    // ── 2. Post-onboard gateway config patches ───────────────────
    log.info('Onboard succeeded. Patching gateway config...');

    await runConfigSet('gateway.controlUi.allowInsecureAuth', 'true');
    if (OPENCLAW_GATEWAY_TOKEN) {
      await runConfigSet('gateway.auth.token', OPENCLAW_GATEWAY_TOKEN);
    }
    await runConfigSetJson('gateway.trustedProxies', ['127.0.0.1', '::1']);
    await runConfigSetJson('gateway.controlUi.allowedOrigins', ['*']);

    // ── 3. Set model (if user provided one) ──────────────────────
    if (data.model) {
      log.info(`Setting model to ${data.model}...`);
      await runModelsSet(data.model);
    }

    // ── 4. Channel configs ───────────────────────────────────────
    if (data.telegramBotToken) {
      await runConfigSetJson('channels.telegram', {
        enabled: true,
        botToken: data.telegramBotToken,
        dmPolicy: data.telegramDmPolicy || 'pairing',
        groupPolicy: 'open',
        streamMode: 'partial',
        ...(data.telegramAllowFrom
          ? { allowFrom: data.telegramAllowFrom.split(/[,\n]/).map(s => s.trim()).filter(Boolean) }
          : {}),
        ...(data.telegramWebhookUrl
          ? { webhookUrl: data.telegramWebhookUrl }
          : {}),
      });
    }

    if (data.discordBotToken) {
      await runConfigSetJson('channels.discord', {
        enabled: true,
        token: data.discordBotToken,
        groupPolicy: 'open',
        dm: { policy: data.discordDmPolicy || 'pairing' },
        ...(data.discordAllowFrom
          ? { allowFrom: data.discordAllowFrom.split(/[,\n]/).map(s => s.trim()).filter(Boolean) }
          : {}),
      });
    }

    if (data.slackBotToken && data.slackAppToken) {
      await runConfigSetJson('channels.slack', {
        enabled: true,
        botToken: data.slackBotToken,
        appToken: data.slackAppToken,
      });
    }

    if (data.googleChatServiceAccount) {
      await runConfigSetJson('channels.googlechat', {
        serviceAccount: data.googleChatServiceAccount,
      });
    }

    if (data.mattermostUrl && data.mattermostToken) {
      await runConfigSetJson('channels.mattermost', {
        url: data.mattermostUrl,
        token: data.mattermostToken,
        ...(data.mattermostTeam ? { team: data.mattermostTeam } : {}),
      });
    }

    // ── 5. Session config ────────────────────────────────────────
    if (data.sessionScope) {
      const session = {
        dmScope: data.sessionScope,
      };
      if (data.sessionResetMode && data.sessionResetMode !== 'off') {
        session.reset = {
          mode: data.sessionResetMode,
          ...(data.sessionResetHour
            ? { atHour: parseInt(data.sessionResetHour, 10) }
            : {}),
        };
      }
      await runConfigSetJson('session', session);
    }

    // ── 6. Launch the gateway ────────────────────────────────────
    log.info('Config complete. Launching OpenClaw gateway...');

    gatewayManager.start().catch((err) => {
      log.error('Gateway failed to start after setup:', err.message);
    });

    res.json({ ok: true, message: 'Config saved. Gateway launching...' });
  } catch (err) {
    log.error('Setup failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /setup/pairing/approve — approve a channel pairing code ────

setupRoutes.post('/pairing/approve', async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: 'Missing channel or code' });
  }

  try {
    const env = { ...process.env, HOME: DATA_DIR, OPENCLAW_STATE_DIR: OPENCLAW_HOME };
    const args = ['pairing', 'approve', String(channel), String(code)];

    const { stdout } = await execFileAsync('openclaw', args, { env, timeout: 15_000 });
    log.info(`Pairing approve result: ${stdout}`);
    res.json({ ok: true, output: stdout });
  } catch (err) {
    const output = err.stdout || err.stderr || err.message;
    log.error(`Pairing approve failed: ${output}`);
    res.status(500).json({ ok: false, error: output });
  }
});

// ── POST /setup/reset — wipe config or full factory reset ─────────

setupRoutes.post('/reset', async (req, res) => {
  const { mode } = req.body || {};

  try {
    await gatewayManager.stop();

    if (mode === 'full') {
      // Full factory reset — wipe the entire .openclaw directory
      try {
        await fs.rm(OPENCLAW_HOME, { recursive: true, force: true });
      } catch { /* already gone */ }
      // Re-create the base directories so the next setup works
      await fs.mkdir(path.join(OPENCLAW_HOME, 'nodes'), { recursive: true });
      await fs.mkdir(path.join(OPENCLAW_HOME, 'workspace'), { recursive: true });
      log.info('Full factory reset complete. All data wiped.');
      res.json({ ok: true, message: 'Full reset complete. All data wiped. Redirecting to setup...' });
    } else {
      // Config-only reset — remove config + env so setup wizard reappears
      try { await fs.unlink(config.OPENCLAW_CONFIG_PATH); } catch { /* already gone */ }
      try { await fs.unlink(config.OPENCLAW_ENV_PATH); } catch { /* already gone */ }
      log.info('Config reset. Gateway stopped.');
      res.json({ ok: true, message: 'Config reset complete. Redirecting to setup...' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /setup/export — download a zip backup of .openclaw data ───

setupRoutes.get('/export', async (req, res) => {
  try {
    // Check that the data directory exists
    try {
      await fs.access(OPENCLAW_HOME);
    } catch {
      return res.status(404).json({ ok: false, error: 'No data directory found to export.' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipName = `openclaw-export-${timestamp}.zip`;
    const tmpZip = path.join(os.tmpdir(), zipName);

    const zipArgs = ['-r'];
    // Password-protect with admin password if set
    if (WRAPPER_ADMIN_PASSWORD) {
      zipArgs.push('-P', WRAPPER_ADMIN_PASSWORD);
    }
    zipArgs.push(tmpZip, OPENCLAW_HOME);

    const { stdout } = await execFileAsync('zip', zipArgs, { timeout: 60_000 });
    log.info(`Export zip created: ${zipName}`);

    // Verify the zip was created
    let stat;
    try {
      stat = await fs.stat(tmpZip);
    } catch {
      return res.status(500).json({ ok: false, error: 'Failed to create export archive.' });
    }

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Content-Length': String(stat.size),
    });

    const stream = createReadStream(tmpZip);
    stream.pipe(res);
    stream.on('end', () => {
      fs.unlink(tmpZip).catch(() => {});
    });
    stream.on('error', (err) => {
      log.error('Export stream error:', err.message);
      fs.unlink(tmpZip).catch(() => {});
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'Stream error during export.' });
      }
    });
  } catch (err) {
    log.error('Export failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
