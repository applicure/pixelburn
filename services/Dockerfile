# syntax=docker/dockerfile:1.7
# @mpb/services. Build context = REPO ROOT (needs the workspace lockfile):
#   docker build -f services/Dockerfile --target api     -t mpb-api .
#   docker build -f services/Dockerfile --target indexer -t mpb-indexer .
#   docker build -f services/Dockerfile --target keeper  -t mpb-keeper .
# The default (last) target is `api`.

ARG NODE_IMAGE=node:24-slim
ARG PNPM_VERSION=11.21.0

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version
WORKDIR /repo
# Workspace packages services may depend on (@mpb/sdk lives in packages/). apps/ is excluded.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/ packages/
COPY services/package.json services/
# `@mpb/services...` = services plus its workspace dependencies (e.g. @mpb/sdk once added).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@mpb/services..." --config.store-dir=/pnpm/store
COPY services/ services/
# Builds workspace deps first (topological), then services.
RUN pnpm --filter "@mpb/services..." build
# Self-contained production install (no workspace links, no devDependencies).
# Self-contained production install. inject-workspace-packages makes workspace deps (@mpb/sdk)
# real copies (not symlinks into /repo) that share services' dependency instances
# (one @solana/web3.js, so PublicKey/instanceof checks work across the boundary).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @mpb/services deploy --prod --config.inject-workspace-packages=true --config.store-dir=/pnpm/store /out \
 && rm -rf /out/src /out/test /out/scripts \
 && cp -r services/dist /out/dist \
 && cp -r services/drizzle services/data /out/ \
 && cd /out && node -e 'import("@mpb/sdk").then(s => console.log("@mpb/sdk ok", s.PROGRAM_ID.toBase58()))'

# ---------------------------------------------------------------- runtime base
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    LOG_LEVEL=info
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# /data: persistent volume for dev-mode uploads (files/) and the canvas/image cache (cache/).
RUN mkdir -p /data && chown node:node /data
USER node

# ---------------------------------------------------------------- indexer
FROM runtime AS indexer
ENV HEARTBEAT_FILE=/tmp/indexer.heartbeat
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "dist/healthcheck.js", "heartbeat", "/tmp/indexer.heartbeat", "240"]
CMD ["node", "--enable-source-maps", "dist/indexer/main.js"]

# ---------------------------------------------------------------- keeper (dry-run unless KEEPER_LIVE=1)
FROM runtime AS keeper
ENV HEARTBEAT_FILE=/tmp/keeper.heartbeat
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js", "heartbeat", "/tmp/keeper.heartbeat", "120"]
CMD ["node", "--enable-source-maps", "dist/keeper/main.js"]

# ---------------------------------------------------------------- api (default target)
FROM runtime AS api
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
# /readyz = DB reachable. Migrations run on start (under an advisory lock).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js", "http", "/readyz"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
