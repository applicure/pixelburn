use anchor_lang::prelude::*;

/// Ticker placeholder. The only place in the program that names the token.
#[constant]
pub const TOKEN_SYMBOL: &str = "PIXEL";

// ---------------------------------------------------------------- PDA seeds
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const CANVAS_SEED: &[u8] = b"canvas";
#[constant]
pub const BUYBACK_VAULT_SEED: &[u8] = b"buyback_vault";
/// Rect ads: ["ad", top-left block index u16 LE]. Blocks are exclusive, so the address is unique per ad and
/// independent of global state (no collisions between concurrent buyers of disjoint rects).
#[constant]
pub const AD_SEED: &[u8] = b"ad";
/// The single final-auction ad: ["ad_auction"].
#[constant]
pub const AD_AUCTION_SEED: &[u8] = b"ad_auction";
#[constant]
pub const AUCTION_SEED: &[u8] = b"auction";

// ---------------------------------------------------------------- canvas
/// Blocks per side (1000 px / 10 px).
#[constant]
pub const GRID: u16 = 100;
#[constant]
pub const TOTAL_BLOCKS: u16 = 10_000;
/// 10_000 bits. Block index i lives in byte i/8, bit (i%8), LSB first.
pub const BITMAP_BYTES: usize = 1250;

// ---------------------------------------------------------------- pricing
/// $100 per 10x10 block, micro-USD (6 decimals).
#[constant]
pub const PRICE_PER_BLOCK_USD_MICRO: u64 = 100_000_000;
#[constant]
pub const BPS_DENOMINATOR: u64 = 10_000;
/// Share of SOL payments sent to the treasury. The remainder (incl. rounding dust) goes to the buyback vault.
#[constant]
pub const TREASURY_BPS: u64 = 5_000;
/// Discount for paying in the token.
#[constant]
pub const TOKEN_DISCOUNT_BPS: u64 = 1_000;
/// Fixed-point scale for token prices: lamports per token base unit * 1e18.
pub const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;

// ---------------------------------------------------------------- oracle
#[constant]
pub const DEFAULT_MAX_PRICE_AGE_SECS: u64 = 120;
/// Upper bound the admin can configure for the Pyth staleness window.
#[constant]
pub const MAX_PRICE_AGE_LIMIT_SECS: u64 = 300;
/// Reject Pyth prices whose confidence interval exceeds 2% of the price.
#[constant]
pub const MAX_CONF_BPS: u64 = 200;

// ---------------------------------------------------------------- token EMA
#[constant]
pub const EMA_MIN_INTERVAL_SECS: i64 = 30;
/// Nominal EMA time constant. Each crank uses the FIXED alpha EMA_MIN_INTERVAL_SECS / EMA_WINDOW_SECS (5%),
/// regardless of how long ago the previous crank was (a long gap never lets one crank jump to spot).
#[constant]
pub const EMA_WINDOW_SECS: i64 = 600;
/// Fixed per-crank alpha = 30/600 = 5%.
#[constant]
pub const EMA_ALPHA_BPS: u64 = 500;
/// Spot input is clamped to EMA * (1 +/- 40%) before the alpha step, so one crank moves the EMA by at most
/// 5% * 40% = 2% (MAX_EMA_STEP_BPS), and cranks are >= 30 s apart: <= 2% per 30 s.
#[constant]
pub const EMA_SPOT_CLAMP_BPS: u64 = 4_000;
#[constant]
pub const MAX_EMA_STEP_BPS: u64 = 200;
/// Token buys are rejected while spot > fast EMA * (1 + 15%) (one-sided; spot below the EMA is allowed).
#[constant]
pub const EMA_MAX_DEVIATION_BPS: u64 = 1_500;
/// The admin-supplied EMA seed must be within 25% of spot at the first crank after seeding.
#[constant]
pub const EMA_SEED_BAND_BPS: u64 = 2_500;
/// Warm-up after seeding: token buys / keeper reconciliation need >= 10 cranks spanning >= 600 s.
#[constant]
pub const EMA_WARMUP_CRANKS: u16 = 10;
#[constant]
pub const EMA_WARMUP_SECS: i64 = 600;
/// Slow EMA (audit round 2, ratchet fix): 4-hour window, alpha = 30 s / 14_400 s = 1/480 per crank, same ±40% clamp,
/// so it moves at most 0.0833% per crank (~ +10.5% per hour of a held +40% pump). Token price = min(spot, fast, slow).
#[constant]
pub const SLOW_EMA_WINDOW_SECS: i64 = 14_400;
/// Hard ceiling and default for the token-payment rate limit (blocks per hour, token bucket).
#[constant]
pub const DEFAULT_TOKEN_BLOCKS_CAP_PER_HOUR: u16 = 1_000;
#[constant]
pub const MAX_TOKEN_BLOCKS_CAP_PER_HOUR: u16 = 5_000;
/// `buy_with_token` refuses to price against an EMA older than this.
#[constant]
pub const MAX_EMA_AGE_SECS: i64 = 900;

// ---------------------------------------------------------------- final auction
#[constant]
pub const AUCTION_THRESHOLD_BLOCKS: u16 = 9_900;
#[constant]
pub const AUCTION_DURATION_SECS: i64 = 72 * 60 * 60;
/// A bid inside the last 10 minutes pushes the end to now + 10 minutes (anti-sniping).
#[constant]
pub const AUCTION_EXTENSION_SECS: i64 = 10 * 60;
#[constant]
pub const AUCTION_MIN_OPENING_BID_LAMPORTS: u64 = 100_000_000;
#[constant]
pub const AUCTION_MIN_INCREMENT_BPS: u64 = 500;
#[constant]
pub const AUCTION_MIN_INCREMENT_LAMPORTS: u64 = 10_000_000;

// ---------------------------------------------------------------- buyback (keeper fallback)
#[constant]
pub const BUYBACK_WINDOW_SECS: i64 = 3_600;
pub const DEFAULT_BUYBACK_CAP_LAMPORTS_PER_HOUR: u64 = 10_000_000_000;
/// Hard ceiling on the admin-settable hourly release cap (bounds admin+keeper collusion).
pub const MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR: u64 = 50_000_000_000;
#[constant]
pub const DEFAULT_BUYBACK_MAX_SLIPPAGE_BPS: u16 = 1_500;
#[constant]
pub const MAX_BUYBACK_SLIPPAGE_BPS_LIMIT: u16 = 5_000;

// ---------------------------------------------------------------- ad content
pub const MAX_TITLE_LEN: usize = 64;
pub const MAX_LINK_LEN: usize = 200;
pub const MAX_IMAGE_URI_LEN: usize = 200;

// ---------------------------------------------------------------- external programs / layouts
/// pump.fun bonding curve program.
pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/// PumpSwap AMM program.
pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/// Associated Token Account program.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// Wrapped SOL mint.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// sha256("account:BondingCurve")[..8] (from pump IDL).
pub const PUMP_BONDING_CURVE_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
/// sha256("account:Pool")[..8] (from pump_amm IDL).
pub const PUMP_AMM_POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
