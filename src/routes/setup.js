/**
 * routes/setup.js
 *
 * GET  /setup       — serve the setup UI HTML
 * POST /setup/save  — write config + launch gateway
 */

import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { config } from '../config/index.js';
import { gatewayManager } from '../services/gatewayManager.js';
import { buildOpenclaWConfig, buildEnvVars } from '../services/configBuilder.js';
import { validateSetupForm } from '../utils/validation.js';
import { log } from '../utils/log.js';

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
    // 1. Build the openclaw.json and env vars
    const openlawConfig = buildOpenclaWConfig(data);
    const envVars = buildEnvVars(data);

    // 2. Write both files to the volume
    await config.writeConfig(openlawConfig);
    if (Object.keys(envVars).length > 0) {
      await config.writeEnvFile(envVars);
    }

    log.info('Config written. Launching OpenClaw gateway...');

    // 3. Launch the gateway (non-blocking — SSE stream tracks progress)
    gatewayManager.start().catch((err) => {
      log.error('Gateway failed to start after setup:', err.message);
    });

    res.json({ ok: true, message: 'Config saved. Gateway launching...' });
  } catch (err) {
    log.error('Setup failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /setup/reset — wipe config and stop gateway ──────────────

setupRoutes.post('/reset', async (req, res) => {
  try {
    await gatewayManager.stop();
    // Remove config file so setup UI reappears on restart
    try {
      await fs.unlink(config.OPENCLAW_CONFIG_PATH);
    } catch { /* already gone */ }
    log.info('Config reset. Gateway stopped.');
    res.json({ ok: true, message: 'Reset complete. Redirecting to setup...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
