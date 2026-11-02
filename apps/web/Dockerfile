# syntax=docker/dockerfile:1.7
# Build from the monorepo root (needs the pnpm workspace for @mpb/sdk):
#   docker build -f apps/web/Dockerfile -t pixelburn-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.pixelburn.applicure.io \
#     --build-arg NEXT_PUBLIC_SOLANA_CLUSTER=devnet .
# Runtime env (server only): SOLANA_RPC (required for /api/rpc), RPC_RATE_PER_MIN, RPC_SEND_PER_MIN.

ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@11.21.0 && pnpm --version
WORKDIR /repo

# ---- deps: only manifests, so this layer caches across source edits ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/sdk/package.json packages/sdk/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@mpb/web..." --store-dir /pnpm/store

# ---- build: sdk first (workspace dep), then the standalone Next app ----
FROM deps AS build
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_SOLANA_CLUSTER="devnet"
# Coolify passes SOURCE_COMMIT; it becomes Next's deploymentId (version-skew protection across deploys)
ARG SOURCE_COMMIT=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_PUBLIC_SOLANA_CLUSTER=${NEXT_PUBLIC_SOLANA_CLUSTER} NEXT_DEPLOYMENT_ID=${SOURCE_COMMIT}
COPY packages/sdk packages/sdk
COPY apps/web apps/web
RUN pnpm --filter @mpb/sdk build && pnpm --filter @mpb/web build

# ---- runtime: standalone server only ----
FROM ${NODE_IMAGE} AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
# slim has no curl/wget: probe /healthz with node's fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
