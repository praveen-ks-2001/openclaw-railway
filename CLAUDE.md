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
- **Node.js >= 22** required for the wrapper (uses `--watch` for dev, native fetch, etc.). OpenClaw 2026.6.x itself needs Node >= 22.19; the `node:22-bookworm-slim` base image satisfies this.
- **Targets OpenClaw 2026.6.6** — the CLI flags, provider auth-choices, OAuth device-code flows, and the device-bootstrap SDK are verified against this release (see the version floor below).
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
- `src/services/pairingService.js` — Device pairing: list/approve via the in-process `openclaw/plugin-sdk/device-bootstrap` SDK; reject/revoke via `openclaw devices` CLI; chokidar watcher on `pending.json` drives SSE
- `src/services/onboardBuilder.js` — Builds `openclaw onboard` CLI args for 40+ providers (API key + OAuth device-code via PTY) + post-onboard `config set` helpers
- `src/config/index.js` — All paths and constants (incl. `OPENCLAW_ENTRY`/`OPENCLAW_NODE`)
- `src/utils/validation.js` — Setup form validation (provider list, OAuth providers, channels)
- `src/utils/version.js` — OpenClaw version info: installed version + build-time floor/auto-bump record (`/app/openclaw-build-info.json`)
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
- `WRAPPER_ADMIN_PASSWORD` — Password for /admin and /setup (optional; if unset, both are open)
- `OPENCLAW_DATA_DIR` — Volume mount path (default /data)
- `OLLAMA_BASE_URL` — Optional; pre-fills the Ollama URL field in /setup
- `OPENCLAW_VERSION` — Docker **build ARG** (read at build time, NOT a runtime env var). Railway honors it because the Dockerfile declares `ARG OPENCLAW_VERSION`. Defaults to `2026.6.6`. A **hard-coded compatibility floor** in the Dockerfile auto-bumps any *older concrete* pin up to the floor (the template code is tied to that version's CLI/SDK); newer pins, `latest`, and pre-releases install verbatim. See `src/utils/version.js`.
- `OPENCLAW_ENTRY` / `OPENCLAW_NODE` — Path to openclaw's `dist/entry.js` and the node binary. The wrapper runs `node entry.js …` directly (not the bin shim) and resolves the device-bootstrap SDK relative to this path.

### Health Check
- `GET /api/status` — used by Docker HEALTHCHECK (15s interval, 30s start period)

### Critical Design Decisions

1. **WebSocket proxying uses raw TCP sockets** — `http-proxy` v1.18.1 has broken WS frame forwarding on Node 22. We use `net.connect()` to pipe bidirectionally, manually reconstructing the HTTP upgrade request with auth headers injected.

2. **Terminal WSS uses `noServer: true`** — The `ws` library with `{ server: httpServer }` auto-registers an upgrade handler that calls `abortHandshake(400)` for non-matching paths, destroying ALL non-terminal WS sockets. Using `noServer: true` and routing upgrades manually in a single handler in server.js prevents this.

3. **Gateway config uses `allowInsecureAuth: true`** — This lets the gateway accept token-based auth from our proxy without requiring browser device pairing. Device pairing approval still works via the device-bootstrap SDK (see #4). Do NOT use `dangerouslyDisableDeviceAuth` — that completely disables device auth and breaks pairing. (2026.6.x adds a first-class `--auth trusted-proxy` gateway mode that could eventually replace this hack.)

4. **Device pairing list/approve via the in-process SDK, not the WS CLI** — `pairingService.js` loads `openclaw/plugin-sdk/device-bootstrap` (resolved relative to `OPENCLAW_ENTRY`) and calls `listDevicePairing()` / `approveDevicePairing(id, { callerScopes: ['operator.admin'] })`. This sidesteps two bugs in the `openclaw devices … --token` CLI path: a WS handshake race against the loopback gateway (#45504) and a missing `operator.admin` scope (#51779). The wrapper is the trusted bootstrap admin (filesystem access + `WRAPPER_ADMIN_PASSWORD`), so it passes the scope explicitly. Reject/revoke still use the `openclaw devices` CLI (the SDK doesn't export them). A chokidar watcher on `nodes/pending.json` drives real-time SSE to the admin UI. `probeDeviceBootstrapSdk()` logs SDK readiness at boot.

5. **Single upgrade handler in server.js** — Routes `/ws/terminal` to terminal WSS, everything else to gateway WS proxy. This avoids conflicts between multiple WS servers.

6. **Terminal spawns `openclaw tui` with deferred PTY** — PTY is NOT spawned on WS connect. We wait for the first `resize` message from xterm.js so we have correct terminal dimensions. This matches the reference implementation pattern.

7. **OpenClaw installed globally in Docker, not via package.json** — `npm install -g openclaw@${OPENCLAW_VERSION}` in the runtime stage. This keeps it out of `node_modules` and makes version pinning via Railway build args clean. The builder stage still needs `git` + gitconfig HTTPS redirect for transitive deps of other packages (chokidar, node-pty).

8. **OpenClaw is invoked via `node $OPENCLAW_ENTRY`, not the `openclaw` bin** — More reliable in containers and lets us `createRequire` the device-bootstrap SDK from the same path. `OPENCLAW_ENTRY`/`OPENCLAW_NODE` are set in the Dockerfile. The admin terminal is the one exception — it spawns the `openclaw` bin from PATH for `tui`.

9. **OAuth onboarding streams a PTY to the browser** — Providers with a device-code flow (OpenAI `openai-device-code`, xAI `xai-device-code`) run `openclaw onboard` under `node-pty`; `setup.js` streams the output as `text/plain` so the user sees the device URL + code. Only device-code flows are supported (headless-safe); redirect/PKCE flows (`openrouter-oauth`, `qwen-oauth`) need a localhost callback and are intentionally excluded. Provider→auth-choice mappings live in `onboardBuilder.js` (`PROVIDER_MAP`, `OAUTH_AUTH_CHOICE`), mirrored in `validation.js` (`VALID_PROVIDERS`, `OAUTH_SUPPORTED_PROVIDERS`) and `public/setup.html` (`<select>`, `providerDefaults`, `OAUTH_LABELS`) — keep all four in sync. To validate a provider against a new OpenClaw version, run `onboard --non-interactive --json --auth-choice X …` against a throwaway HOME and check the written `openclaw.json` has `auth.profiles` populated (a bogus choice writes none — exit code is always 0).

10. **Build-time OpenClaw version floor** — The Dockerfile hard-codes a `MIN` version (a shell literal, NOT an ARG, so no Railway variable can lower or bypass it) and auto-bumps any older concrete `OPENCLAW_VERSION` pin up to it, recording `{requested, effective, min, bumped}` in `/app/openclaw-build-info.json`. `version.js` + `/api/status` surface this; setup/admin show a banner when an auto-bump happened. The floor `2026.6.6` lives in three places — the Dockerfile `ARG OPENCLAW_VERSION` default, the Dockerfile `MIN` literal, and `MIN_VERSION` in `version.js` — **keep all three in sync on every version bump.**

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

# Pin a specific openclaw version. Concrete pins older than the Dockerfile's
# hard-coded floor are auto-bumped up to it; newer pins / `latest` install as-is:
docker build --build-arg OPENCLAW_VERSION=2026.6.6 -t openclaw-railway .
```

## Common Issues

- **WS 1006 disconnects**: Usually caused by either (a) terminal WSS destroying non-terminal sockets, or (b) missing auth token in WS proxy
- **`token_missing` errors**: The gateway reads tokens from WS connect frame, not HTTP headers. Our raw TCP proxy injects the Authorization header into the HTTP upgrade request.
- **Pairing requests not showing**: The watcher reads `nodes/pending.json`; list/approve go through the device-bootstrap SDK — check it loaded at boot (`probeDeviceBootstrapSdk` logs readiness). Reject/revoke (CLI) still pass `--token`.
- **Gateway "connect failed"**: Normal during startup — the Control UI tries to connect before gateway is ready
- **Terminal blank/not loading**: Check browser console for JS errors. Common cause: wrong xterm.js CDN version or wrong global variable names (must use `.min.js` builds from `@xterm/xterm@5.5.0`+)
- **Docker build fails with "spawn git ENOENT"**: Both builder and runtime stages need `git` + `ca-certificates` + gitconfig HTTPS redirect. OpenClaw and some transitive deps reference GitHub SSH URLs.

## Git Workflow
- `main` — production branch (PRs target here)
- Work on feature branches (e.g. `feat/…`) and open a PR into `main`

## Reference Implementation
The `REFERENCE_ONLY/` folder contains a reference railway template for comparison. It is gitignored. Key differences from our implementation:
- Uses `http-proxy`'s `proxyReqWs` event for WS auth (works on their Node version)
- Uses Basic auth instead of cookie-based auth
- Single-file server.js vs our modular structure
- We matched their approach for: `openclaw tui` terminal, `allowInsecureAuth`, xterm.js CDN versions
