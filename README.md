# openclaw-railway

A Railway-ready wrapper for [OpenClaw](https://openclaw.ai) — the open-source personal AI assistant.

This repo adds:
- **Setup UI** — web form to configure OpenClaw without CLI access
- **Admin dashboard** — live logs, terminal, device pairing, config editor
- **Auto-restart** — gateway process is supervised with exponential backoff
- **Persistent config** — all state lives on a Railway volume at `/data/`

---

## Deploy to Railway

### 1. Fork this repo

Fork to your own GitHub account.

### 2. Create a Railway project

- New Project → Deploy from GitHub repo → select your fork
- Railway will detect the `Dockerfile` automatically

### 3. Add a Volume

- Go to your service → Settings → Volumes
- Mount path: `/data`
- This persists your OpenClaw config and credentials across deploys

### 4. Set environment variables (optional)

| Variable | Description |
|---|---|
| `WRAPPER_ADMIN_PASSWORD` | Password to protect `/admin` and `/api/*`. Leave blank for no auth. |
| `OPENCLAW_DATA_DIR` | Override data directory (default: `/data`) |

### 5. Deploy

Railway will build and deploy. Once running, open your service URL — you'll land on the Setup UI.

---

## First Run

1. Open `https://your-service.railway.app` → redirects to `/setup`
2. Enter your model API key and messaging channel tokens
3. Click **Launch OpenClaw**
4. Once the gateway starts, you're redirected to `/admin`

---

## Admin Dashboard (`/admin`)

| Panel | What it does |
|---|---|
| **Status** | Gateway state, uptime, quick actions (restart/stop) |
| **Logs** | Live SSE log stream from the openclaw process with filter |
| **Terminal** | Full PTY terminal — run `openclaw doctor`, `openclaw models status`, anything |
| **Pairing** | Approve/reject device and browser pairing requests in real time |
| **Config** | View and edit `openclaw.json` with hot-reload |

### Device Pairing

When you open OpenClaw's Control UI (`/ui/`) from a new browser, it sends a pairing request.
Go to **Admin → Pairing** to see and approve it. The badge in the header and sidebar shows
pending count in real time.

### Terminal

The terminal runs directly inside the container with `HOME=/data` set, so all `openclaw` commands
work correctly against the live config. Useful commands:

```bash
openclaw doctor           # diagnose issues
openclaw doctor --fix     # auto-repair
openclaw models status    # check API key auth
openclaw devices list     # list paired devices
openclaw config get agent.defaults.model  # inspect single config value
openclaw logs --tail      # alternative log view
```

---

## Architecture

```
Railway Container
│
├── Express wrapper (public PORT)
│   ├── GET  /              → redirect to /ui/ or /setup
│   ├── GET  /setup         → Setup UI (first run)
│   ├── POST /setup/save    → write config + launch gateway
│   ├── GET  /admin         → Admin dashboard
│   ├── /ui/*               → reverse proxy → openclaw gateway :18789
│   ├── /api/*              → wrapper management API
│   └── /ws/terminal        → PTY WebSocket (xterm.js)
│
├── openclaw gateway (internal :18789)
│   └── spawned as child process, supervised with auto-restart
│
└── Volume at /data/
    ├── .openclaw/openclaw.json   ← config
    ├── .openclaw/.env            ← API keys
    ├── .openclaw/nodes/          ← pairing state
    └── .openclaw/workspace/      ← agent workspace
```

---

## License

MIT
