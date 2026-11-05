# Pixel Frame — Build Spec (v1)

Single source of truth for all workstreams.
If you must deviate from a contract here, write it in your workstream's `NOTES.md` under "Deviations from SPEC" — never silently.

Name **Pixel Frame**, ticker **$PXL** (formerly The Million Pixel Burn, $PIXEL). Keep them in ONE config constant per package. Internal identifiers such as `pixel` and `@mpb/*` keep their names: see `brand/README.md`.

## Product rules

- Canvas 1000×1000 px = **100×100 blocks** of 10×10 px. Block index = `by * 100 + bx` (bx, by in 0..99).
- Ads are axis-aligned rectangles of whole blocks: `x, y, w, h` in **block units**, w,h ≥ 1, x+w ≤ 100, y+h ≤ 100.
- Price: **$1 per pixel = $100 per block** (`PRICE_PER_BLOCK_USD_MICRO = 100_000_000`, micro-USD, 6 decimals).
- **Pay in SOL**: lamports = usd / SOL_USD (Pyth). Split **50% treasury / 50% buyback vault** (`TREASURY_BPS = 5000`).
- **Pay in token**: 10% discount (`TOKEN_DISCOUNT_BPS = 1000`), live-converted, **100% of tokens burned** in the purchase tx.
  - token_usd = token_price_in_SOL × SOL_USD, where token_price_in_SOL = **min(spot from pool/curve reserves, on-chain EMA)** → manipulation-resistant (pumping the price inside one tx never lowers the tokens owed).
- Buyback vault SOL is spent only on buying the token and burning it.
- **Final auction**: when `sold_blocks >= 9_900`, fixed-price sales stop; all remaining free blocks become one lot sold in a 72h SOL auction; **100% of the winning bid → buyback vault**. Winner places one ad covering the remaining blocks (stored as a list/bitmap of blocks, not a rectangle).
- Ads: title ≤ 64 chars, link ≤ 200 (https only), image URI ≤ 200 (Arweave/Irys), `image_sha256: [u8;32]`.
- Moderation is off-chain: on-chain record is permanent; the site only renders `approved` ads.
- Pixel Deed NFTs = **phase 2**. v1 ownership = `Ad.owner` with `transfer_ad`.

## Repo layout (pnpm workspace)

```
/SPEC.md
/pnpm-workspace.yaml
/chain/                 Anchor 1.x workspace (programs/pixel, tests)   — owner: chain agent
/packages/sdk/          @mpb/sdk  TS client: constants, PDAs, quote math, ix builders, event decoding — owner: chain agent
/services/              @mpb/services  API + indexer + keeper + composer + uploads — owner: services agent
/apps/web/              @mpb/web  Next.js site — owner: web agent
```
Never edit another workstream's directory. Need something from it? Write it in your NOTES.md "Requests" section.

## On-chain program `pixel` (Anchor)

PDAs: `config` = ["config"], `canvas` = ["canvas"], `buyback_vault` = ["buyback_vault"] (SOL holder), `ad` = ["ad", ad_id u32 LE], `auction` = ["auction"].

Config: admin, treasury, keeper, token_mint, token_program, pyth SOL/USD feed id ([u8;32]), price_source (enum: BondingCurve{curve} | Pool{base_vault, quote_vault}), token_ema_price_sol (u128 fixed-point 1e18 lamports per base unit), ema_updated_at, max_price_age_secs (default 120, hard limit 300), paused, bumps.
Canvas: bitmap [u8;1250], sold_blocks u16, next_ad_id u32, totals (usd_micro_raised, lamports_raised, lamports_to_treasury, lamports_to_buyback, tokens_burned_direct, tokens_burned_buyback, lamports_spent_buyback).
Ad: id, owner, x,y,w,h (u8), title, link, image_uri, image_sha256, pay_mode (Sol|Token), paid_lamports, paid_tokens, usd_micro, created_at.

