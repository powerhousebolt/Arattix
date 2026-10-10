# syntax=docker/dockerfile:1.7
#
# Build from the repository root (the server depends on the library in ../):
#   docker build -f server/Dockerfile -t arattix-server .
#
# No browser in this image on purpose: the arattix library speaks HTTP to Arattai directly
# (axios + cookie jar), so Chromium/Puppeteer would only add ~400 MB and attack surface.

ARG NODE_VERSION=22

# ─── build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

# Library (repo root) production dependencies. The root ships without a lockfile.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY index.js ./
COPY src ./src

# Server: full install for the TypeScript build, then prune to production deps.
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ─── runtime ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    LOG_FORMAT=json \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/index.js ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/node_modules ./node_modules
WORKDIR /app/server
COPY --from=build --chown=node:node /app/server/package.json ./
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.ROLE==='worker'?(process.env.WORKER_PORT||3001):(process.env.PORT||3000);fetch('http://127.0.0.1:'+p+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node is PID 1: the server installs SIGTERM/SIGINT handlers and spawns no children, so no
# init shim is required. `docker run --init` / compose `init: true` is still fine to add.
CMD ["node", "dist/index.js"]
