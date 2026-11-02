# @mpb/sdk

TS client for the `pixel` program (The Million Pixel Burn). ESM + types; `@solana/web3.js` v1.

```ts
import { buildBuyWithSolIxs, isRectFree, quoteUsd, quoteLamports, parseEvents, fetchCanvas } from "@mpb/sdk";
```

- **Constants / ids**: `TOKEN_SYMBOL`, `PROGRAM_ID`, `PRICE_PER_BLOCK_USD_MICRO`, `GRID`, `BITMAP_BYTES`, `AUCTION_*` …
- **PDAs**: `configPda`, `canvasPda`, `buybackVaultPda`, `adPda(x, y)` / `adPdaForBlock(i)` (ad address = top-left block), `auctionAdPda()`, `adAddress(ad)`, `auctionPda`, `pythPriceFeedAccount()`, `associatedTokenAddress`
- **Geometry**: `blockIndex`, `rectBlocks`, `isValidRect`, `isRectFree(bitmap, rect)`, `markRect`, `countSet`, `freeBlocks`, `validateAdContent`
- **Quotes (bigint)**: `quoteUsd`, `quoteLamports`, `quoteTokens` (display), `quoteTokensExact` (on-chain exact), `splitSol`, `withSlippage`, `minNextBid`, `spotPriceQ`, `emaUpdate`
- **Accounts**: `decodeConfig|Canvas|Ad|Auction`, `fetchConfig|Canvas|Auction|AllAds`, `fetchAd(address)`, `fetchAdAt(x, y)`, `decodePriceUpdateV2`, `fetchSolUsd`, `readSpotPriceQ`
- **Events**: `parseEvents(logs)` → typed `PixelEvent[]`, `decodeEventData(base64)`
- **Instructions** (IDL-driven account order): `buyWithSolIx`, `buyWithTokenIx`, `crankTokenPriceIx`, `releaseBuybackIx`, `recordBuybackBurnIx`, `updateAdIx`, `transferAdIx`, `startFinalAuctionIx`, `bidFinalAuctionIx`, `restartFinalAuctionIx`, `settleFinalAuctionIx`, `initializeIx`, admin setters, `computeBudgetIxs`
- **High level**: `buildBuyTx` (quote, buy ix, CU limit and capped priority fee, returning an unsigned Transaction), `buildBuyWithSolIxs`, `buildBuyWithTokenIxs`, `buildBidIxs`, `buildSettleIxs`
- **Compute**: `CU_LIMITS`, `buyCuLimit(rect, mode)`, `estimatePriorityFee(connection, accounts, {percentile, min, max})`
- **`@mpb/sdk/pyth`**: Hermes fetch + fresh price posting (optional peer dep, see chain/NOTES.md)

`pnpm sync-idl` after `anchor build` in `/chain`. `pnpm test` includes a LiteSVM test that runs SDK-built instructions against `chain/target/deploy/pixel.so`.
