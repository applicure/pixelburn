/**
 * Pure quote + occupancy math. Mirrors the @mpb/sdk exports named in SPEC
 * (blockIndex, rectBlocks, isRectFree, quoteUsd, quoteLamports, quoteTokens).
 * TODO(sdk): replace with re-exports from "@mpb/sdk" once packages/sdk exists.
 */
import {
  GRID,
  LAMPORTS_PER_SOL,
  PRICE_PER_BLOCK_USD_MICRO,
  TOKEN_DECIMALS,
  TOKEN_DISCOUNT_BPS,
} from "./config";
import type { Rect } from "./types";

export const blockIndex = (bx: number, by: number) => by * GRID + bx;

export function rectBlocks(r: Rect): number[] {
  const out: number[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(blockIndex(x, y));
  return out;
}

export const bitGet = (bitmap: Uint8Array, i: number) => (bitmap[i >> 3] >> (i & 7)) & 1;
export const bitSet = (bitmap: Uint8Array, i: number) => {
  bitmap[i >> 3] |= 1 << (i & 7);
};

export function rectInBounds(r: Rect) {
  return r.w >= 1 && r.h >= 1 && r.x >= 0 && r.y >= 0 && r.x + r.w <= GRID && r.y + r.h <= GRID;
}

export function isRectFree(bitmap: Uint8Array, r: Rect) {
  if (!rectInBounds(r)) return false;
  for (const i of rectBlocks(r)) if (bitGet(bitmap, i)) return false;
  return true;
}

/** micro-USD */
export const quoteUsd = (w: number, h: number) => BigInt(w * h) * PRICE_PER_BLOCK_USD_MICRO;

/** lamports = usd / SOL_USD, rounded up so the program never under-collects. */
export function quoteLamports(usdMicro: bigint, solUsd: number) {
  const solUsdMicro = BigInt(Math.round(solUsd * 1e6));
  const num = usdMicro * BigInt(LAMPORTS_PER_SOL);
  return (num + solUsdMicro - 1n) / solUsdMicro;
}

/** tokens (base units) with the 10% discount applied. */
export function quoteTokens(usdMicro: bigint, tokenUsd: number, decimals = TOKEN_DECIMALS) {
  const discounted = (usdMicro * BigInt(10_000 - TOKEN_DISCOUNT_BPS)) / 10_000n;
  // tokenUsd as micro-USD per whole token, scaled 1e12 for precision on tiny prices
  const priceScaled = BigInt(Math.round(tokenUsd * 1e12));
  if (priceScaled === 0n) return 0n;
  const num = discounted * 10n ** BigInt(decimals) * 1_000_000n;
  return (num + priceScaled - 1n) / priceScaled;
}

export function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

