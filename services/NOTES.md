# @mpb/services: notes

The HTTP API, indexer, moderation, composer, uploads, pricing and keeper for The Million Pixel Burn.
Contract: `/SPEC.md` ("Services API").

## How to run

```bash
# 1. Postgres: pick option A or B
cd services && docker compose up -d postgres          # A: Docker, 127.0.0.1:54329, db mpb (+ mpb_test for tests)
#   B: an existing local Postgres. createdb mpb && createdb mpb_test, then set DATABASE_URL accordingly

cp .env.example .env                                  # set DATABASE_URL / PORT / ADMIN_TOKEN as needed
pnpm --filter @mpb/services seed                      # wipes DB, ~300 demo ads, history, renders canvas
pnpm --filter @mpb/services dev                       # API (runs migrations on start), default :8787
pnpm --filter @mpb/services indexer                   # standalone indexer (needs PROGRAM_ID); or INDEXER_ENABLED=1 in the API
pnpm --filter @mpb/services keeper                    # keeper, DRY-RUN unless KEEPER_LIVE=1
pnpm --filter @mpb/services test                      # vitest against real Postgres (TEST_DATABASE_URL or <DATABASE_URL>/mpb_test)
pnpm --filter @mpb/services typecheck
```

Point the web app at it with `NEXT_PUBLIC_API_URL=http://localhost:8787`. Local dev is unchanged
(tsx, `.env`, default `DATA_DIR=./var`). Prod-style local run: `pnpm --filter @mpb/services build && node services/dist/server.js`. On this dev machine port
8787 is taken by another project's container, so the local `.env` uses `PORT=8788`.

## Deploy (Coolify, Docker + Traefik TLS)

Target: `https://api.pixelburn.applicure.io`. One image definition, `services/Dockerfile`, with three
build targets. **Build context = repo root**: the build needs the workspace `pnpm-lock.yaml`, and
`packages/` is copied in so `@mpb/sdk` gets installed and built as soon as services depends on it
(`pnpm --filter "@mpb/services..."`). Excludes: BuildKit uses `services/Dockerfile.dockerignore`, and
the root `/.dockerignore` covers other builders. Both keep `**/.env*` (except `.env.example`),
keypairs, `.git`, `node_modules` and build output out of the context. I verified that no `.env`
reaches the context.

| Coolify app | Dockerfile | Target | Port | Healthcheck (in image) | Volume |
|---|---|---|---|---|---|
| api | `services/Dockerfile` | `api` (default/last stage) | 8080 | `node dist/healthcheck.js http /readyz` (DB only) | `/data` |
| indexer | `services/Dockerfile` | `indexer` | none | heartbeat file, max age 240s (refreshed after every backfill pass, and while waiting for the lock) | none |
| keeper | `services/Dockerfile` | `keeper` | none | heartbeat file, max age 120s | none |

```bash
docker build -f services/Dockerfile --target api     -t mpb-api .
docker build -f services/Dockerfile --target indexer -t mpb-indexer .
docker build -f services/Dockerfile --target keeper  -t mpb-keeper .
```

