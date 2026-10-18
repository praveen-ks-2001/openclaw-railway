# CLAUDE.md

This file provides guidance when working with this repository.

## Overview

This is a Railway deployment wrapper for OpenClaw. A modular Express service manages a Gateway on loopback `127.0.0.1:18789`, serves `/setup`, `/admin`, and `/login`, and proxies the native OpenClaw UI. Preserve this template's dashboard and cookie-based authentication when adapting shared backend components.

## Runtime and Version Policy

- ESM-only (`"type": "module"`). Docker uses Node.js **24.16.0**, including the build of native `node-pty` bindings.
- `package.json` → `openclawVersion` is the single exact OpenClaw pin: **2026.10.4** on this branch.
- OpenClaw is installed globally during the Docker build. `OPENCLAW_VERSION` build arguments and runtime variables cannot select its version. Obsolete requested/minimum/bumped environment values are ignored, and self-updates are disabled.
- Startup checks the installed package against the branch pin **before opening persistent state**. Do not replace the pin with `latest` or add an environment override.
- Test the wrapper and native terminal in Linux Docker, not only on the host. Avoid running multiple real Gateways concurrently on a small Docker VM.

## Request Flow and Authentication

- `/login`, `/logout`: admin cookie authentication; API clients can use the supported admin bearer credential.
- `/setup/*`: authenticated setup and maintenance routes. Rerunning onboarding over an existing configured installation is refused.
- `/admin` and `/api/admin/status`: authenticated dashboard and private status, including the Gateway token.
- `/api/status`: public sanitized health/status for Railway and setup polling. Never expose credentials, provider details, logs, or private state here.
- `/api/logs*`, `/api/events`, `/api/config`, `/api/pairing/*`, and Gateway mutations: authenticated management endpoints.
- `/ws/terminal`: authenticated, same-origin native PTY connection running `openclaw tui`; this is a chat TUI, not a container shell.
- Other HTTP/WebSocket requests: Gateway proxy. Scope wrapper credential bridging to authenticated browser traffic and validate origins; preserve caller-supplied authorization and independent hook/worker/join credentials.
- `WRAPPER_ADMIN_PASSWORD` is required for privileged actions. If missing, fail with instructions to configure it; never silently allow administration.
- Browser mutations and WebSocket handshakes require appropriate same-origin checks. Do not weaken them to resolve local test failures.

## Key Files

- `src/server.js`: composition, boot/recovery ordering, route registration, single WebSocket upgrade handler, and shutdown.
- `src/config/index.js`: persistent roots and config I/O. Default data root is `/data`; state is `/data/.openclaw`; workspace is **nested inside state** at `/data/.openclaw/workspace`.
- `src/utils/version.js`: manifest version policy and installed package verification.
- `src/services/gatewayManager.js`: dashboard-compatible adapter to the shared lifecycle implementation.
- `src/services/openclawRuntime.js`: bounded CLI/SDK workers, shared roots, environment, and secret redaction.
- `src/services/operations.js`: mutation admission, read draining, shutdown, and failed-upgrade blocking.
- `src/services/onboardBuilder.js`: provider/auth mapping, exact-version provider plugins, onboarding arguments, and checked config commands.
- `src/services/pairingService.js`: short-lived device-bootstrap SDK workers, compatible CLI operations, polling, and SSE events. Never read a retired JSON store as the source of truth or keep an SDK SQLite owner across reset/recovery.
- `src/services/terminalService.js`: deferred `node-pty` startup after the first resize, PTY limits and cleanup.
- `src/core/`: permanent runtime modules for process lifecycle, command execution, config/legacy migration, proxy policy, consistent backup, and durable upgrade snapshot/recovery. Associated `*.test.mjs` files exercise their contracts.
- `src/routes/setup.js`, `src/routes/api.js`: setup, backup/reset, configuration, and dashboard API integration.
- `public/setup.html`, `public/admin.html`: existing visual design, inline browser scripts, onboarding and management instructions.
- `test/ui*.test.mjs`: browser-script/API contract tests.

## State Safety

Recovery precedes state mutation, provider SDK access, onboarding, and Gateway startup. An upgrade snapshots existing data, prepares compatible configuration, runs migration/startup validation, and only then permits the normally running Gateway. Preserve durable recovery journals, failed generations, and success markers; do not rerun a completed migration or overwrite chats created after it.

