/**
 * Pure quote math, bigint only. These mirror programs/pixel/src/math.rs exactly so the SDK can predict
 * the on-chain charge to the base unit (see test/quote.test.ts for cross-checked vectors).
 */
import {
  AUCTION_MIN_INCREMENT_BPS,
  AUCTION_MIN_INCREMENT_LAMPORTS,
  AUCTION_MIN_OPENING_BID_LAMPORTS,
  BPS_DENOMINATOR,
  EMA_ALPHA_BPS,
  EMA_MIN_INTERVAL_SECS,
  SLOW_EMA_WINDOW_SECS,
  EMA_MAX_DEVIATION_BPS,
  EMA_SPOT_CLAMP_BPS,
  EMA_WARMUP_CRANKS,
  EMA_WARMUP_SECS,
  MAX_EMA_AGE_SECS,
  PRICE_PER_BLOCK_USD_MICRO,
  PRICE_SCALE,
  TOKEN_DISCOUNT_BPS,
  TREASURY_BPS,
} from "./params.js";
import { assertValidRect } from "./geometry.js";
import { assertU64, ceilDiv } from "./util.js";

/** A fixed-point price: value = price * 10^expo (Pyth convention). */
export interface FixedPrice {
  price: bigint;
  expo: number;
}

/** USD (micro) for w x h blocks at $100/block. */
export function quoteUsd(w: number, h: number): bigint {
  assertValidRect({ x: 0, y: 0, w, h });
  return BigInt(w * h) * PRICE_PER_BLOCK_USD_MICRO;
}

/** USD after the 10% token discount, rounded up (on-chain behaviour). */
export function applyTokenDiscount(usdMicro: bigint): bigint {
  return ceilDiv(usdMicro * (BPS_DENOMINATOR - TOKEN_DISCOUNT_BPS), BPS_DENOMINATOR);
}

/** lamports = ceil(usdMicro * 10^(3-expo) / price) where SOL/USD = price * 10^expo. */
export function quoteLamports(usdMicro: bigint, solUsd: FixedPrice): bigint {
  if (solUsd.price <= 0n) throw new RangeError("SOL price must be positive");
  if (!Number.isInteger(solUsd.expo) || solUsd.expo < -18 || solUsd.expo > 6) throw new RangeError("unsupported expo");
  const shift = 3 - solUsd.expo;
  const l =
    shift >= 0
      ? ceilDiv(usdMicro * 10n ** BigInt(shift), solUsd.price)
      : ceilDiv(usdMicro, solUsd.price * 10n ** BigInt(-shift));
  if (l === 0n) throw new RangeError("quote rounds to zero");
  return assertU64(l, "lamports");
}

/** 50/50 split; the remainder (odd lamport) goes to the buyback vault. */
export function splitSol(lamports: bigint): { treasury: bigint; buyback: bigint } {
  const treasury = (lamports * TREASURY_BPS) / BPS_DENOMINATOR;
  return { treasury, buyback: lamports - treasury };
}

/** lamports per token base unit * 1e18 from reserves (floored). */
export function spotPriceQ(quoteLamportsReserve: bigint, baseUnitsReserve: bigint): bigint {
  if (quoteLamportsReserve <= 0n || baseUnitsReserve <= 0n) throw new RangeError("empty reserves");
  const p = (quoteLamportsReserve * PRICE_SCALE) / baseUnitsReserve;
  if (p === 0n) throw new RangeError("empty reserves");
  return p;
}

/** |a-b| <= b*bps/10_000 (same rule as the program). */
export function withinBand(a: bigint, b: bigint, bps: bigint): boolean {
  const diff = a > b ? a - b : b - a;
  return diff <= (b * bps) / BPS_DENOMINATOR;
}

/**
 * One crank step, mirroring the program: the EMA must already be seeded (>0); spot is clamped to EMA*(1±40%) and the
 * EMA moves a FIXED 5% of the way (no time term), i.e. at most ±2% per crank.
 */
export function emaUpdate(ema: bigint, spot: bigint): bigint {
  return emaStep(ema, spot, EMA_ALPHA_BPS, BPS_DENOMINATOR);
}

/** Slow (4 h) EMA step: alpha = 30/14_400, same clamp. */
export function slowEmaUpdate(ema: bigint, spot: bigint): bigint {
  return emaStep(ema, spot, BigInt(EMA_MIN_INTERVAL_SECS), BigInt(SLOW_EMA_WINDOW_SECS));
}

