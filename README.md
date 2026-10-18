![OpenClaw logo](https://opengraph.githubassets.com/027231e34679f13d043884e2d69bd69e052e500e3bf7b5b03c72101eda21b724/openclaw/openclaw)

# Deploy and Host OpenClaw

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/self-host-openclaw?referralCode=QXdhdr&utm_medium=integration&utm_source=template&utm_campaign=generic)

Deploy OpenClaw — the open-source personal AI assistant with 328k+ GitHub stars — on Railway with a single click. OpenClaw is a self-hosted agent runtime that connects your favorite chat apps (WhatsApp, Telegram, Discord, Slack, iMessage, and 20+ more) to powerful AI models like Claude, GPT, and Gemini, letting an AI agent browse the web, manage files, run commands, and work autonomously on your behalf.

Self-host OpenClaw on Railway with this template and get a fully configured **gateway, a browser-based setup wizard, admin dashboard with live terminal, and persistent storage** — no CLI or SSH access needed. 


## 🚀 Getting Started with OpenClaw on Railway | Deployment Guide

Set a strong `WRAPPER_ADMIN_PASSWORD` and `OPENCLAW_GATEWAY_TOKEN` in Railway, and attach a persistent volume at `/data`. Once your deploy is live, open your service URL and sign in to the `/setup` wizard with the admin password. Pick your AI provider and authentication method, supply an API key or complete provider sign-in, and optionally configure messaging channels. Click **Launch OpenClaw** and wait for the Gateway to finish starting.

### Step 1: Initial Setup via `/setup`

The `/setup` page is a **one-time configuration wizard** — it's where you select your AI provider, paste your API key, and optionally wire up messaging channels (Telegram, Discord, Slack, etc.). 

Both setup and administration require `WRAPPER_ADMIN_PASSWORD`. If it is missing, set it in Railway and redeploy; privileged actions stay disabled until it is configured. Once an installation is configured, manage it through `/admin` instead of rerunning setup. **Reset Config** is an explicit reconfiguration action; download a backup before using it.

