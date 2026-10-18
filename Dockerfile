FROM node:24.16.0-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.16.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash procps curl git ca-certificates zip unzip python3 build-essential tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
# Version selection belongs to this Git branch. Railway build/runtime variables
# cannot override the source manifest, and mutable npm tags are never installed.
RUN printf '[url "https://github.com/"]\n\tinsteadOf = ssh://git@github.com/\n\tinsteadOf = git@github.com:\n' > /root/.gitconfig \
    && VERSION="$(node -e 'const v=require("./package.json").openclawVersion;if(!/^\d{4}\.\d+\.\d+$/.test(v||""))process.exit(1);process.stdout.write(v)')" \
    && npm install --global --engine-strict --no-audit --no-fund "openclaw@$VERSION" \
    && node -e 'const p=require("./package.json"),a=require("/usr/local/lib/node_modules/openclaw/package.json");if(a.name!=="openclaw"||a.version!==p.openclawVersion)process.exit(1)'
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY public/ ./public/
COPY test/ ./test/
COPY scripts/ ./scripts/
COPY package-lock.json ./
ENV PORT=3000 NODE_ENV=production OPENCLAW_DATA_DIR=/data \
    HOME=/data OPENCLAW_STATE_DIR=/data/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/data/.openclaw/workspace \
    OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js \
    OPENCLAW_NODE=node OPENCLAW_NO_AUTO_UPDATE=1 \
    OPENCLAW_SUPERVISOR_MODE=external OPENCLAW_SERVICE_REPAIR_POLICY=external
ENV PATH="/app/node_modules/.bin:${PATH}"
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=1200s --retries=3 \
    CMD curl --fail --silent http://localhost:${PORT}/api/status || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
