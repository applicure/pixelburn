// Pure quote math, integer-only (bigint), mirroring chain/programs/pixel/src/math.rs
// rounding exactly so an off-chain quote equals what the program charges for the same
// inputs. Swap for @mpb/sdk's quote helpers once published (test/quote.test.ts pins
// the semantics, so the swap is a drop-in check).
//
// Token prices are "q": LAMPORTS per token base unit * 1e18 (chain PRICE_SCALE).
import {
  BPS_DENOM,
  LAMPORTS_PER_SOL,
  PRICE_PER_BLOCK_USD_MICRO,
  PRICE_SCALE,
  TOKEN_DISCOUNT_BPS,
  USD_MICRO,
} from "../constants.js";

const ceilDiv = (a: bigint, b: bigint) => {
  if (b <= 0n) throw new RangeError("division by zero");
  return a % b === 0n ? a / b : a / b + 1n;
};

export function quoteUsd(w: number, h: number): bigint {
  return BigInt(w) * BigInt(h) * PRICE_PER_BLOCK_USD_MICRO;
}

/** USD after the token discount, rounded up (chain apply_token_discount). */
export function applyTokenDiscount(usdMicro: bigint, discountBps: bigint = TOKEN_DISCOUNT_BPS): bigint {
  return ceilDiv(usdMicro * (BPS_DENOM - discountBps), BPS_DENOM);
}

/** Pyth SOL/USD = price * 10^expo. lamports = ceil(usd_micro * 10^(3 - expo) / price) (chain usd_to_lamports). */
export function usdToLamports(usdMicro: bigint, price: bigint, expo: number): bigint {
  if (price <= 0n) throw new RangeError("invalid oracle price");
  const shift = 3 - expo;
  return shift >= 0 ? ceilDiv(usdMicro * 10n ** BigInt(shift), price) : ceilDiv(usdMicro, price * 10n ** BigInt(-shift));
}

/** Convenience: SOL price given in micro-USD. */
export function quoteLamports(usdMicro: bigint, solUsdMicro: bigint): bigint {
  return usdToLamports(usdMicro, solUsdMicro, -6);
}

/** Manipulation-resistant token price: min(spot, ema) (chain buy_price_q). */
export function effectiveTokenPrice(spotQ: bigint, emaQ: bigint): bigint {
  if (emaQ <= 0n) throw new RangeError("EMA unavailable");
  return spotQ < emaQ ? spotQ : emaQ;
}

/** tokens = ceil(lamports * 1e18 / price_q) (chain lamports_to_tokens). */
export function lamportsToTokens(lamports: bigint, priceQ: bigint): bigint {
  if (priceQ <= 0n) throw new RangeError("EMA unavailable");
  return ceilDiv(lamports * PRICE_SCALE, priceQ);
}

/**
 * Tokens (base units) burned for a token-mode purchase, as buy_with_token computes it:
 * discounted USD -> lamports at Pyth SOL/USD -> tokens at min(spot, ema).
 */
export function quoteTokensForUsd(usdMicro: bigint, spotQ: bigint, emaQ: bigint, solPrice: bigint, solExpo: number): bigint {
  const lamportsEquiv = usdToLamports(applyTokenDiscount(usdMicro), solPrice, solExpo);
  return lamportsToTokens(lamportsEquiv, effectiveTokenPrice(spotQ, emaQ));
}

/** USD (float, display only) per whole token. */
export function tokenUsdPerToken(priceQ: bigint, solUsd: number, decimals: number): number {
  const lamportsPerToken = Number(priceQ * 10n ** BigInt(decimals)) / Number(PRICE_SCALE);
  return (lamportsPerToken / Number(LAMPORTS_PER_SOL)) * solUsd;
}

/** SOL per WHOLE token (float) -> q (lamports per base unit * 1e18). */
export function solPerTokenToQ(solPerToken: number, decimals: number): bigint {
  // solPerToken * 1e9 lamports/token * 1e18 / 10^decimals
  return (BigInt(Math.round(solPerToken * 1e18)) * LAMPORTS_PER_SOL) / 10n ** BigInt(decimals);
}

export const usdToMicro = (usd: number): bigint => BigInt(Math.round(usd * Number(USD_MICRO)));
export const microToUsd = (micro: bigint | string): number => Number(BigInt(micro)) / Number(USD_MICRO);
