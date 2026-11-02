# @mpb/web: notes

Next.js 16.4.3 (App Router, Turbopack), React 19.3.1, Tailwind 4.3.3, motion 14.9.0, Lenis 1.3.27,
three 0.187.0, Solana wallet adapter (wallet-standard discovery) + web3.js 1.99.0, `@mpb/sdk` (workspace).
All versions pinned exactly. Visual direction and tokens: `DESIGN.md`. Product facts used: `PRODUCT.md`.

```
pnpm --filter @mpb/web dev        # http://localhost:3000, mock data
pnpm --filter @mpb/web build && pnpm --filter @mpb/web start
pnpm --filter @mpb/web typecheck | lint
node apps/web/scripts/screens.mjs http://localhost:3000   # Playwright review screenshots → apps/web/screens/
```

Env (`.env.example`). Client (baked at build): `NEXT_PUBLIC_API_URL` (unset = mock) and
`NEXT_PUBLIC_SOLANA_CLUSTER` only. Server-only: `SOLANA_RPC` (upstream for `/api/rpc`), optional
`RPC_RATE_PER_MIN` (default 120) and `RPC_SEND_PER_MIN` (default 12). Local real API: `NEXT_PUBLIC_API_URL=http://localhost:8788`
(services' CORS allows `http://localhost:3000`, so run the web on 3000).

## Deploy (Coolify, Docker, Traefik TLS)

- `apps/web/Dockerfile`, **build context = repo root**:
  `docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.pixelburn.applicure.io --build-arg NEXT_PUBLIC_SOLANA_CLUSTER=devnet -t pixelburn-web .`
  Multi-stage on `node:24-slim`: pnpm install (manifests only, cached), `@mpb/sdk` build, Next `output: "standalone"`
  (`outputFileTracingRoot` = repo root), runtime runs `node apps/web/server.js` as `node` on port 3000.
  `HEALTHCHECK` uses node `fetch` against `GET /healthz` (no curl/wget in slim). `apps/web/Dockerfile.dockerignore`
  keeps node_modules, .next, chain/, services/, screens and .env files out of the context.
- Runtime env in Coolify: `SOLANA_RPC` (secret). `NEXT_PUBLIC_*` must be build args, because they're inlined at build.
- **`/api/rpc`**, the same-origin JSON-RPC proxy that the wallet connection and SDK use. Guards: `Sec-Fetch-Site: same-origin`
  (or `Origin` host = request host) else 403; no batches (400); method allow-list of reads plus `sendTransaction` /
  `simulateTransaction` (`getProgramAccounts` and other expensive calls are 403); 32 KB body cap (413); per-IP fixed
  window from `X-Real-Ip`/`X-Forwarded-For` (429 + Retry-After; sends limited separately); 15 s upstream timeout;
  the request is re-serialised from vetted fields only. The limiter is in-memory per container (fine for one replica).
  Confirmation polls `getSignatureStatuses` (no websocket through the proxy).
- **Headers** on every route: CSP (`default-src 'self'`; scripts self + inline, because static pages carry Next's inline
  bootstrap and a nonce would force dynamic rendering; img from self, data/blob, the API origin and Arweave/Irys
  gateways; connect to self and the API origin; `frame-ancestors 'none'`, `object-src 'none'`, `frame-src 'none'`,
  `upgrade-insecure-requests`), HSTS 2y + preload, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy,
  COOP same-origin-allow-popups (wallet popups).
- Verified locally: image builds (~25 s warm), container reports `healthy`, all proxy guards return the expected codes,
  `SOLANA_RPC` is absent from `.next/static` (the only devnet URL in the bundle is web3.js' public `clusterApiUrl`
  table), and the containerised site runs against the real services API on :8788 with no console errors or CSP
  violations (`node scripts/smoke.mjs http://localhost:3000`, output in `screens/real-api/`).

## What's built

- **/**: WebGL hero (`components/landing/KilnScene.tsx`, three, lazy): 10,000 instanced tiles rise as embers
  and assemble into the live billboard texture; cursor heats and lifts tiles; live purchases flash white-hot.
  CSS-only kinetic headline (Anybody width axis). Firing-log ticker. Scroll-pinned 2005 story: a canvas-drawn
  2005 homage page that chars and burns away in a WebGL dissolve shader to reveal 2026. Money-flow canvas
  (SOL splits 50/50 into a cobalt treasury vessel and a firebox; buyback events trigger an ember flare and a
  status card). Pay-in-$PIXEL section with a live dual quote (SOL vs $PIXEL −10%) that refreshes with a
  countdown. Live odometers + animated firing log (SSE). Auction teaser with pyrometric witness cones that
  slump as % sold rises. FAQ. Footer whose sign-off widens with scroll.
- **/canvas**: full-screen 2D-canvas explorer: wheel/trackpad/pinch zoom around the cursor, drag pan with
  momentum projection and rubber-banding, minimap (click/drag to jump), per-ad hover tooltip, "leaving site"
  confirm dialog, select mode with block-snapped rectangle, sold blocks shaded, overlap shown as hatched red,
  live price in USD/SOL/$PIXEL. Keyboard: arrows move a block cursor, Shift+arrows grow the selection, +/−/0
  zoom/fit, S toggles mode, Enter buys / opens ad, Esc clears; status announced via a live region.
  `?select=1&w=8&h=5` (from the landing converter) auto-finds and selects a free spot of that size.
- **Purchase sheet**: right drawer on desktop, bottom sheet on mobile with drag-to-dismiss (flick projected
  with d=0.998). Image upload/drop, crop/position at the exact `w*10 × h*10` px with zoom and arrow-key nudge,
  1:1 preview; title (≤64) and https link (≤200) validation; SOL | $PIXEL −10% toggle; quote with countdown
  ring; wallet connect (Phantom/Solflare/Backpack via wallet-standard, install links when missing, demo
  wallet in mock mode); step list (upload → build → sign → confirm); success state with odometer, ember burst
  and a 1200×630 share card ("My ad burned X $PIXEL") with Share on X / Save card.
- **/burns**: totals as odometers, supply bar, cumulative "firing curve" (stacked direct vs buyback burns,
  crosshair tooltip), treasury transparency (SOL raised → treasury / buyback vault / spent / waiting, plus
  program addresses), buyback table, leaderboard.
- **/auction**: designed not-started state (cones, blocks to go, progress to 9,900, rules, map of the current
  lot) and a live state (HH:MM:SS drum countdown, high bid, bid form with minimum, bid list, lot map).
  `?preview=live` shows the live design in mock mode.
- Reduced motion: no WebGL hero (static canvas fades in), no scroll pin (2005 story becomes a static
  section), no particles, counters jump, sheet/menus cross-fade. `prefers-reduced-transparency` makes glass
  solid. Lenis is off on /canvas and for reduced motion.

## Data layer

`lib/api.ts` implements every row of the SPEC Services table (`stats, ads, ads/:id, occupancy, canvas.png,
feed, leaderboard, quote, auction, events (SSE), uploads`). `lib/store.ts` keeps one live store
(useSyncExternalStore) fed by the SSE stream; the composed canvas is a single offscreen 1000×1000 canvas shared
by hero texture, explorer, minimap and thumbnails. The HTTP adapter normalises the services DTOs (unix seconds
→ ms, nullable prices → 0, `AuctionDto` → the page's auction shape, purchase feed items without `title`).

**Mock** (`lib/mock.ts`, used when `NEXT_PUBLIC_API_URL` is unset): deterministic seed, ~35% sold (≈3,480 blocks,
denser toward the top like 2005), procedural pixel-art ads (`lib/adArt.ts`: sprites, wordmarks, sunsets,
coins, patterns...), Zipf-distributed owners, 45 days of buyback history, a fake purchase every 3–7 s and a
buyback every 11–20 s, price random walk. Purchases made through the sheet are committed into the mock world
and drawn on the canvas.

## Chain

`lib/chain.ts` defines `ChainClient` (buy, bid). Mock mode simulates the steps. Otherwise it uses `@mpb/sdk`
(dynamically imported): `validateAdContent` → `buildBuyWithSolIxs` / `buildBuyWithTokenIxs` (slippage 150 bps) /
`buildBidIxs` → v0 transaction → `wallet.sendTransaction` → poll for confirmation. It refuses to send if the SDK's fresh
quote exceeds the user's quote + 1%. The ad is identified by the SDK's ad PDA (`quote.ad`). /burns derives program and
buyback-vault addresses from the SDK and reads treasury + mint from the config account through `/api/rpc`.
Not exercised against a live cluster from this workstream (no deployed program / RPC config was available).

## Deviations from SPEC

- SPEC says "Wallet + tx building through @mpb/sdk": done, but the web also keeps pure quote math in
  `lib/quote.ts` (mirrors SDK `quoteUsd/quoteLamports/quoteTokens/isRectFree`) for the mock and for instant UI
  pricing. Live pricing always comes from `/api/quote`. Could be swapped to SDK re-exports.
- Brand constants live in `lib/config.ts` (`BRAND.ticker`); the SDK has its own `TOKEN_SYMBOL`. Two places
  to rename. Could import from the SDK instead.
- The /burns chart and buyback table are derived from `/api/feed?limit=500` (no dedicated history endpoint).
- /auction bids go through the wallet (`chain.bid` → SDK `buildBidIxs`). The live auction view is a lazy chunk
  (`components/auction/LiveAuction.tsx`) that mounts the wallet layer. Min next bid = `minNextBid` from the pure
  `@mpb/sdk/quote` subpath (2.6 KB, no web3.js/Anchor; doesn't rely on the bundler honouring `sideEffects`).
- **Token payment gating** (`lib/tokenStatus.ts`): the SOL quote always runs and carries `tokenPaymentStatus`,
  `tokenBlocksAvailable` and `tokenPricedBy` for the exact w×h. When it isn't `ok`, the $PIXEL option is disabled
  with one honest line per reason (not_seeded, warming_up, stale, deviation, hourly_cap with a "pay in SOL or split
  into ads of up to N blocks" suggestion, unknown/future = unavailable). `slow_ema` pricing shows a hint that
  buyers burn more than spot implies. The landing widget and the /canvas selection bar show the same state.
  Never signing a failing tx: the SDK throws `TokenPricingUnavailableError` before signing (mapped to the same copy,
  and the sheet falls back to SOL), and every tx is simulated via `/api/rpc` before the wallet is asked to sign.
  Buys use SDK `buildBuyTx` (CU limit + capped priority fee). Mock-only design override:
  `/canvas?tokenStatus=deviation|warming_up|hourly_cap&tokenBlocks=24&pricedBy=slow_ema`.
- The landing converter shows a live *estimate* from the SSE stats prices; binding quotes (`/api/quote`) are only
  requested in the selection bar and purchase sheet (debounced, backs off on 429; services rate-limits quotes).

## Requests to other workstreams

- (done by services: feed `title` (null until approved), `/api/buybacks` paging (used on /burns), `bids[]` on
  `/api/auction` (used), quote `tokenPaymentStatus`/`tokenPricedBy`/`tokenBlocksAvailable` (used).)
- **services**: CORS for production is set via CORS_ORIGINS at deploy. (1) `GET /api/feed?type=buyback&before=<ts>` so /burns can page through full history.
  (2) Include `title` in purchase `FeedItem`s (the web currently shows "Ad #id" for live events in HTTP mode).
  (3) Optional `bids[]` on `/api/auction` (the web currently derives it from the feed).
  (4) Timestamps: SPEC doesn't fix the unit; services sends seconds. The web accepts both. Please keep it stable.
- **chain/sdk**: export a `minNextBid` already used internally (for the bid form), and a helper that returns
  the expected token burn for a SOL purchase at current prices (the success card currently estimates half of
  the USD at the quoted token price).

## Known gaps (honest list)

- Lighthouse mobile on `/` (prod build; same numbers for the Docker image against the real API):
  devtools throttling: performance 99, a11y 100, best-practices 96, SEO 100, LCP 1.6 s, TBT 30–40 ms, CLS 0.02.
  Simulated (Lantern) throttling: performance 91–93, LCP 3.2 s, TBT 60–170 ms, CLS 0.005. Observed (unthrottled) LCP is
  46 ms; the simulated 3.2 s is the model charging the preloaded display + body webfonts (~100 KB) to the text LCP.
  Getting the simulated number under 2.5 s would need smaller font files (static, non-variable cut of Anybody).
- Copy policy: the site never claims "every pixel burns". SOL purchases: half to treasury, half to buyback-and-burn.
  $PIXEL purchases: every token paid is burned. Hero, share card, footer, metadata and auction copy follow this.
- Landing scroll story uses `position: sticky` + motion `useScroll`, not GSAP (GSAP was dropped to save weight).
- The WebGL hero has no explicit context-loss handling; it falls back to the 2D canvas only when WebGL2 is
  missing at mount.
- Screen-reader coverage of the canvas is a status line plus keyboard model; individual ads are not in the
  accessibility tree as a list (a hidden list of ads per viewport would help).
- The mobile select gesture is one-finger select / two-finger pan; there's no long-press to start a selection.
- In HTTP mode, newly purchased ads need `/api/ads/:id` to return 200 before they are drawn (unapproved ads
  only update occupancy, by design). Canvas PNG is refetched with a 1.5 s debounce.
- The impeccable finish-review and documenter subagent passes were not run (time/budget); the detector ran
  once (one finding, fixed) and two screenshot inspection rounds were done.
- `next dev` writes `apps/web/AGENTS.md` automatically; it's harmless.
