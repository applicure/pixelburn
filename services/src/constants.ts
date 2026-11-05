// Protocol constants mirrored from SPEC.md. When @mpb/sdk exports these, re-export
// from there instead (see NOTES.md "Requests").

/** Ticker. Rename here only. */
export const TOKEN_TICKER = "PXL";
export const PROJECT_NAME = "Pixel Frame";

export const GRID = 100; // blocks per side
export const BLOCK_PX = 10; // pixels per block side
export const CANVAS_PX = GRID * BLOCK_PX; // 1000
export const TOTAL_BLOCKS = GRID * GRID; // 10_000
export const BITMAP_BYTES = TOTAL_BLOCKS / 8; // 1250

export const PRICE_PER_BLOCK_USD_MICRO = 100_000_000n; // $100 per block, 6 decimals
export const USD_MICRO = 1_000_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const TREASURY_BPS = 5000n;
export const TOKEN_DISCOUNT_BPS = 1000n;
export const BPS_DENOM = 10_000n;
/** Fixed-point scale for token_price_in_SOL (SOL per token base unit). */
export const PRICE_SCALE = 10n ** 18n;
export const AUCTION_THRESHOLD_BLOCKS = 9_900;

export const MAX_TITLE = 64;
export const MAX_LINK = 200;
export const MAX_IMAGE_URI = 200;

/** Pyth SOL/USD price feed id (same id on mainnet and devnet Hermes). */
export const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const QUOTE_TTL_SECS = 60;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