![OpenClaw setup wizard](https://res.cloudinary.com/asset-cloudinary/image/upload/v1774088297/openclaw_setup_page_rxowv8.png)

### Step 2: Access the **Admin Dashboard** at `/admin`

The `/admin` page is password-protected — log in with your `WRAPPER_ADMIN_PASSWORD` environment variable. This is your **one-stop control panel** for managing everything about your OpenClaw instance:

- **📊 Status** — real-time gateway health, uptime, and quick actions (restart/stop)
- **📋 Live Logs** — stream OpenClaw gateway logs with filtering, directly in the browser
- **💻 Terminal** — interactive OpenClaw TUI chat in a native PTY
- **🔗 Device Pairing** — approve or reject browser requests, and remove paired devices
- **⚙️ Config Editor** — edit and validate `openclaw.json`, preserve redacted secrets, and detect conflicting edits

![OpenClaw Admin Page Protection](https://res.cloudinary.com/asset-cloudinary/image/upload/v1774088295/Openclaw_Admin_Login_u1eqcu.png)

![OpenClaw admin dashboard](https://res.cloudinary.com/asset-cloudinary/image/upload/v1774088294/Openclaw_admin_UI_qzsxep.png)


> 💡 **Tip:** **Admin → Terminal** runs `openclaw tui` for terminal chat. It is not a container shell. Use the dashboard controls for management, or your container/Railway shell for host CLI commands.

![OpenClaw admin terminal — interactive TUI chat](https://res.cloudinary.com/asset-cloudinary/image/upload/v1774088288/Openclaw_admin_TUI_elvlpt.png)

### Step 3: Connect to the **OpenClaw UI**

Click the **"Open OpenClaw UI"** button in the top-right corner of the admin dashboard to open the main OpenClaw interface.

On your first connection:

1. If OpenClaw asks for a **Gateway secret** or token, copy the **Gateway Token** from the Admin Dashboard's Status panel, paste it into OpenClaw, and select **Connect**.
2. If you see **Approve this browser**, a request ID, or a host device-approval command, **keep that OpenClaw tab open**. Return to **Admin Dashboard → Pairing** and approve the matching request ID. The dashboard performs the approval, so you do not need to run the host command.
3. Return to the same OpenClaw tab. It reconnects automatically after approval; use **Check now** if needed. Once it shows **Connected**, send a message in a conversation.

A messaging bot's **channel pairing code** is separate from browser approval. If you selected a pairing DM policy, send the bot a direct message and enter the code from its reply in the setup page's **Channel Pairing** step.

### Updating an Existing Installation

This branch pins **OpenClaw 2026.10.4** in `package.json` and builds with **Node.js 24.16.0**. `OPENCLAW_VERSION` environment variables and build arguments are ignored, including older values left in Railway. Choose a supported release branch to select another version.

For an upgrade, keep the same `/data` volume and existing credentials. Do not reset configuration or rerun setup. Startup snapshots existing state before migration, validates the upgraded Gateway before normal operation, and retains recovery information if startup fails. Review **Admin → Logs** if the upgrade has not finished. If the dashboard reports **Upgrade needs attention**, resolve the logged cause and use **Retry upgrade**; recovery snapshots are retained, and no setup reset is needed.

Download a backup from **Admin → Download Backup** before upgrading. Export briefly stops the Gateway and closes Terminal/TUI sessions while creating a database-consistent archive, then restarts a previously running Gateway. The ZIP uses your current `WRAPPER_ADMIN_PASSWORD`; keep both the archive and that password private because the backup contains credentials and conversations.

Export includes state and any number of verified workspaces nested inside the configured state directory, preserving each workspace's relative location. The default is `/data/.openclaw/workspace`; a custom `OPENCLAW_DATA_DIR` is supported when its workspaces stay inside its `.openclaw` directory. The dashboard export refuses external workspaces, agent databases or credential directories, external active configuration, config `$include` graphs, and unsupported archive links or special files. For a refused layout, back up the volume and every external root, or use the official OpenClaw backup CLI after verifying its archive covers those roots.

Allow free disk space for your data and retained upgrade/recovery copies. **Full Factory Reset** removes this installation's active state, including its nested workspaces; recovery snapshots outside that directory remain available and can still contain older credentials and conversations. Reset is not a secure erase of the whole volume.

**Downgrading code does not reverse data migrations.** Returning to an older branch after a completed upgrade requires restoring a compatible pre-upgrade state/workspace backup while the service is stopped. That backup does not contain messages or edits made afterward. A retained old release branch alone is not a lossless rollback. Restore requires container/host tooling; this dashboard provides backup downloads, without an upload/import flow.

### Editing Configuration

The Config Editor hides secrets as `[redacted]`. Leave that value unchanged to retain an existing secret, replace it to change the secret, or remove its key to delete it. Saves include the revision loaded from disk; a conflicting edit is rejected without discarding your draft. Copy your draft, select **Reload from Disk**, then reapply your changes. Invalid configuration and failed startup checks are reported as errors.

## About Hosting OpenClaw 📖

OpenClaw (formerly ClawdBot/MoltBot) is a fully open-source (MIT), local-first personal AI agent created by Peter Steinberger. It runs as a long-lived Node.js gateway process that routes messages between chat platforms and AI coding agents.

**Key features:**

- 🔌 Multi-channel messaging — WhatsApp, Telegram, Discord, Slack, Signal, iMessage, and 20+ more
- 🤖 Multi-provider AI — Anthropic Claude, OpenAI GPT, Google Gemini, Groq, OpenRouter, or local models via Ollama
- 🧠 Autonomous agent — browses the web, manages files, runs commands, schedules tasks via heartbeat daemon
- 🎨 Live Canvas with A2UI — agent-driven visual workspace
- 🔒 Self-hosted & private — your data, conversations, and memory stay on your machine
- 📱 Companion apps for macOS, iOS, and Android


## Why Deploy OpenClaw on Railway ✅

One-click deploy with zero server configuration:

- 🟢 No Docker, volume, or network setup — Railway handles it all
- 🔐 Managed TLS and custom domains out of the box
- 🔄 Redeploys from Git with startup and migration checks
- 💾 Persistent volume keeps config, credentials, and conversations across deploys
- 🌐 Browser-based setup wizard — no terminal or SSH required
- 📊 Built-in admin dashboard with live logs, terminal, and device pairing

## Common Use Cases 💡

- **Personal AI assistant** — a 24/7 AI agent you message on WhatsApp or Telegram that can browse, code, and research autonomously
- **Automation hub** — schedule recurring tasks via the heartbeat daemon: daily summaries, monitoring, data pipelines

## Dependencies for OpenClaw 📦

- **OpenClaw 2026.10.4** — installed globally in Docker using the exact branch pin in `package.json` ([GitHub](https://github.com/openclaw/openclaw))
- **Node.js 24.16.0** — runtime for both the Express wrapper and OpenClaw gateway
- **node-pty** — native PTY for the admin terminal (compiled in Docker build stage)

### Deployment Dependencies

- **GitHub:** [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **Docs:** [docs.openclaw.ai](https://docs.openclaw.ai/)

## 🖥️ Deployment Sizing for OpenClaw

| Resource | Starting allocation | Recommended |
|----------|---------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 3 GiB tested with one agent | 4 GiB+; more for concurrent agents, plugins, or heavier workloads |
| Storage | 1 GB | 5 GB+ (grows with conversations and workspace) |
| Runtime | Node.js 24.16.0 | Included in the Docker image |

Local validation completed a fresh MiniMax browser conversation with a **3 GiB** container limit. Two **2 GiB** test installations were killed for memory exhaustion, including a browser-only chat after background pairing work was reduced. These tests used Linux/amd64 Docker emulation on an ARM host; they are local results, not a native Railway benchmark or a guarantee for other workloads. Monitor memory and provide more headroom as usage grows.

## 🐳 Self-Hosting OpenClaw

If you prefer to self-host outside Railway, clone this repo and run with Docker:

```
git clone https://github.com/praveen-ks-2001/openclaw-railway.git
cd openclaw-railway
docker build -t openclaw-railway .
docker run -d \
  --name openclaw \
  -p 3000:3000 \
  -e PORT=3000 \
  -e OPENCLAW_GATEWAY_TOKEN=your-secret-token \
  -e WRAPPER_ADMIN_PASSWORD=your-strong-admin-password \
  -v ./data:/data \
  openclaw-railway
```

## 💰 Is OpenClaw Free?

OpenClaw is 100% free and open-source under the MIT license. There are no subscriptions, per-user fees, or platform charges. On Railway, the only cost is your infrastructure usage (typically $5–10/month for a small instance).

The real variable cost is AI model API usage — typically $5–30/month depending on your provider and usage intensity. Light users spend $5–10/month, regular users $15–30/month. You can also run it completely free using local models through Ollama.

## 🆚 OpenClaw vs Cursor vs Claude Code

| Feature | OpenClaw | Cursor | Claude Code |
|---------|----------|--------|-------------|
| Open Source | ✅ MIT | ❌ Proprietary | ❌ Proprietary |
| Self-Hostable | ✅ Full control | ❌ Cloud only | ❌ Cloud only |
| Multi-Channel Chat | ✅ 20+ platforms | ❌ IDE only | ❌ CLI only |
| Autonomous Agent | ✅ Heartbeat daemon | ⚠️ Background agents | ⚠️ Limited |
| IDE Integration | ⚠️ Via extensions | ✅ Native (VS Code fork) | ✅ CLI-native |
| Pricing | Free + API costs | $20–200/month | API costs |

OpenClaw shines when you need an always-on autonomous agent accessible from any chat platform. Cursor and Claude Code are better for in-editor coding assistance.

## ❓ FAQ

**What is OpenClaw?**
OpenClaw is an open-source, self-hosted personal AI assistant that connects 20+ messaging platforms (WhatsApp, Telegram, Discord, etc.) to AI models like Claude, GPT, and Gemini. It runs on your own hardware, keeping all data private.

**Can I use my own AI provider or local models?**
Yes. The setup wizard supports Anthropic, OpenAI, Google Gemini, Groq, OpenRouter, and other providers. Select **Ollama** for its native API and a reachable server URL, or choose a supported self-hosted/custom endpoint. You can also set fallback models in the config.

**Is it safe to expose OpenClaw to the public internet?**
This template uses Gateway token authentication (`OPENCLAW_GATEWAY_TOKEN`) and requires `WRAPPER_ADMIN_PASSWORD` for setup, management APIs, and the terminal. Browser/device pairing requires explicit approval from the admin dashboard. Public health status excludes Gateway credentials and private configuration. Review the [OpenClaw security docs](https://docs.openclaw.ai/) before deploying to understand the trust model.

**How do I update OpenClaw to a newer version?**
Deploy the branch containing the supported upgrade. The exact OpenClaw version is committed in that branch's `package.json`; Railway version variables and build arguments do not change it. Keep the existing volume, credentials, and a private backup. See **Updating an Existing Installation** above for migration and downgrade requirements.
