/**
 * openclaw-railway — server.js
 *
 * Single entry point. Responsibilities:
 *  1. Boot Express on PORT (Railway's public port)
 *  2. If openclaw.json already exists on the volume → launch gateway immediately
 *  3. Proxy all /ui/* traffic through to openclaw's gateway once it's up
 *  4. Serve the Setup UI and admin dashboard when needed
 *  5. Attach terminal WebSocket at /ws/terminal
 *  6. Push pairing SSE events when pending.json changes
 */

import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

import { config } from './config/index.js';
import { gatewayManager } from './services/gatewayManager.js';
import { pairingService } from './services/pairingService.js';
import { attachTerminalWebSocket } from './services/terminalService.js';
import { setupRoutes } from './routes/setup.js';
import { apiRoutes } from './routes/api.js';
import { proxyMiddleware } from './middleware/proxy.js';
import { requestLogger } from './middleware/logger.js';
import { requireAdminAuth } from './middleware/auth.js';
import { ensureDataDir } from './utils/fs.js';
import { log } from './utils/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // ── Startup sanity checks ──────────────────────────────────────
  try {
    execFileSync('openclaw', ['--version'], { stdio: 'ignore' });
  } catch {
    log.error('❌ `openclaw` binary not found in PATH.');
    log.error('   PATH = ' + process.env.PATH);
    log.error('   Check that node_modules/.bin is in PATH (Dockerfile ENV PATH setting).');
    process.exit(1);
  }

  // 1. Ensure all required directories exist on the volume
  await ensureDataDir();

  const app = express();
  const httpServer = createServer(app);

  // ── Middleware ─────────────────────────────────────────────────
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Static assets
  app.use('/assets', express.static(path.join(__dirname, '../public/assets')));

  // ── Routes ─────────────────────────────────────────────────────

  // Internal management API — always available
  app.use('/api', apiRoutes);

  // Setup flow routes
  app.use('/setup', setupRoutes);

  /**
   * SSE: real-time pairing pending updates
   * Protected by admin auth.
   */
  app.get('/api/pairing/stream', requireAdminAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    pairingService.getPending().then((pending) => {
      res.write(`data: ${JSON.stringify({ type: 'pending', pending })}\n\n`);
    }).catch(() => {});

    const onPendingChanged = (pending) => {
      res.write(`data: ${JSON.stringify({ type: 'pending', pending })}\n\n`);
    };
    const onPairingUpdate = (evt) => {
      res.write(`data: ${JSON.stringify({ type: 'update', ...evt })}\n\n`);
    };

    pairingService.on('pendingChanged', onPendingChanged);
    pairingService.on('pairingUpdate',  onPairingUpdate);

    req.on('close', () => {
      pairingService.off('pendingChanged', onPendingChanged);
      pairingService.off('pairingUpdate',  onPairingUpdate);
    });
  });

  // Root routing
  app.get('/', (req, res) => {
    if (gatewayManager.isRunning()) {
      return res.redirect('/ui/');
    }
    res.redirect('/setup');
  });

  // Admin dashboard — redirect to /setup if not yet configured
  app.get('/admin', requireAdminAuth, async (req, res) => {
    if (!(await config.isAlreadyConfigured())) {
      return res.redirect('/setup');
    }
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  });

  // Proxy /ui/* → openclaw gateway
  app.use('/ui', proxyMiddleware);

  // ── WebSocket services ─────────────────────────────────────────
  attachTerminalWebSocket(httpServer);
  gatewayManager.attachWebSocketProxy(httpServer);

  // ── Start listening ────────────────────────────────────────────
  const PORT = config.PORT;
  httpServer.listen(PORT, '0.0.0.0', () => {
    log.info(`🦞 openclaw-railway listening on port ${PORT}`);
  });

  // ── Auto-launch if already configured ─────────────────────────
  if (await config.isAlreadyConfigured()) {
    log.info('Existing config found — launching OpenClaw gateway automatically...');
    try {
      await gatewayManager.start();
    } catch (err) {
      log.error('Auto-launch failed:', err.message);
    }
  } else {
    log.info('No config found — serving Setup UI at /setup');
  }

  // ── Graceful shutdown ──────────────────────────────────────────
  const shutdown = async (signal) => {
    log.info(`Received ${signal} — shutting down...`);
    await gatewayManager.stop();
    httpServer.close(() => {
      log.info('HTTP server closed. Goodbye.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
