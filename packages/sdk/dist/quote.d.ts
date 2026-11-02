export { F as FixedPrice, R as Rect, T as TokenPricingStatus, a as applyTokenDiscount, b as assertValidRect, c as blockCoords, d as blockIndex, e as buyPriceQ, f as countSet, g as emaUpdate, h as emptyBitmap, i as estimateBurnForSolPurchase, j as fixedToNumber, k as freeBlocks, l as isBlockSet, m as isRectFree, n as isValidRect, o as lamportsToTokens, p as markRect, q as minNextBid, r as quoteLamports, s as quoteTokens, t as quoteTokensExact, u as quoteUsd, v as rectBlockCount, w as rectBlocks, x as slowEmaUpdate, y as splitSol, z as spotPriceQ, A as tokenBlocksAvailable, B as tokenPricingStatus, C as tokenUsdFromPriceQ, D as validateAdContent, E as withSlippage, G as withinBand } from './quote-Dr1cW5Ot.js';

/** Pure constants: no @solana/web3.js, no IDL. Safe for the side-effect-free `@mpb/sdk/quote` entry. */
/** Ticker placeholder. Rename here only. */
declare const TOKEN_SYMBOL = "PIXEL";
declare const PROJECT_NAME = "The Million Pixel Burn";
declare const CONFIG_SEED = "config";
declare const CANVAS_SEED = "canvas";
declare const BUYBACK_VAULT_SEED = "buyback_vault";
declare const AD_SEED = "ad";
declare const AD_AUCTION_SEED = "ad_auction";
declare const AUCTION_SEED = "auction";
declare const CANVAS_PX = 1000;
declare const BLOCK_PX = 10;
declare const GRID = 100;
declare const TOTAL_BLOCKS = 10000;
declare const BITMAP_BYTES = 1250;
declare const PRICE_PER_BLOCK_USD_MICRO = 100000000n;
declare const USD_MICRO = 1000000n;
declare const BPS_DENOMINATOR = 10000n;
declare const TREASURY_BPS = 5000n;
declare const TOKEN_DISCOUNT_BPS = 1000n;
/** Token prices on-chain: lamports per token base unit * 1e18. */
declare const PRICE_SCALE = 1000000000000000000n;
declare const LAMPORTS_PER_SOL_BI = 1000000000n;
/** Recommended/deployed default (SPEC said 60; raised because Pyth's sponsored feed updates ~every 60 s). */
declare const DEFAULT_MAX_PRICE_AGE_SECS = 120;
declare const MAX_CONF_BPS = 200n;
/** Pyth SOL/USD feed id (hex, no 0x). */
declare const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
declare const DEFAULT_HERMES_URL = "https://hermes.pyth.network";
declare const EMA_MIN_INTERVAL_SECS = 30;
declare const EMA_WINDOW_SECS = 600;
/** Fixed per-crank alpha (30/600). */
declare const EMA_ALPHA_BPS = 500n;
/** Spot is clamped to EMA*(1±40%) before each step => EMA moves <= 2% per crank. */
declare const EMA_SPOT_CLAMP_BPS = 4000n;
declare const MAX_EMA_STEP_BPS = 200n;
/** Token buys are rejected while spot > fast EMA * 1.15 (one-sided). */
declare const EMA_MAX_DEVIATION_BPS = 1500n;
/** First crank after the admin seeds the EMA must see spot within 25% of the seed. */
declare const EMA_SEED_BAND_BPS = 2500n;
/** Warm-up after (re)seeding: >= 10 cranks spanning >= 600 s before token pricing is live. */
declare const EMA_WARMUP_CRANKS = 10;
declare const EMA_WARMUP_SECS = 600;
/** Slow EMA: 4 h window, alpha = 30/14_400 per crank, same ±40% clamp. Token price = min(spot, fast, slow). */
declare const SLOW_EMA_WINDOW_SECS = 14400;
/** Token-paid blocks per hour (token bucket). Default and hard maximum. */
declare const DEFAULT_TOKEN_BLOCKS_CAP_PER_HOUR = 1000;
declare const MAX_TOKEN_BLOCKS_CAP_PER_HOUR = 5000;
declare const MAX_EMA_AGE_SECS = 900;
declare const AUCTION_THRESHOLD_BLOCKS = 9900;
declare const AUCTION_DURATION_SECS: number;
declare const AUCTION_EXTENSION_SECS: number;
declare const AUCTION_MIN_OPENING_BID_LAMPORTS = 100000000n;
declare const AUCTION_MIN_INCREMENT_BPS = 500n;
declare const AUCTION_MIN_INCREMENT_LAMPORTS = 10000000n;
declare const BUYBACK_WINDOW_SECS = 3600;
declare const MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR = 50000000000n;
declare const MAX_TITLE_LEN = 64;
declare const MAX_LINK_LEN = 200;
declare const MAX_IMAGE_URI_LEN = 200;

declare function hexToBytes(hex: string): Uint8Array;
declare function bytesToHex(b: Uint8Array): string;
/** ceil(a / b) for non-negative bigints. */
declare function ceilDiv(a: bigint, b: bigint): bigint;
declare function base64ToBytes(s: string): Uint8Array;
declare function bytesToBase64(b: Uint8Array): string;

export { AD_AUCTION_SEED, AD_SEED, AUCTION_DURATION_SECS, AUCTION_EXTENSION_SECS, AUCTION_MIN_INCREMENT_BPS, AUCTION_MIN_INCREMENT_LAMPORTS, AUCTION_MIN_OPENING_BID_LAMPORTS, AUCTION_SEED, AUCTION_THRESHOLD_BLOCKS, BITMAP_BYTES, BLOCK_PX, BPS_DENOMINATOR, BUYBACK_VAULT_SEED, BUYBACK_WINDOW_SECS, CANVAS_PX, CANVAS_SEED, CONFIG_SEED, DEFAULT_HERMES_URL, DEFAULT_MAX_PRICE_AGE_SECS, DEFAULT_TOKEN_BLOCKS_CAP_PER_HOUR, EMA_ALPHA_BPS, EMA_MAX_DEVIATION_BPS, EMA_MIN_INTERVAL_SECS, EMA_SEED_BAND_BPS, EMA_SPOT_CLAMP_BPS, EMA_WARMUP_CRANKS, EMA_WARMUP_SECS, EMA_WINDOW_SECS, GRID, LAMPORTS_PER_SOL_BI, MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR, MAX_CONF_BPS, MAX_EMA_AGE_SECS, MAX_EMA_STEP_BPS, MAX_IMAGE_URI_LEN, MAX_LINK_LEN, MAX_TITLE_LEN, MAX_TOKEN_BLOCKS_CAP_PER_HOUR, PRICE_PER_BLOCK_USD_MICRO, PRICE_SCALE, PROJECT_NAME, SLOW_EMA_WINDOW_SECS, SOL_USD_FEED_ID, TOKEN_DISCOUNT_BPS, TOKEN_SYMBOL, TOTAL_BLOCKS, TREASURY_BPS, USD_MICRO, base64ToBytes, bytesToBase64, bytesToHex, ceilDiv, hexToBytes };
