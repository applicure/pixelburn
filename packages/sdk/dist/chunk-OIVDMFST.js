import {
  AUCTION_MIN_INCREMENT_BPS,
  AUCTION_MIN_INCREMENT_LAMPORTS,
  AUCTION_MIN_OPENING_BID_LAMPORTS,
  BITMAP_BYTES,
  BPS_DENOMINATOR,
  EMA_ALPHA_BPS,
  EMA_MAX_DEVIATION_BPS,
  EMA_MIN_INTERVAL_SECS,
  EMA_SPOT_CLAMP_BPS,
  EMA_WARMUP_CRANKS,
  EMA_WARMUP_SECS,
  GRID,
  MAX_EMA_AGE_SECS,
  MAX_IMAGE_URI_LEN,
  MAX_LINK_LEN,
  MAX_TITLE_LEN,
  PRICE_PER_BLOCK_USD_MICRO,
  PRICE_SCALE,
  SLOW_EMA_WINDOW_SECS,
  TOKEN_DISCOUNT_BPS,
  TOTAL_BLOCKS,
  TREASURY_BPS
} from "./chunk-GMGWLDHJ.js";

// src/util.ts
function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`bad hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function ceilDiv(a, b) {
  if (b <= 0n) throw new RangeError("division by zero");
  if (a < 0n) throw new RangeError("negative numerator");
  return (a + b - 1n) / b;
}
var U64_MAX = (1n << 64n) - 1n;
function assertU64(v, what = "value") {
  if (v < 0n || v > U64_MAX) throw new RangeError(`${what} does not fit u64`);
  return v;
}
function base64ToBytes(s) {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}
function bytesToBase64(b) {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  return Buffer.from(b).toString("base64");
}

// src/geometry.ts
function blockIndex(bx, by) {
  if (!isInt(bx) || !isInt(by) || bx < 0 || by < 0 || bx >= GRID || by >= GRID) {
    throw new RangeError(`block (${bx},${by}) out of range`);
  }
  return by * GRID + bx;
}
function blockCoords(index) {
  if (!isInt(index) || index < 0 || index >= TOTAL_BLOCKS) throw new RangeError(`bad block index ${index}`);
  return { bx: index % GRID, by: Math.floor(index / GRID) };
}
function isInt(n) {
  return Number.isInteger(n);
}
function isValidRect(r) {
  return isInt(r.x) && isInt(r.y) && isInt(r.w) && isInt(r.h) && r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= GRID && r.y + r.h <= GRID;
}
function assertValidRect(r) {
  if (!isValidRect(r)) throw new RangeError(`invalid rect ${JSON.stringify(r)}`);
}
function rectBlocks(r) {
  assertValidRect(r);
  const out = [];
  for (let by = r.y; by < r.y + r.h; by++) for (let bx = r.x; bx < r.x + r.w; bx++) out.push(by * GRID + bx);
  return out;
}
function rectBlockCount(r) {
  assertValidRect(r);
  return r.w * r.h;
}
function isBlockSet(bitmap, index) {
  return ((bitmap[index >> 3] ?? 0) & 1 << (index & 7)) !== 0;
}
function checkBitmap(bitmap) {
  if (bitmap.length !== BITMAP_BYTES) throw new RangeError(`bitmap must be ${BITMAP_BYTES} bytes, got ${bitmap.length}`);
}
function isRectFree(bitmap, r) {
  checkBitmap(bitmap);
  if (!isValidRect(r)) return false;
  for (let by = r.y; by < r.y + r.h; by++) {
    for (let bx = r.x; bx < r.x + r.w; bx++) if (isBlockSet(bitmap, by * GRID + bx)) return false;
  }
  return true;
}
function markRect(bitmap, r) {
  checkBitmap(bitmap);
  const out = new Uint8Array(bitmap);
  for (const i of rectBlocks(r)) out[i >> 3] |= 1 << (i & 7);
  return out;
}
function countSet(bitmap) {
  let n = 0;
  for (const b of bitmap) {
    let v = b;
    while (v) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}
function freeBlocks(bitmap) {
  checkBitmap(bitmap);
  const out = [];
  for (let i = 0; i < TOTAL_BLOCKS; i++) if (!isBlockSet(bitmap, i)) out.push(i);
  return out;
}
function emptyBitmap() {
  return new Uint8Array(BITMAP_BYTES);
}
function validateAdContent(c) {
  const bytes = (s) => new TextEncoder().encode(s).length;
  const badTitle = (s) => /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(s);
  const badUrl = (s) => !/^[\x21-\x7e]*$/.test(s);
  if (bytes(c.title) > MAX_TITLE_LEN || badTitle(c.title)) return "title must be <= 64 bytes without control/format characters";
  if (bytes(c.link) > MAX_LINK_LEN || !c.link.startsWith("https://") || c.link.length <= 8 || badUrl(c.link))
    return "link must be https://, printable ASCII, <= 200 bytes";
  const okScheme = c.imageUri.startsWith("ar://") && c.imageUri.length > 5 || c.imageUri.startsWith("https://") && c.imageUri.length > 8;
  if (bytes(c.imageUri) > MAX_IMAGE_URI_LEN || !okScheme || badUrl(c.imageUri))
    return "image URI must be ar:// or https://, printable ASCII, <= 200 bytes";
  return null;
}

// src/quote.ts
function quoteUsd(w, h) {
  assertValidRect({ x: 0, y: 0, w, h });
  return BigInt(w * h) * PRICE_PER_BLOCK_USD_MICRO;
}
function applyTokenDiscount(usdMicro) {
  return ceilDiv(usdMicro * (BPS_DENOMINATOR - TOKEN_DISCOUNT_BPS), BPS_DENOMINATOR);
}
function quoteLamports(usdMicro, solUsd) {
  if (solUsd.price <= 0n) throw new RangeError("SOL price must be positive");
  if (!Number.isInteger(solUsd.expo) || solUsd.expo < -18 || solUsd.expo > 6) throw new RangeError("unsupported expo");
  const shift = 3 - solUsd.expo;
  const l = shift >= 0 ? ceilDiv(usdMicro * 10n ** BigInt(shift), solUsd.price) : ceilDiv(usdMicro, solUsd.price * 10n ** BigInt(-shift));
  if (l === 0n) throw new RangeError("quote rounds to zero");
  return assertU64(l, "lamports");
}
function splitSol(lamports) {
  const treasury = lamports * TREASURY_BPS / BPS_DENOMINATOR;
  return { treasury, buyback: lamports - treasury };
}
function spotPriceQ(quoteLamportsReserve, baseUnitsReserve) {
  if (quoteLamportsReserve <= 0n || baseUnitsReserve <= 0n) throw new RangeError("empty reserves");
  const p = quoteLamportsReserve * PRICE_SCALE / baseUnitsReserve;
  if (p === 0n) throw new RangeError("empty reserves");
  return p;
}
function withinBand(a, b, bps) {
  const diff = a > b ? a - b : b - a;
  return diff <= b * bps / BPS_DENOMINATOR;
}
function emaUpdate(ema, spot) {
  return emaStep(ema, spot, EMA_ALPHA_BPS, BPS_DENOMINATOR);
}
function slowEmaUpdate(ema, spot) {
  return emaStep(ema, spot, BigInt(EMA_MIN_INTERVAL_SECS), BigInt(SLOW_EMA_WINDOW_SECS));
}
function emaStep(ema, spot, num, den) {
  if (ema <= 0n) throw new RangeError("EMA not seeded");
  const band = ema * EMA_SPOT_CLAMP_BPS / BPS_DENOMINATOR;
  const s = spot < ema - band ? ema - band : spot > ema + band ? ema + band : spot;
  return s >= ema ? ema + (s - ema) * num / den : ema - (ema - s) * num / den;
}
function tokenBlocksAvailable(c, nowSecs) {
  const elapsed = Math.max(0, nowSecs - c.tokenBlocksAllowanceUpdatedAt);
  const refill = Math.floor(c.tokenBlocksCapPerHour * elapsed / 3600);
  return Math.min(c.tokenBlocksCapPerHour, c.tokenBlocksAllowance + refill);
}
function tokenPricingStatus(c, spotQ, nowSecs, blocks) {
  if (c.tokenEmaPriceSol === 0n) return { ok: false, reason: "notSeeded", detail: "admin has not seeded the token EMA" };
  if (c.emaWarmupCranks < EMA_WARMUP_CRANKS || nowSecs - c.emaWarmupStartedAt < EMA_WARMUP_SECS)
    return { ok: false, reason: "warmingUp", detail: `EMA warm-up ${c.emaWarmupCranks}/${EMA_WARMUP_CRANKS} cranks` };
  if (nowSecs - c.emaUpdatedAt > MAX_EMA_AGE_SECS) return { ok: false, reason: "stale", detail: "EMA older than 15 min; crank first" };
  if (spotQ > c.tokenEmaPriceSol + c.tokenEmaPriceSol * EMA_MAX_DEVIATION_BPS / BPS_DENOMINATOR)
    return { ok: false, reason: "deviation", detail: "token price spiking; token payments paused until it settles" };
  let blocksAvailable;
  if (c.tokenBlocksCapPerHour !== void 0 && c.tokenBlocksAllowance !== void 0 && c.tokenBlocksAllowanceUpdatedAt !== void 0) {
    blocksAvailable = tokenBlocksAvailable(
      { tokenBlocksCapPerHour: c.tokenBlocksCapPerHour, tokenBlocksAllowance: c.tokenBlocksAllowance, tokenBlocksAllowanceUpdatedAt: c.tokenBlocksAllowanceUpdatedAt },
      nowSecs
    );
    if (blocks !== void 0 && blocks > blocksAvailable)
      return { ok: false, reason: "capExhausted", detail: `only ${blocksAvailable} token-paid blocks left this hour` };
  }
  const emaQ = c.tokenEmaPriceSol;
  const slowEmaQ = c.tokenSlowEmaPriceSol ?? emaQ;
  const priceQ = buyPriceQ(spotQ, emaQ, slowEmaQ);
  const pricedBy = priceQ === spotQ ? "spot" : priceQ === emaQ ? "ema" : "slowEma";
  return { ok: true, priceQ, emaQ, slowEmaQ, pricedBy, blocksAvailable };
}
function buyPriceQ(spot, ema, slowEma) {
  if (ema <= 0n || slowEma !== void 0 && slowEma <= 0n) throw new RangeError("EMA unavailable");
  let m = spot < ema ? spot : ema;
  if (slowEma !== void 0 && slowEma < m) m = slowEma;
  return m;
}
function lamportsToTokens(lamports, priceQ) {
  if (priceQ <= 0n) throw new RangeError("price unavailable");
  return assertU64(ceilDiv(lamports * PRICE_SCALE, priceQ), "tokens");
}
function quoteTokensExact(usdMicro, solUsd, spotQ, emaQ, slowEmaQ) {
  const lamports = quoteLamports(applyTokenDiscount(usdMicro), solUsd);
  return lamportsToTokens(lamports, buyPriceQ(spotQ, emaQ, slowEmaQ));
}
function tokenUsdFromPriceQ(priceQ, solUsd, decimals) {
  return { price: priceQ * 10n ** BigInt(decimals) * solUsd.price, expo: solUsd.expo - 27 };
}
function quoteTokens(usdMicro, tokenUsd, decimals) {
  if (tokenUsd.price <= 0n) throw new RangeError("token price must be positive");
  const disc = applyTokenDiscount(usdMicro);
  const k = tokenUsd.expo + 6;
  const num = disc * 10n ** BigInt(decimals);
  const t = k >= 0 ? ceilDiv(num, tokenUsd.price * 10n ** BigInt(k)) : ceilDiv(num * 10n ** BigInt(-k), tokenUsd.price);
  return t;
}
function withSlippage(amount, bps) {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError("bps must be a non-negative integer");
  return ceilDiv(amount * (BPS_DENOMINATOR + BigInt(bps)), BPS_DENOMINATOR);
}
function minNextBid(auction) {
  const highestBid = typeof auction === "bigint" ? auction : auction.highestBid;
  if (highestBid === 0n) return AUCTION_MIN_OPENING_BID_LAMPORTS;
  const pct = highestBid * AUCTION_MIN_INCREMENT_BPS / BPS_DENOMINATOR;
  return highestBid + (pct > AUCTION_MIN_INCREMENT_LAMPORTS ? pct : AUCTION_MIN_INCREMENT_LAMPORTS);
}
function estimateBurnForSolPurchase(usdMicro, tokenPriceQ, solUsd) {
  const lamports = quoteLamports(usdMicro, solUsd);
  const { buyback } = splitSol(lamports);
  if (tokenPriceQ <= 0n) throw new RangeError("token price unavailable");
  return { lamports, buybackLamports: buyback, estimatedTokens: buyback * PRICE_SCALE / tokenPriceQ, isEstimate: true };
}
function fixedToNumber(p) {
  return Number(p.price) * 10 ** p.expo;
}

export {
  hexToBytes,
  bytesToHex,
  ceilDiv,
  assertU64,
  base64ToBytes,
  bytesToBase64,
  blockIndex,
  blockCoords,
  isValidRect,
  assertValidRect,
  rectBlocks,
  rectBlockCount,
  isBlockSet,
  isRectFree,
  markRect,
  countSet,
  freeBlocks,
  emptyBitmap,
  validateAdContent,
  quoteUsd,
  applyTokenDiscount,
  quoteLamports,
  splitSol,
  spotPriceQ,
  withinBand,
  emaUpdate,
  slowEmaUpdate,
  tokenBlocksAvailable,
  tokenPricingStatus,
  buyPriceQ,
  lamportsToTokens,
  quoteTokensExact,
  tokenUsdFromPriceQ,
  quoteTokens,
  withSlippage,
  minNextBid,
  estimateBurnForSolPurchase,
  fixedToNumber
};
//# sourceMappingURL=chunk-OIVDMFST.js.map