function emaStep(ema: bigint, spot: bigint, num: bigint, den: bigint): bigint {
  if (ema <= 0n) throw new RangeError("EMA not seeded");
  const band = (ema * EMA_SPOT_CLAMP_BPS) / BPS_DENOMINATOR;
  const s = spot < ema - band ? ema - band : spot > ema + band ? ema + band : spot;
  return s >= ema ? ema + ((s - ema) * num) / den : ema - ((ema - s) * num) / den;
}

/** Token-paid blocks available right now (bucket refills at cap/hour). */
export function tokenBlocksAvailable(
  c: { tokenBlocksCapPerHour: number; tokenBlocksAllowance: number; tokenBlocksAllowanceUpdatedAt: number },
  nowSecs: number,
): number {
  const elapsed = Math.max(0, nowSecs - c.tokenBlocksAllowanceUpdatedAt);
  const refill = Math.floor((c.tokenBlocksCapPerHour * elapsed) / 3_600);
  return Math.min(c.tokenBlocksCapPerHour, c.tokenBlocksAllowance + refill);
}

export type TokenPricingStatus =
  | {
      ok: true;
      /** price the program will charge at: min(spot, fast EMA, slow EMA) */
      priceQ: bigint;
      emaQ: bigint;
      slowEmaQ: bigint;
      /** which input sets the price */
      pricedBy: "spot" | "ema" | "slowEma";
      /** token-paid blocks still available this hour (when the config carries the bucket fields) */
      blocksAvailable?: number;
    }
  | { ok: false; reason: "notSeeded" | "warmingUp" | "stale" | "deviation" | "capExhausted"; detail: string };

/**
 * Whether `buy_with_token` would accept the current state (pre-flight for UIs; the program is authoritative).
 * Pass `blocks` (w*h) to also check the hourly token-paid block cap.
 */
export function tokenPricingStatus(
  c: {
    tokenEmaPriceSol: bigint;
    tokenSlowEmaPriceSol?: bigint;
    emaUpdatedAt: number;
    emaWarmupCranks: number;
    emaWarmupStartedAt: number;
    tokenBlocksCapPerHour?: number;
    tokenBlocksAllowance?: number;
    tokenBlocksAllowanceUpdatedAt?: number;
  },
  spotQ: bigint,
  nowSecs: number,
  blocks?: number,
): TokenPricingStatus {
  if (c.tokenEmaPriceSol === 0n) return { ok: false, reason: "notSeeded", detail: "admin has not seeded the token EMA" };
  if (c.emaWarmupCranks < EMA_WARMUP_CRANKS || nowSecs - c.emaWarmupStartedAt < EMA_WARMUP_SECS)
    return { ok: false, reason: "warmingUp", detail: `EMA warm-up ${c.emaWarmupCranks}/${EMA_WARMUP_CRANKS} cranks` };
  if (nowSecs - c.emaUpdatedAt > MAX_EMA_AGE_SECS) return { ok: false, reason: "stale", detail: "EMA older than 15 min; crank first" };
  // one-sided: only spot ABOVE fast EMA * 1.15 is rejected (spot below is safe: min() charges more tokens)
  if (spotQ > c.tokenEmaPriceSol + (c.tokenEmaPriceSol * EMA_MAX_DEVIATION_BPS) / BPS_DENOMINATOR)
    return { ok: false, reason: "deviation", detail: "token price spiking; token payments paused until it settles" };
  let blocksAvailable: number | undefined;
  if (c.tokenBlocksCapPerHour !== undefined && c.tokenBlocksAllowance !== undefined && c.tokenBlocksAllowanceUpdatedAt !== undefined) {
    blocksAvailable = tokenBlocksAvailable(
      { tokenBlocksCapPerHour: c.tokenBlocksCapPerHour, tokenBlocksAllowance: c.tokenBlocksAllowance, tokenBlocksAllowanceUpdatedAt: c.tokenBlocksAllowanceUpdatedAt },
      nowSecs,
    );
    if (blocks !== undefined && blocks > blocksAvailable)
      return { ok: false, reason: "capExhausted", detail: `only ${blocksAvailable} token-paid blocks left this hour` };
  }
  const emaQ = c.tokenEmaPriceSol;
  const slowEmaQ = c.tokenSlowEmaPriceSol ?? emaQ;
  const priceQ = buyPriceQ(spotQ, emaQ, slowEmaQ);
  const pricedBy = priceQ === spotQ ? "spot" : priceQ === emaQ ? "ema" : "slowEma";
  return { ok: true, priceQ, emaQ, slowEmaQ, pricedBy, blocksAvailable };
}

/** Price used to charge token buyers: min(spot, fast EMA[, slow EMA]). */
export function buyPriceQ(spot: bigint, ema: bigint, slowEma?: bigint): bigint {
  if (ema <= 0n || (slowEma !== undefined && slowEma <= 0n)) throw new RangeError("EMA unavailable");
  let m = spot < ema ? spot : ema;
  if (slowEma !== undefined && slowEma < m) m = slowEma;
  return m;
}

