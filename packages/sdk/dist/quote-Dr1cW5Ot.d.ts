/** Rectangle in block units (1 block = 10x10 px). */
interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
/** Block index = by * 100 + bx. Bitmap bit for index i: byte i>>3, bit i&7 (LSB first) — same as on-chain. */
declare function blockIndex(bx: number, by: number): number;
declare function blockCoords(index: number): {
    bx: number;
    by: number;
};
/** Same rule as the program: integers, w,h >= 1, x+w <= 100, y+h <= 100. */
declare function isValidRect(r: Rect): boolean;
declare function assertValidRect(r: Rect): void;
/** All block indices covered by the rect, row-major. Throws on an invalid rect. */
declare function rectBlocks(r: Rect): number[];
declare function rectBlockCount(r: Rect): number;
declare function isBlockSet(bitmap: Uint8Array, index: number): boolean;
/** True if the rect is valid and none of its blocks are sold. Invalid rects return false. */
declare function isRectFree(bitmap: Uint8Array, r: Rect): boolean;
/** Returns a copy of the bitmap with the rect's blocks set. */
declare function markRect(bitmap: Uint8Array, r: Rect): Uint8Array;
declare function countSet(bitmap: Uint8Array): number;
declare function freeBlocks(bitmap: Uint8Array): number[];
declare function emptyBitmap(): Uint8Array;
/** Mirrors the on-chain content validation (byte lengths, schemes, no control/whitespace in URLs). */
declare function validateAdContent(c: {
    title: string;
    link: string;
    imageUri: string;
}): string | null;

/** A fixed-point price: value = price * 10^expo (Pyth convention). */
interface FixedPrice {
    price: bigint;
    expo: number;
}
/** USD (micro) for w x h blocks at $100/block. */
declare function quoteUsd(w: number, h: number): bigint;
/** USD after the 10% token discount, rounded up (on-chain behaviour). */
declare function applyTokenDiscount(usdMicro: bigint): bigint;
/** lamports = ceil(usdMicro * 10^(3-expo) / price) where SOL/USD = price * 10^expo. */
declare function quoteLamports(usdMicro: bigint, solUsd: FixedPrice): bigint;
/** 50/50 split; the remainder (odd lamport) goes to the buyback vault. */
declare function splitSol(lamports: bigint): {
    treasury: bigint;
    buyback: bigint;
};
/** lamports per token base unit * 1e18 from reserves (floored). */
declare function spotPriceQ(quoteLamportsReserve: bigint, baseUnitsReserve: bigint): bigint;
/** |a-b| <= b*bps/10_000 (same rule as the program). */
declare function withinBand(a: bigint, b: bigint, bps: bigint): boolean;
/**
 * One crank step, mirroring the program: the EMA must already be seeded (>0); spot is clamped to EMA*(1±40%) and the
 * EMA moves a FIXED 5% of the way (no time term), i.e. at most ±2% per crank.
 */
declare function emaUpdate(ema: bigint, spot: bigint): bigint;
/** Slow (4 h) EMA step: alpha = 30/14_400, same clamp. */
declare function slowEmaUpdate(ema: bigint, spot: bigint): bigint;
/** Token-paid blocks available right now (bucket refills at cap/hour). */
declare function tokenBlocksAvailable(c: {
    tokenBlocksCapPerHour: number;
    tokenBlocksAllowance: number;
    tokenBlocksAllowanceUpdatedAt: number;
}, nowSecs: number): number;
type TokenPricingStatus = {
    ok: true;
    /** price the program will charge at: min(spot, fast EMA, slow EMA) */
    priceQ: bigint;
    emaQ: bigint;
    slowEmaQ: bigint;
    /** which input sets the price */
    pricedBy: "spot" | "ema" | "slowEma";
    /** token-paid blocks still available this hour (when the config carries the bucket fields) */
    blocksAvailable?: number;
} | {
    ok: false;
    reason: "notSeeded" | "warmingUp" | "stale" | "deviation" | "capExhausted";
    detail: string;
};
/**
 * Whether `buy_with_token` would accept the current state (pre-flight for UIs; the program is authoritative).
 * Pass `blocks` (w*h) to also check the hourly token-paid block cap.
 */