This template's workspace is nested in state. Backup/snapshot/restore code must not recursively duplicate it or restore state over a staged workspace incorrectly. Use OpenClaw's database-consistent backup mechanism for live exports; copying live SQLite files into a ZIP is not sufficient. Keep credentials, agents, sessions, memory sources, schedules/history, workspace bytes/modes, and existing device trust during an ordinary upgrade.

A previous code branch does not reverse SQLite or other state migrations. After a committed upgrade, downgrade requires a compatible pre-upgrade state/workspace backup; it omits changes made afterward. Distinguish failed-upgrade recovery from restoring an older release. Never delete persistent data to make an upgrade appear successful.

## Frontend/API Contracts

- Setup polls sanitized `/api/status`; admin polls authenticated `/api/admin/status`.
- Version info includes `pinned`, `effective`, `installed`, and `source: "branch"`. Legacy `min`, `requested`, `bumped`, and `belowMin` are read-only compatibility fields, never environment inputs.
- Config GET returns `{ok:true, config, revision}`. POST sends `{config, revision}` and returns the new revision on success. A stale revision is HTTP 409; retain the user's draft and require a deliberate reload, without automatically retrying.
- Existing secret values display as `[redacted]`. Preserve that literal only at an existing secret path; replacement strings change secrets, and removing keys intentionally deletes them. Validate candidates and report failed startup/rollback rather than claiming success.
- Device rows may use `requestId`/`deviceId`, `displayName`, `roles`, `ts`, `createdAtMs`, and `approvedAtMs`. Escape untrusted text/attributes and use delegated controls instead of interpolating identifiers into inline JavaScript or CSS selectors.
- Native browser connection: Gateway secret fallback → Connect → **Approve this browser** or host command → keep requesting tab open → **Admin → Pairing** → match ID and approve → return for automatic reconnect or **Check now** → **Connected**.
- Channel DM codes and browser/device approval are different flows.
- xterm CDN global names: `Terminal`, `FitAddon.FitAddon`, `WebLinksAddon.WebLinksAddon`. Preserve pinned `.min.js` builds unless replacing them with verified assets.
- Terminal client sends `{type:'input',data}` and `{type:'resize',cols,rows}`; server sends `{type:'output',data}` and `{type:'exit',code}`. Keep one manually routed WebSocket upgrade handler; terminal WSS uses `noServer:true`.

## Environment

- `PORT`: wrapper HTTP port, default 3000; Railway supplies it.
- `WRAPPER_ADMIN_PASSWORD`: required for setup/admin/terminal access.
- `OPENCLAW_GATEWAY_TOKEN`: Gateway credential. Preserve existing values across redeploys; the wrapper can reuse or generate a token when absent.
- `OPENCLAW_DATA_DIR`: volume root, default `/data`.
- `OLLAMA_BASE_URL`: optional reachable Ollama endpoint.
- `OPENCLAW_ENTRY`, `OPENCLAW_NODE`: executable paths for controlled development/testing. Production uses the globally installed package.

## Development and Docker

```sh
npm start
npm run dev
npm test

docker build -t openclaw-railway .
docker run --rm -p 3000:3000 \
  -e OPENCLAW_GATEWAY_TOKEN=local-test-token \
  -e WRAPPER_ADMIN_PASSWORD=local-test-admin-password \
  -v ./data:/data openclaw-railway
```

Local development requires the pinned OpenClaw package and compatible Node runtime. Changing `openclawVersion` requires the upgrade assessment and regression workflow, not only a successful image build. Inspect the shared workspace's upgrade skill and plan for prior evidence and additional contracts. Preserve the older production source/image before upgrade tests. Populate it, compare actual canonical data after migration, continue an old conversation, and exercise fresh browser setup, pairing, terminal, config, backups, restart, and interrupted recovery.

## Git Workflow

Each template is an independent Git repository; the shared parent directory must not become one. `main` is production and deploys to existing users. Work on a release branch and create a reviewable PR; do not merge or push `main` unless explicitly authorized. Keep template-specific docs, assets, and settings. Do not add third-party template attribution or reference branding.