/** tokens = ceil(lamports * 1e18 / priceQ). */
export function lamportsToTokens(lamports: bigint, priceQ: bigint): bigint {
  if (priceQ <= 0n) throw new RangeError("price unavailable");
  return assertU64(ceilDiv(lamports * PRICE_SCALE, priceQ), "tokens");
}

/**
 * Exact on-chain token charge for an undiscounted USD amount:
 * discount -> lamports at SOL/USD -> tokens at min(spot, ema).
 */
export function quoteTokensExact(usdMicro: bigint, solUsd: FixedPrice, spotQ: bigint, emaQ: bigint, slowEmaQ?: bigint): bigint {
  const lamports = quoteLamports(applyTokenDiscount(usdMicro), solUsd);
  return lamportsToTokens(lamports, buyPriceQ(spotQ, emaQ, slowEmaQ));
}

/** USD per WHOLE token as a FixedPrice, from an on-chain priceQ and SOL/USD. */
export function tokenUsdFromPriceQ(priceQ: bigint, solUsd: FixedPrice, decimals: number): FixedPrice {
  // usd/whole = priceQ/1e18 [lamports/base] * 10^dec [base/whole] / 1e9 [SOL/lamport] * solUsd
  return { price: priceQ * 10n ** BigInt(decimals) * solUsd.price, expo: solUsd.expo - 27 };
}

/**
 * Tokens (base units) owed for `usdMicro` (undiscounted) given a token USD price; applies the 10% discount.
 * Rounded up. Good for display; use `quoteTokensExact` to predict the on-chain amount to the base unit.
 */
export function quoteTokens(usdMicro: bigint, tokenUsd: FixedPrice, decimals: number): bigint {
  if (tokenUsd.price <= 0n) throw new RangeError("token price must be positive");
  const disc = applyTokenDiscount(usdMicro);
  // tokens = disc/1e6 / (p*10^e) * 10^dec = disc * 10^dec / (p * 10^(e+6))
  const k = tokenUsd.expo + 6;
  const num = disc * 10n ** BigInt(decimals);
  const t = k >= 0 ? ceilDiv(num, tokenUsd.price * 10n ** BigInt(k)) : ceilDiv(num * 10n ** BigInt(-k), tokenUsd.price);
  return t;
}

/** amount * (1 + bps/10_000), rounded up: use for max_lamports / max_tokens slippage guards. */
export function withSlippage(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError("bps must be a non-negative integer");
  return ceilDiv(amount * (BPS_DENOMINATOR + BigInt(bps)), BPS_DENOMINATOR);
}

/**
 * Minimum acceptable next bid in the final auction. Accepts the highest bid or an auction state
 * (`{ highestBid }`, e.g. a decoded `AuctionAccount`).
 */
export function minNextBid(auction: bigint | { highestBid: bigint }): bigint {
  const highestBid = typeof auction === "bigint" ? auction : auction.highestBid;
  if (highestBid === 0n) return AUCTION_MIN_OPENING_BID_LAMPORTS;
  const pct = (highestBid * AUCTION_MIN_INCREMENT_BPS) / BPS_DENOMINATOR;
  return highestBid + (pct > AUCTION_MIN_INCREMENT_LAMPORTS ? pct : AUCTION_MIN_INCREMENT_LAMPORTS);
}

/**
 * ESTIMATE ONLY: tokens a SOL purchase will eventually burn through the buyback. The buyback half of the payment
 * (`splitSol(lamports).buyback`) converted at `tokenPriceQ` (lamports per base unit * 1e18, e.g. the on-chain EMA).
 * The real amount depends on the keeper's later execution price, fees and slippage (up to the configured tolerance).
 */
export function estimateBurnForSolPurchase(
  usdMicro: bigint,
  tokenPriceQ: bigint,
  solUsd: FixedPrice,
): { lamports: bigint; buybackLamports: bigint; estimatedTokens: bigint; isEstimate: true } {
  const lamports = quoteLamports(usdMicro, solUsd);
  const { buyback } = splitSol(lamports);
  if (tokenPriceQ <= 0n) throw new RangeError("token price unavailable");
  return { lamports, buybackLamports: buyback, estimatedTokens: (buyback * PRICE_SCALE) / tokenPriceQ, isEstimate: true };
}

/** Float conversion for DISPLAY ONLY. */
export function fixedToNumber(p: FixedPrice): number {
  return Number(p.price) * 10 ** p.expo;
}