declare function tokenPricingStatus(c: {
    tokenEmaPriceSol: bigint;
    tokenSlowEmaPriceSol?: bigint;
    emaUpdatedAt: number;
    emaWarmupCranks: number;
    emaWarmupStartedAt: number;
    tokenBlocksCapPerHour?: number;
    tokenBlocksAllowance?: number;
    tokenBlocksAllowanceUpdatedAt?: number;
}, spotQ: bigint, nowSecs: number, blocks?: number): TokenPricingStatus;
/** Price used to charge token buyers: min(spot, fast EMA[, slow EMA]). */
declare function buyPriceQ(spot: bigint, ema: bigint, slowEma?: bigint): bigint;
/** tokens = ceil(lamports * 1e18 / priceQ). */
declare function lamportsToTokens(lamports: bigint, priceQ: bigint): bigint;
/**
 * Exact on-chain token charge for an undiscounted USD amount:
 * discount -> lamports at SOL/USD -> tokens at min(spot, ema).
 */
declare function quoteTokensExact(usdMicro: bigint, solUsd: FixedPrice, spotQ: bigint, emaQ: bigint, slowEmaQ?: bigint): bigint;
/** USD per WHOLE token as a FixedPrice, from an on-chain priceQ and SOL/USD. */
declare function tokenUsdFromPriceQ(priceQ: bigint, solUsd: FixedPrice, decimals: number): FixedPrice;
/**
 * Tokens (base units) owed for `usdMicro` (undiscounted) given a token USD price; applies the 10% discount.
 * Rounded up. Good for display; use `quoteTokensExact` to predict the on-chain amount to the base unit.
 */
declare function quoteTokens(usdMicro: bigint, tokenUsd: FixedPrice, decimals: number): bigint;
/** amount * (1 + bps/10_000), rounded up: use for max_lamports / max_tokens slippage guards. */
declare function withSlippage(amount: bigint, bps: number): bigint;
/**
 * Minimum acceptable next bid in the final auction. Accepts the highest bid or an auction state
 * (`{ highestBid }`, e.g. a decoded `AuctionAccount`).
 */
declare function minNextBid(auction: bigint | {
    highestBid: bigint;
}): bigint;
/**
 * ESTIMATE ONLY: tokens a SOL purchase will eventually burn through the buyback. The buyback half of the payment
 * (`splitSol(lamports).buyback`) converted at `tokenPriceQ` (lamports per base unit * 1e18, e.g. the on-chain EMA).
 * The real amount depends on the keeper's later execution price, fees and slippage (up to the configured tolerance).
 */
declare function estimateBurnForSolPurchase(usdMicro: bigint, tokenPriceQ: bigint, solUsd: FixedPrice): {
    lamports: bigint;
    buybackLamports: bigint;
    estimatedTokens: bigint;
    isEstimate: true;
};
/** Float conversion for DISPLAY ONLY. */
declare function fixedToNumber(p: FixedPrice): number;

export { tokenBlocksAvailable as A, tokenPricingStatus as B, tokenUsdFromPriceQ as C, validateAdContent as D, withSlippage as E, type FixedPrice as F, withinBand as G, type Rect as R, type TokenPricingStatus as T, applyTokenDiscount as a, assertValidRect as b, blockCoords as c, blockIndex as d, buyPriceQ as e, countSet as f, emaUpdate as g, emptyBitmap as h, estimateBurnForSolPurchase as i, fixedToNumber as j, freeBlocks as k, isBlockSet as l, isRectFree as m, isValidRect as n, lamportsToTokens as o, markRect as p, minNextBid as q, quoteLamports as r, quoteTokens as s, quoteTokensExact as t, quoteUsd as u, rectBlockCount as v, rectBlocks as w, slowEmaUpdate as x, splitSol as y, spotPriceQ as z };
