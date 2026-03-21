# ─── Stage 1: Build node-pty (requires native compilation) ─────────────────
FROM node:22-bookworm-slim AS builder

# node-pty needs python3, make, g++ to compile its native binding.
# git is needed because transitive deps reference GitHub SSH URLs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

# Force HTTPS for any GitHub git deps (no SSH keys in Docker)
RUN printf '[url "https://github.com/"]\n\tinsteadOf = ssh://git@github.com/\n\tinsteadOf = git@github.com:\n' > /root/.gitconfig

RUN npm install --omit=dev


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# OpenClaw version — set via Railway build args to pin a specific version
ARG OPENCLAW_VERSION=latest

# Runtime deps:
# - bash: required by node-pty for the shell
# - procps: for process management
# - curl: for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    procps \
    curl \
    git \
    ca-certificates \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Install openclaw globally — needs git for transitive deps with GitHub URLs
RUN printf '[url "https://github.com/"]\n\tinsteadOf = ssh://git@github.com/\n\tinsteadOf = git@github.com:\n' > /root/.gitconfig \
    && npm install -g openclaw@${OPENCLAW_VERSION}

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

# ── Ensure node_modules/.bin is in PATH for other local binaries ─────────────
ENV PATH="/app/node_modules/.bin:${PATH}"

# Railway sets PORT automatically; default to 3000
ENV PORT=3000
ENV NODE_ENV=production
ENV OPENCLAW_DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:${PORT}/api/status || exit 1

CMD ["node", "src/server.js"]