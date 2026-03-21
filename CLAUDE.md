# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Railway deployment wrapper for **OpenClaw** (open-source AI coding assistant). It's a single Express service that:
- Manages an `openclaw` binary (installed globally in Docker) as a child process (gateway on loopback:18789)
- Provides a setup UI at `/setup`, admin dashboard at `/admin`, and login at `/login`
- Reverse-proxies all other traffic to the openclaw gateway
- Handles WebSocket proxying via raw TCP socket piping (not http-proxy's broken WS support on Node 22)

## Project Setup
- **ESM-only** — `"type": "module"` in package.json, all imports use ES module syntax
- **Node.js >= 22** required (uses `--watch` for dev, native fetch, etc.)
- **No test suite or linter configured** — there are no test/lint commands

## Architecture

### Request Flow
1. **User -> Railway -> Express (PORT)** routes to:
   - `/setup/*` -> setup wizard
   - `/admin` -> admin dashboard (requires auth)
   - `/api/*` -> internal management API
   - `/login`, `/logout` -> cookie-based admin auth
   - `/ws/terminal` -> terminal WebSocket (node-pty)
   - Everything else -> proxied to openclaw gateway (loopback:18789)

2. **Express -> Gateway** (127.0.0.1:18789):
   - HTTP: via `http-proxy` with `Authorization: Bearer <token>` injection
   - WebSocket: via raw TCP socket piping (`net.connect`) — NOT http-proxy's `.ws()` which is broken on Node 22

### Key Files
- `src/server.js` — Express app, route registration, single WS upgrade handler
- `src/services/gatewayManager.js` — Gateway lifecycle, WS/HTTP proxy, auto-restart with backoff
- `src/services/terminalService.js` — PTY sessions over WebSocket (noServer mode), spawns `openclaw tui`
- `src/services/pairingService.js` — Device management via `openclaw devices` CLI
- `src/services/configBuilder.js` — Builds openclaw.json from setup form data
- `src/config/index.js` — All paths and constants
- `src/utils/validation.js` — Setup form validation
- `src/utils/fs.js` — Data directory initialization, atomic file writes
- `src/utils/log.js` — Centralized logging utility
- `src/middleware/proxy.js` — HTTP proxy middleware
- `src/middleware/auth.js` — Cookie-based admin auth
- `src/middleware/logger.js` — HTTP request logging
- `src/routes/setup.js` — Setup flow routes
- `src/routes/api.js` — Admin API endpoints
- `public/admin.html` — Admin dashboard (status, logs, terminal, pairing, config)
- `public/setup.html` — Setup wizard

### Environment Variables
- `PORT` — Express port (Railway sets automatically, default 3000)
- `OPENCLAW_GATEWAY_TOKEN` — Auth token for gateway (required)
- `WRAPPER_ADMIN_PASSWORD` — Password for /admin and /setup (optional)
- `OPENCLAW_DATA_DIR` — Volume mount path (default /data)
- `OPENCLAW_VERSION` — Docker build ARG (not runtime env). Set in Railway build args to pin a specific openclaw version (e.g., `2026.3.13`). Defaults to `latest`.

### Health Check
- `GET /api/status` — used by Docker HEALTHCHECK (15s interval, 30s start period)

### Critical Design Decisions

1. **WebSocket proxying uses raw TCP sockets** — `http-proxy` v1.18.1 has broken WS frame forwarding on Node 22. We use `net.connect()` to pipe bidirectionally, manually reconstructing the HTTP upgrade request with auth headers injected.

2. **Terminal WSS uses `noServer: true`** — The `ws` library with `{ server: httpServer }` auto-registers an upgrade handler that calls `abortHandshake(400)` for non-matching paths, destroying ALL non-terminal WS sockets. Using `noServer: true` and routing upgrades manually in a single handler in server.js prevents this.

3. **Gateway config uses `allowInsecureAuth: true`** — This lets the gateway accept token-based auth from our proxy without requiring browser device pairing. Device management (approve/reject) still works via `openclaw devices` CLI with `--token`. Do NOT use `dangerouslyDisableDeviceAuth` — that completely disables device auth and breaks pairing.

4. **Device management uses CLI, not file reads** — `openclaw devices list --json --token <TOKEN>` is more reliable across openclaw versions than reading `nodes/pending.json` directly. All device commands pass `--token`.

5. **Single upgrade handler in server.js** — Routes `/ws/terminal` to terminal WSS, everything else to gateway WS proxy. This avoids conflicts between multiple WS servers.

6. **Terminal spawns `openclaw tui` with deferred PTY** — PTY is NOT spawned on WS connect. We wait for the first `resize` message from xterm.js so we have correct terminal dimensions. This matches the reference implementation pattern.

7. **OpenClaw installed globally in Docker, not via package.json** — `npm install -g openclaw@${OPENCLAW_VERSION}` in the runtime stage. This keeps it out of `node_modules` and makes version pinning via Railway build args clean. The builder stage still needs `git` + gitconfig HTTPS redirect for transitive deps of other packages (chokidar, node-pty).

### Frontend (admin.html) Notes

- **xterm.js CDN**: Must use `@xterm/xterm@5.5.0` with `.min.js` files. The non-minified `.js` builds from older versions don't properly export UMD globals.
- **Global names**: `Terminal` (from xterm), `FitAddon.FitAddon()`, `WebLinksAddon.WebLinksAddon()` — NOT `AddonFit` or `AddonWebLinks`.
- **Terminal fit timing**: `fitAddon.fit()` must be called with a small delay (`setTimeout 50ms`) after `term.open()` and when navigating back to the terminal panel, because the panel must be visible for correct dimension calculation.
- **Terminal WS protocol**: JSON frames — `{ type: 'input', data }`, `{ type: 'resize', cols, rows }` from client; `{ type: 'output', data }`, `{ type: 'exit', code }` from server.

## Development Commands

```bash
npm start        # Production start (node src/server.js)
npm run dev      # Development with --watch (auto-restart on file changes)
```

Note: Local dev requires the `openclaw` binary in PATH and a `/data` directory (or `OPENCLAW_DATA_DIR` set). Docker is the easiest way to get a working environment.

## Docker Build

Two-stage Dockerfile: builder (compiles node-pty native bindings) → runtime (Debian Bookworm slim + globally installed openclaw).

```bash
docker build -t openclaw-railway .
docker run --rm -p 3000:3000 -e PORT=3000 -e OPENCLAW_GATEWAY_TOKEN=test -v ./data:/data openclaw-railway

# Pin a specific openclaw version:
docker build --build-arg OPENCLAW_VERSION=2026.3.13 -t openclaw-railway .
```

## Common Issues

- **WS 1006 disconnects**: Usually caused by either (a) terminal WSS destroying non-terminal sockets, or (b) missing auth token in WS proxy
- **`token_missing` errors**: The gateway reads tokens from WS connect frame, not HTTP headers. Our raw TCP proxy injects the Authorization header into the HTTP upgrade request.
- **Pairing requests not showing**: Ensure `--token` is passed to all `openclaw devices` CLI commands
- **Gateway "connect failed"**: Normal during startup — the Control UI tries to connect before gateway is ready
- **Terminal blank/not loading**: Check browser console for JS errors. Common cause: wrong xterm.js CDN version or wrong global variable names (must use `.min.js` builds from `@xterm/xterm@5.5.0`+)
- **Docker build fails with "spawn git ENOENT"**: Both builder and runtime stages need `git` + `ca-certificates` + gitconfig HTTPS redirect. OpenClaw and some transitive deps reference GitHub SSH URLs.

## Git Workflow
- `main` — production branch (PRs target here)
- `staging` — active development branch

## Reference Implementation
The `REFERENCE_ONLY/` folder contains a reference railway template for comparison. It is gitignored. Key differences from our implementation:
- Uses `http-proxy`'s `proxyReqWs` event for WS auth (works on their Node version)
- Uses Basic auth instead of cookie-based auth
- Single-file server.js vs our modular structure
- We matched their approach for: `openclaw tui` terminal, `allowInsecureAuth`, xterm.js CDN versions