- Each target has its own `CMD` (Coolify can't override the command): `node dist/server.js`,
  `node dist/indexer/main.js` and `node dist/keeper/main.js`. TS is compiled with `tsc` into `dist/`.
  The runtime is `node:24-slim` running as user `node`, with prod dependencies only from
  `pnpm deploy --prod`. The image is about 585MB, mostly sharp/libvips plus @solana/web3.js and the
  Irys SDK.
- **Migrations** run on api start, and on indexer start too, under a Postgres advisory lock, so
  containers starting together don't race.
- **Single indexer**: the indexer only runs while it holds the advisory lock `7204771002`, kept on
  a dedicated connection. During a rolling deploy the new container logs "another indexer holds
  the lock; waiting" and takes over within about 5s of the old one stopping. If the lock
  connection drops, the standalone indexer **exits(1)** so Docker restarts it, and it then waits for
  the lock again. In-API mode stops and re-acquires instead. A "waiting for indexer lock" line is
  logged every 60s while waiting. I tested this with two containers against
  devnet. Keep `INDEXER_ENABLED=0` on the api app in prod. It is safe to enable (same lock) but
  pointless.
- **Health**: `/readyz` returns 200 or 503 based on DB only. `/healthz` returns
  `{ok, db, indexer: {lastSignatureSlot, lastCheckedAt, secsSinceCheck, chainFinalizedSlot, lagSlots, provisionalTxs, stale}, uptimeSecs, sseClients}`
  for monitoring. It is 200 while the DB is up; `ok:false` means the indexer is stale (no successful
  backfill pass for more than 3× `INDEXER_BACKFILL_INTERVAL_MS`). `/health` remains as a trivial
  liveness check.
- **Image URLs**: `imageUrl` and `previewUrl` for dev-storage files are always built from
  `PUBLIC_API_URL`. URIs stored with a localhost origin (e.g. seeded before the URL was set) are
  rewritten, and the moderation worker and composer read them from `/data/files`. Arweave/Irys URIs
  are untouched.
- **Traefik**: set `TRUST_PROXY=1`. The rate limiter then keys on the first `X-Forwarded-For` hop,
  which Traefik sets from the real client.
- **Persistent data**: mount a volume at **`/data`** (`DATA_DIR`) on the api. `files/` holds
  dev-mode uploads served at `/files/*` (only used without `IRYS_KEY`). `cache/` holds the image
  cache and `canvas.png`. The canvas is re-rendered from the DB plus the image cache on start, so
  losing `cache/` only costs re-fetching images from Arweave.
- **Env** (names match the existing infra). Required: `DATABASE_URL`, plus `SOLANA_RPC` and/or
  `SOLANA_RPC_HELIUS_KEY`. Set `SOLANA_CLUSTER=devnet|mainnet-beta`,
  `CORS_ORIGINS=https://pixelburn.applicure.io`, `PUBLIC_API_URL=https://api.pixelburn.applicure.io`,
  `LOG_LEVEL`, `TRUST_PROXY=1` (Traefik), `ADMIN_TOKEN`, `PROGRAM_ID`, `TOKEN_MINT`, and optionally
  `HELIUS_WEBHOOK_SECRET`, `HERMES_API_KEY` and `IRYS_KEY`. HTTP RPC resolves as
  `RPC_URL` > `SOLANA_RPC` > Helius > public. Websockets resolve as `WS_URL` > Helius
  (`wss://{devnet|mainnet}.helius-rpc.com/?api-key=…`) > derived from HTTP. All the same env can go
  on all three apps; the keeper additionally needs `KEEPER_KEYPAIR` (and `KEEPER_LIVE=1` only once
  it's intended).
- **Prices in production**: SOL/USD is read on-chain from the Pyth sponsored `PriceUpdateV2` account
  (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, from `@mpb/sdk` `pythPriceFeedAccount()`; the same
  account the program reads) through the configured RPC. No Hermes key is needed. Hermes is used only
  when `HERMES_API_KEY` is set. Prices older than `SOL_PRICE_MAX_AGE_SECS` (120) or not fully verified
  return 503. `SOL_USD_FALLBACK` is ignored when `NODE_ENV=production` (the image sets it). The token
  price comes from chain when `PROGRAM_ID` is set. Without it, production reports
  `tokenPaymentStatus: "unknown"` and never quotes a static token price.
- **Coolify apps (devnet, 2026-11-02)**: `pixelburn-api` (xvlz2veeyem2wmwl2wp7yiwt),
  `pixelburn-indexer` (ymqskn1mdvofamqrvsagqdjk, target `indexer`, no domain) and `pixelburn-keeper`
  (tmjd8oi0tegozxrplcveegzj, target `keeper`, no domain, `KEEPER_LIVE=1`). All secrets are runtime-only.
  The keeper has no `DATABASE_URL` (least privilege). RPC = Helius devnet via `SOLANA_RPC_HELIUS_KEY`;
  never QuickNode mainnet.
- **Keeper buyback routes**: these are resolved from the current Config on every run. While the
  token is on the pump.fun curve the keeper uses `pump-curve` (legacy `buy`, exact tokens out, live
  mint supply); after graduation it uses `pumpswap-pool` (canonical pool `buy`, exact base out, max
  quote wrapped in WSOL and closed again); `jupiter` is the last fallback (mainnet only). Every
  chunk is ONE tx: release → buy → record. A chunk with no route, too much impact, or a min-out
  below the on-chain EMA bar is skipped before anything is built, so `release_buyback` is never
  sent alone. Dry-run with a keypair simulates the exact tx. Devnet sizing (thin pool: 0.1 SOL ≈ 10%
  impact): chunks 0.02–0.05 SOL, impact cap 8%, every 10 ± 2 min. Mainnet should keep the 1% cap.
- **Pointing at the deployed program**: api needs `PROGRAM_ID` + `TOKEN_MINT`. indexer needs
  `PROGRAM_ID`. keeper needs `PROGRAM_ID` + `KEEPER_KEYPAIR` (must equal `Config.keeper`) + `TOKEN_MINT`
  (Jupiter quotes / leftover burn), plus `KEEPER_LIVE=1` to actually send. All three also need the
  shared RPC/DB env that is already set.
- **Secrets never logged**: `loadConfig()` registers the RPC URLs (including QuickNode path keys),
  the Helius key, the DB URL and password, admin/webhook tokens, and the Irys/keeper/Hermes keys.
  All `console.*` output, including library logs, goes through a redactor, which also masks
  `api-key=`, `Bearer …` and `user:pass@` patterns. Startup logs print the cluster and public URL,
  never the RPC. I verified this with fake keys in containers: 0 occurrences in the logs.
- **Helius webhook**: point it at `https://api.pixelburn.applicure.io/webhooks/helius`. Set its auth
  header to the value of `HELIUS_WEBHOOK_SECRET`.
- **Demo data on a deployed DB** (wipes all tables):
  `docker exec -e SEED_ALLOW_PRODUCTION=1 <api-container> node dist/seed.js`. Image URLs use
  `PUBLIC_API_URL`, so run it inside the api container (`/data` volume).
- Traefik terminates TLS and proxies to port 8080. SSE (`/api/events`) needs no buffering config,
  since it streams with a 15s ping.

## Architecture

```
            Solana RPC/WS                         Helius webhook
                 |                                      |
   Indexer (src/indexer) ---- ingestTx() <--- POST /webhooks/helius
    - backfill: getSignaturesForAddress(finalized) from cursor -> getTransaction -> logs
    - live: onLogs(confirmed) -> provisional rows
    - finalizer: getSignatureStatuses -> mark finalized | roll back dropped forks
                 |
            Postgres (drizzle; migrations in ./drizzle)
   ads, chain_events, purchases, buybacks, auction_bids, auction, price_snapshots, indexer_cursor
                 |  pg_notify('mpb_events')   <- every ingest/moderation change (works across processes)
                 v
   API process (src/server.ts, Hono):
    - ModerationService: hydrate ad content from the Ad PDA -> automatic checks -> pending/rejected
      (admin approves; AUTO_APPROVE=1 approves ads that pass the checks)
    - Composer: in-memory RGBA canvas; incremental composite on approve, full rebuild on startup,
      on reject of an approved ad, on AdUpdated, and on fork rollback. Serves PNG with ETag.
    - SSE bus: feed items + debounced stats pushed to /api/events
   Keeper (src/keeper, separate process): crank every 60s; jittered buybacks in random chunks
```

- **Idempotency**: `chain_events` PK is `(signature, event_index)`. Each tx is ingested in one DB
  transaction under `pg_advisory_xact_lock(hashtext(signature))`, so concurrent deliveries (logs +
  webhook + backfill) are safe. Derived tables also carry unique `(signature, event_index)`.
- **Finality**: only `finalized` data advances the cursor. `confirmed` data (onLogs, Helius) is stored
  with `finalized=false` and appears in the API right away (feed items carry `finalized`). The
  finalizer promotes rows once the signature is finalized. If a signature errors, or has no status
  for `INDEXER_DROP_AFTER_SECS`, the finalizer rolls back all of its effects. Finalized rows are
  never rolled back.
- **Chain access is all @mpb/sdk** (workspace dependency): `parseEvents` (Anchor EventParser over
  the IDL, invoke-stack aware) behind `EventParser`/`SdkEventParser`; `decodeAd`, `decodeConfig` and
  `decodeAuction`; `readSpotPriceQ` (curve virtual reserves, or pool vault + `virtual_quote_reserves`);
  `tokenPricingStatus` (the same gate `buy_with_token` applies); PDAs; and the keeper builders
  `crankTokenPriceIx`, `releaseBuybackIx` and `recordBuybackBurnIx`. Ads are addressed by the
  `ad` pubkey carried in the events (rect PDA = top-left block, auction lot = `["ad_auction"]`), not
  by id. Unknown future events are skipped instead of crashing ingest. A local borsh codec remains
  only for tests and seed fake logs. `test/events.test.ts` asserts that the SDK parser decodes it
  identically, which is an independent cross-check of the IDL layout; it caught the `ad` field being
  added to events.
- **Moderation checks** (`src/moderation/checks.ts`): title length; https-only link with no
  credentials; domain blocklist file (subdomains match); drainer-list hook (file plus optional
  remote URL); image fetch through an allowlist-only fetcher (SSRF guard, each redirect hop is
  re-checked); 5MB cap; magic-byte type check; sha256 equals the on-chain `image_sha256`; dimensions
  equal w*10 × h*10; NSFW hook (`NsfwChecker`, no-op default). Policy failures auto-reject with a
  reason. Network failures are retried. Rejecting never touches the chain. `/api/occupancy` still
  counts rejected ads.
- **Quote math** (`src/lib/quote-math.ts`) mirrors `chain/.../math.rs` rounding exactly: discount
  rounded up, `usd_to_lamports` with the raw Pyth price/expo and ceil, `lamports_to_tokens` with ceil,
  and price = `min(spot, ema)`. Token prices are **q = lamports per base unit × 1e18**, the chain's
  `PRICE_SCALE`. Note that SPEC says "SOL per base unit"; the chain uses lamports.
- **Uploads**: sniffs magic bytes (png/jpeg/webp/gif/avif in, never by extension or declared type),
  EXIF-rotates, cover-crops (sharp "attention") to exactly w*10×h*10, re-encodes to png (or webp
  with `format=webp`), and hashes the final bytes. Files go to Irys (devnet by default) when
  `IRYS_KEY` is set; otherwise they are stored on local disk, content-addressed, and served at
  `/files/<sha>.png` (immutable cache).

## API conventions (also sent to the web agent)

- u64 base-unit amounts (lamports, token base units, usdMicro) are **decimal strings**. USD values
  and prices (`usd`, `usdRaised`, `solPriceUsd`, `tokenPriceUsd`, `marketCapUsd`) are **JS numbers in
  dollars**.
- Every timestamp (`ts`, `createdAt`, `expiresAt`, `updatedAt`, `startedAt`, `endsAt`) is **unix
  seconds**.
- `Ad.payMode` is `sol | token | auction`. The final-auction ad also has `blocks: number[]`, and its
  `x,y,w,h` is the bounding box of those blocks.
- `FeedItem` has `finalized: boolean` (false = confirmed but not yet final). Shapes:
  `{type:'purchase', sig, ts, adId, owner, x, y, w, h, payMode, usd, lamports, tokensBurned, finalized}`,
  `{type:'buyback', sig, ts, lamportsIn, tokensBurned, finalized}`, `{type:'bid', sig, ts, bidder, lamports, finalized}`.
- `/api/quote` always includes `tokenPaymentStatus` (`ok|not_seeded|warming_up|stale|deviation|hourly_cap|unknown`;
  other future SDK reasons pass through in snake_case), `tokenPaymentDetail`,
  `tokenPricedBy` (`spot|ema|slow_ema`, set only when ok), and `tokenBlocksAvailable` (the on-chain
  hourly bucket). The status comes from SDK `tokenPricingStatus(config, spot, now, w*h)`, the same gate
  `buy_with_token` applies. Token amounts use SDK `quoteTokensExact` at min(spot, fast EMA, slow 4h EMA);
  lamports use SDK `quoteLamports`.
- `/api/quote` adds `usdMicro` (string). `usd` is the undiscounted price; for `mode=token` the 10%
  discount is already applied in `tokens`. It returns 503 `{error:'price_unavailable'}` when the
  oracle or EMA is unavailable.
- `/api/auction` (and `stats.auction`):
  `{status, blocksRemaining, startedAt, endsAt, highestBid, highestBidder, bidsCount, winner, winningLamports, adId, bids}`,
  where `bids` = `[{bidder, lamports, ts, sig}]`, newest first, max 200.
- Purchase feed items carry `title: string | null`. It is set only once the ad is approved, so it is
  null for pending/rejected ads and for live SSE items emitted right at purchase time.
- `GET /api/buybacks?cursor=&limit=` (limit 1..200, default 50) returns
  `{items: [{sig, ts, lamportsIn, tokensBurned, finalized}], nextCursor: string | null}`, newest
  first. `nextCursor` is opaque; pass it back as `cursor`. A bad cursor returns 400.
- `/api/ads/:id` for a pending or rejected ad returns 404 `{error:'not_found', status, reason}`, so a
  buyer's UI can show "under review".
- `/api/uploads` also returns `width, height, contentType`. Optional field `format=png|webp`.
- Errors are `{error: string, ...}`, with 400 for validation (`issues` holds the zod issues), 413,
  415 and 429 (with `Retry-After`).
- Admin: `GET /api/admin/queue?status=pending|approved|rejected&limit=`,
  `POST /api/admin/ads/:id/approve`, `POST /api/admin/ads/:id/reject` with JSON `{reason}`. All need
  `Authorization: Bearer $ADMIN_TOKEN`. When `ADMIN_TOKEN` is unset, these return 503.

## Deviations from SPEC

1. **Token-mode `usd`**: following the chain, `AdPurchased.usd_micro` for token purchases is the
   *discounted* USD. So `stats.usdRaised` and `ad.usd` are what was actually paid.
2. **Extra fields**: `finalized` on feed items, `blocks` on the auction ad, `usdMicro` on quotes,
   `width/height/contentType` on uploads, and `sseClients` on `/healthz`. These are additive only.
3. **adsCount** counts every sold ad (any moderation status), consistent with `soldBlocks`. The
   leaderboard excludes rejected ads.
4. **Stats source**: aggregated from the DB plus a cached on-chain token supply. The localnet e2e
   asserts that every DB total equals the on-chain `Canvas` totals and bitmap.
5. **Token quotes return 503** `{error:'token_pricing_unavailable', reason, tokenPaymentStatus, detail}`
   (snake_case reason, e.g. `warming_up`, `hourly_cap`) whenever the program would currently refuse
   `buy_with_token`. SOL quotes are unaffected and carry the same status fields.
6. **Dev image URIs**: the program only accepts `ar://` or `https://` image URIs. Dev-storage upload
   URIs use `PUBLIC_API_URL`, so set it to an https origin (tunnel, or a label like in the e2e)
   whenever ads are bought on-chain against local storage. Otherwise use Irys.

## Requests to other workstreams

- **chain / sdk** (everything requested earlier is delivered and in use)
  - Keep the SDK IDL in sync with `pixel.so`. A mismatch (e.g. `initial_token_ema_price_sol` added
    to `InitializeParams` before sync) only shows up at runtime as `InstructionDidNotDeserialize`.
  - `AuctionBid` extends `end_ts`, and a fork rollback of a bid doesn't restore the previous
    `endsAt` in the DB (see Known gaps).
- **web**
  - Shapes and conventions are listed above. Local base URL: `http://localhost:8788` on this
    machine (8787 in general).
  - The SSE stream sends one `stats` event right after connecting, then `feed`/`stats` events, plus
    a `: ping` comment every 15s.
- **lead / root**
  - My `pnpm add` made pnpm 11 write `allowBuilds` placeholders into the root `pnpm-workspace.yaml`,
    and they break every `pnpm --filter … <script>` (deps check). I set `esbuild: true` and the native
    addons (`bufferutil`, `utf-8-validate`, `bigint-buffer`, `keccak`, `secp256k1`, `protobufjs`) to
    `false`. Any new dependency with a build script will write a new placeholder, which needs
    resolving the same way.
  - Pyth Hermes (`hermes.pyth.network`) now answers **401 without a bearer token**. I added
    `HERMES_API_KEY` (sent as `Authorization: Bearer`). Without a key, the API falls back to
    `SOL_USD_FALLBACK` (dev only). The SDK's Pyth price-update builder will hit the same 401.

## Known gaps / honest limits

- **Verified end-to-end on localnet, not yet on devnet/mainnet**: see "Localnet e2e" below.
- **Keeper swap leg**: crank, `release_buyback` and `record_buyback_burn` ran live via the SDK
  builders in the e2e. The **Jupiter swap in between has not executed on-chain**, because Jupiter
  doesn't exist on localnet; the e2e simulates an out-of-band buy from tokens the keeper already
  holds. Live mode needs `KEEPER_LIVE=1` and `KEEPER_KEYPAIR`. Keep
  `KEEPER_BUYBACK_MAX_PER_RUN_LAMPORTS` ≤ the on-chain hourly cap. The keeper skips buybacks while the
  EMA is notSeeded/warmingUp/stale. `lamports_spent` = Jupiter `inAmount`, and the bar is EMA-only,
  mirrored by `minBuybackTokens`.
- **Tx sending**: `sendIxs` simulates, then sends raw with `maxRetries: 0` and re-broadcasts every
  2s until confirmed or the blockhash expires. With RPC-side `maxRetries: 3`, a v0 tx never landed
  on a fresh test validator.
- **Crank interval**: the keeper sends `crank_token_price` every 60s. The chain enforces 30s between
  updates, so that's fine. A failed crank only logs.
- **Quotes vs chain**: same math and same live reserves, so quotes are exact at quote time (the e2e
  buys with `max = quote` exactly). Prices move between quote and send, so clients should still add
  a small buffer (+1–2%).
- **Keeper heartbeat** shows only that the process is alive (refreshed every 30s). It does not prove
  that cranks succeed; crank failures are logged.
- **Docker image** was built and run locally (OrbStack, arm64), not yet on Coolify (amd64). sharp
  ships prebuilt binaries for both architectures.
- **Rate limiting** is in-memory per process. Behind multiple replicas, use a shared store, or rely on
  the edge/CDN.
- **Composer** keeps the canvas in memory per API process (deterministic, so replicas agree). A
  rebuild re-reads images from the on-disk cache in `DATA_DIR/cache/images`, fetching from Arweave
  on a miss.
- **Auction**: rollback of an `AuctionBid` deletes the bid but does not restore `endsAt`. The lot ad
  is created from DB occupancy at settle time and then replaced by `Auction.lot_bitmap` during
  hydration.
- **NSFW** is a no-op hook (`NsfwChecker`). Wire in a real classifier before mainnet.
- **Helius**: both raw and enhanced payloads are accepted. Enhanced payloads lack logs, so each
  signature costs one `getTransaction`. Helius sends the configured auth header verbatim, so set it
  to exactly `HELIUS_WEBHOOK_SECRET` (`Bearer <secret>` also works).
- **Seed** uses local-disk image URLs built from `PUBLIC_BASE_URL`/`PORT` at seed time. Reseed after
  changing the port. Seed broadcasts a `canvas` NOTIFY, so a running API re-renders.
