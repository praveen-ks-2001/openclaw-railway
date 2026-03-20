# ─── Stage 1: Build node-pty (requires native compilation) ─────────────────
FROM node:22-bookworm-slim AS builder

# node-pty needs python3, make, g++ to compile its native binding.
# git is needed because openclaw's transitive deps (baileys → libsignal-node)
# reference a GitHub SSH URL.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

# Write .npmrc to force HTTPS for all GitHub git deps.
# npm reads this before resolving any git URLs, so ssh://git@github.com/* → https://github.com/*
# This prevents "ssh not found" errors in CI/Docker environments without SSH keys.
RUN printf '[url "https://github.com/"]\n\tinsteadOf = ssh://git@github.com/\n\tinsteadOf = git@github.com:\n' > /root/.gitconfig \
    && git config --global --list

RUN npm install --omit=dev


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# Runtime deps:
# - bash: required by node-pty for the shell
# - procps: for process management
# - curl: for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled node_modules from builder stage
# (includes node-pty native .node binary built for this exact OS/arch)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/
COPY public/ ./public/
COPY package.json ./

# /data is the Railway volume mount path for all persistent state.
# Create it so the image works even without a volume attached (dev/test).
RUN mkdir -p /data/.openclaw/nodes /data/.openclaw/workspace

# ── Critical: add node_modules/.bin to PATH ──────────────────────────────────
# When running `node src/server.js` directly (not via npm run), PATH does NOT
# include node_modules/.bin. We must add it explicitly so that `openclaw`
# binary (installed as npm package) is found by spawn() and execFile().
ENV PATH="/app/node_modules/.bin:${PATH}"

# Railway sets PORT automatically; default to 3000
ENV PORT=3000
ENV NODE_ENV=production
ENV OPENCLAW_DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:${PORT}/api/status || exit 1

CMD ["node", "src/server.js"]