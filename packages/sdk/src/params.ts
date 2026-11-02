/** Pure constants: no @solana/web3.js, no IDL. Safe for the side-effect-free `@mpb/sdk/quote` entry. */
/** Ticker placeholder. Rename here only. */
export const TOKEN_SYMBOL = "PIXEL";
export const PROJECT_NAME = "The Million Pixel Burn";


// ---------------------------------------------------------------- seeds
export const CONFIG_SEED = "config";
export const CANVAS_SEED = "canvas";
export const BUYBACK_VAULT_SEED = "buyback_vault";
export const AD_SEED = "ad";
export const AD_AUCTION_SEED = "ad_auction";
export const AUCTION_SEED = "auction";

// ---------------------------------------------------------------- canvas
export const CANVAS_PX = 1000;
export const BLOCK_PX = 10;
export const GRID = 100;
export const TOTAL_BLOCKS = 10_000;
export const BITMAP_BYTES = 1250;

// ---------------------------------------------------------------- pricing (bigint for money)
export const PRICE_PER_BLOCK_USD_MICRO = 100_000_000n;
export const USD_MICRO = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const TREASURY_BPS = 5_000n;
export const TOKEN_DISCOUNT_BPS = 1_000n;
/** Token prices on-chain: lamports per token base unit * 1e18. */
export const PRICE_SCALE = 1_000_000_000_000_000_000n;
export const LAMPORTS_PER_SOL_BI = 1_000_000_000n;

// ---------------------------------------------------------------- oracle
/** Recommended/deployed default (SPEC said 60; raised because Pyth's sponsored feed updates ~every 60 s). */
export const DEFAULT_MAX_PRICE_AGE_SECS = 120;
export const MAX_CONF_BPS = 200n;
/** Pyth SOL/USD feed id (hex, no 0x). */
export const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const DEFAULT_HERMES_URL = "https://hermes.pyth.network";

// ---------------------------------------------------------------- token EMA
export const EMA_MIN_INTERVAL_SECS = 30;
export const EMA_WINDOW_SECS = 600;
/** Fixed per-crank alpha (30/600). */
export const EMA_ALPHA_BPS = 500n;
/** Spot is clamped to EMA*(1±40%) before each step => EMA moves <= 2% per crank. */
export const EMA_SPOT_CLAMP_BPS = 4_000n;
export const MAX_EMA_STEP_BPS = 200n;
/** Token buys are rejected while spot > fast EMA * 1.15 (one-sided). */
export const EMA_MAX_DEVIATION_BPS = 1_500n;
/** First crank after the admin seeds the EMA must see spot within 25% of the seed. */
export const EMA_SEED_BAND_BPS = 2_500n;
/** Warm-up after (re)seeding: >= 10 cranks spanning >= 600 s before token pricing is live. */
export const EMA_WARMUP_CRANKS = 10;
export const EMA_WARMUP_SECS = 600;
/** Slow EMA: 4 h window, alpha = 30/14_400 per crank, same ±40% clamp. Token price = min(spot, fast, slow). */
export const SLOW_EMA_WINDOW_SECS = 14_400;
/** Token-paid blocks per hour (token bucket). Default and hard maximum. */
export const DEFAULT_TOKEN_BLOCKS_CAP_PER_HOUR = 1_000;
export const MAX_TOKEN_BLOCKS_CAP_PER_HOUR = 5_000;
export const MAX_EMA_AGE_SECS = 900;

// ---------------------------------------------------------------- final auction
export const AUCTION_THRESHOLD_BLOCKS = 9_900;
export const AUCTION_DURATION_SECS = 72 * 60 * 60;
export const AUCTION_EXTENSION_SECS = 10 * 60;
export const AUCTION_MIN_OPENING_BID_LAMPORTS = 100_000_000n;
export const AUCTION_MIN_INCREMENT_BPS = 500n;
export const AUCTION_MIN_INCREMENT_LAMPORTS = 10_000_000n;

// ---------------------------------------------------------------- buyback
export const BUYBACK_WINDOW_SECS = 3_600;
export const MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR = 50_000_000_000n;
/** record_buyback_burn backstop: post-trade spot must be <= fast EMA * (1 + 12%). */
export const BUYBACK_MAX_POST_SPOT_BPS = 1_200n;

// ---------------------------------------------------------------- ad content
export const MAX_TITLE_LEN = 64;
export const MAX_LINK_LEN = 200;
export const MAX_IMAGE_URI_LEN = 200;

// ---------------------------------------------------------------- external programs