Instructions:
- `initialize`, admin setters (`set_paused`, `set_treasury`, `set_keeper`, `set_price_source`)
- `buy_with_sol(x,y,w,h,title,link,image_uri,image_sha256,max_lamports)` — Pyth PriceUpdateV2 (pull oracle), staleness ≤ max_price_age_secs, slippage guard.
- `buy_with_token(…, max_tokens)` — burns via token_interface (works for SPL Token and Token-2022).
- `crank_token_price()` — permissionless; reads reserves, updates EMA; min 30s between updates.
- `buyback_and_burn(lamports_in, min_tokens_out)` — preferred: atomic CPI into pump.fun curve / PumpSwap then burn. Acceptable v1 fallback: keeper-only, rate-limited release + `record_buyback_burn` — document trust trade-off.
- `update_ad`, `transfer_ad` (owner only)
- `start_final_auction`, `bid_final_auction` (refund previous bidder), `settle_final_auction`

Events (Anchor `emit!`): `AdPurchased{ad_id, owner, x,y,w,h, pay_mode, lamports, tokens_burned, usd_micro, ts}`, `AdUpdated{ad_id, ts}`, `AdTransferred`, `TokenPriceUpdated{spot, ema, ts}`, `BuybackBurned{lamports_in, tokens_burned, ts}`, `AuctionStarted`, `AuctionBid{bidder, lamports, ts}`, `AuctionSettled{winner, lamports, ad_id}`.

## SDK `@mpb/sdk` (packages/sdk)

Exports: constants above, `PROGRAM_ID`, PDA helpers, `blockIndex`, `rectBlocks`, `isRectFree(bitmap, rect)`, `quoteUsd(w,h)`, `quoteLamports(usdMicro, solUsd)`, `quoteTokens(usdMicro, tokenUsd, decimals)` (with discount), account decoders, event parser, and instruction builders returning `@solana/web3.js` v1 `TransactionInstruction[]` (including the Pyth price-update post ixs via Hermes). Pure functions must have unit tests.

## Services API `@mpb/services` (HTTP, default `http://localhost:8787`)

All JSON, camelCase, amounts as strings for u64 values. CORS open for the web origin.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/stats` | `{soldBlocks, totalBlocks, adsCount, usdRaised, lamportsRaised, lamportsToTreasury, lamportsToBuyback, lamportsSpentBuyback, tokensBurned, tokensBurnedDirect, tokensBurnedBuyback, tokenSupply, burnedPct, solPriceUsd, tokenPriceUsd, marketCapUsd, auction: null \| {...}, updatedAt}` |
| GET | `/api/ads` | `Ad[]` approved only: `{id, owner, x, y, w, h, title, link, imageUrl, payMode, usd, createdAt}` |
| GET | `/api/ads/:id` | `Ad` |
| GET | `/api/occupancy` | `{bitmap: base64(1250 bytes), soldBlocks}` — includes pending/unapproved (sold is sold) |
| GET | `/api/canvas.png` | 1000×1000 PNG of approved ads, ETag |
| GET | `/api/feed?limit=50` | `FeedItem[]` newest first: `{type:'purchase'\|'buyback'\|'bid', sig, ts, …}` |
| GET | `/api/leaderboard` | `[{owner, blocks, usd, tokensBurned}]` |
| GET | `/api/quote?w=&h=&mode=sol\|token` | `{usd, lamports?, tokens?, solPriceUsd, tokenPriceUsd, discountBps, expiresAt}` |
| GET | `/api/auction` | auction state or null |
| GET | `/api/events` | SSE stream: `event: feed` (FeedItem), `event: stats` (Stats) |
| POST | `/api/uploads` | multipart `file, w, h` → `{uri, sha256, previewUrl}` (resize/crop to w*10×h*10; Irys/Arweave, local fallback in dev) |
| GET/POST | `/api/admin/queue`, `/api/admin/ads/:id/approve\|reject` | bearer `ADMIN_TOKEN` |
| POST | `/webhooks/helius` | Helius enhanced webhook ingest (auth header) |

Env: `RPC_URL`, `WS_URL`, `PROGRAM_ID`, `DATABASE_URL` (Postgres), `ADMIN_TOKEN`, `KEEPER_KEYPAIR`, `IRYS_KEY` (optional), `HELIUS_WEBHOOK_SECRET` (optional).

## Web `@mpb/web`

Reads everything through `NEXT_PUBLIC_API_URL`; when unset, uses a built-in mock adapter with realistic, animated data (so design work never blocks on backend). Wallet + tx building through `@mpb/sdk`.
