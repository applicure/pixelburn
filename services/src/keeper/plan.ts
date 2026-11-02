// Pure buyback planning (unit-tested). MEV-aware: the vault balance is spent in small,
// randomized chunks with randomized delays, each with a min-out derived from a fresh quote.

export interface BuybackPlanOptions {
  vaultLamports: bigint;
  reserveLamports: bigint; // keep rent + fees in the vault
  maxPerRunLamports: bigint;
  minChunkLamports: bigint;
  maxChunkLamports: bigint;
  rng?: () => number; // [0,1)
}

export function planBuybackChunks(o: BuybackPlanOptions): bigint[] {
  const rng = o.rng ?? Math.random;
  let budget = o.vaultLamports - o.reserveLamports;
  if (budget > o.maxPerRunLamports) budget = o.maxPerRunLamports;
  if (budget < o.minChunkLamports) return [];
  const chunks: bigint[] = [];
  const span = o.maxChunkLamports - o.minChunkLamports;
  while (budget >= o.minChunkLamports) {
    if (o.maxChunkLamports < o.minChunkLamports) break;
    // Random size in [min, max], never more than what's left.
    let size = o.minChunkLamports + (span > 0n ? BigInt(Math.floor(rng() * Number(span))) : 0n);
    if (size > budget) size = budget;
    // Never strand a sub-minimum remainder when it can be avoided, and never exceed the max chunk
    // (a price-impact limit): either take everything (fits in one chunk) or shrink this chunk so
    // exactly the minimum is left for the next one. Only if neither is possible does dust stay.
    const rest = budget - size;
    if (rest > 0n && rest < o.minChunkLamports) {
      if (budget <= o.maxChunkLamports) size = budget;
      else if (budget - o.minChunkLamports >= o.minChunkLamports) size = budget - o.minChunkLamports;
    }
    chunks.push(size);
    budget -= size;
  }
  return chunks;
}

/** min tokens out after slippage, rounded down. */
export function minOutWithSlippage(expectedOut: bigint, slippageBps: number): bigint {
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Random delay in [baseMs, baseMs + jitterMs). */
export function jittered(baseMs: number, jitterMs: number, rng: () => number = Math.random): number {
  return baseMs + Math.floor(rng() * jitterMs);
}

/**
 * Mirror of the program's record_buyback_burn bar: tokens >= lamports * 1e18 / EMA * (1 - slippage).
 * EMA only (spot is not read on-chain), so the keeper's own price impact never raises the bar.
 */
export function minBuybackTokens(lamports: bigint, emaQ: bigint, slippageBps: number): bigint {
  if (emaQ <= 0n) throw new RangeError("EMA unavailable");
  const fair = (lamports * 10n ** 18n) / emaQ;
  return (fair * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Pre-trade deviation guard for one buyback chunk.
 * A buy that costs `impactPct` above spot (avg price, fees incl.) moves a constant-product price by
 * roughly (1 + impact)^2, so the projected post-trade spot is spot * (1 + impact)^2 (conservative:
 * fees inflate impact). Rejects when spot already exceeds the fast EMA by more than
 * maxSpotOverEmaPct, when the projected post-trade spot would, or when the run's cumulative
 * projected move would exceed maxRunPriceMovePct. Unknown prices are rejected (fail closed).
 */
export function checkDeviation(o: {
  spotQ: bigint | null;
  emaQ: bigint | null;
  impactPct: number;
  /** Reserve-based estimate (quoteIn / effective quote reserves, %); the larger estimate is used. */
  quoteFractionPct?: number;
  runFactor: number;
  maxSpotOverEmaPct: number;
  maxRunPriceMovePct: number;
}): { ok: true; runFactor: number } | { ok: false; reason: string } {
  if (o.spotQ === null || o.emaQ === null || o.emaQ <= 0n) return { ok: false, reason: "spot/EMA unavailable" };
  const ratio = Number((o.spotQ * 1_000_000n) / o.emaQ) / 1_000_000; // spot / fast EMA
  const limit = 1 + o.maxSpotOverEmaPct / 100;
  if (ratio > limit) return { ok: false, reason: `spot already ${((ratio - 1) * 100).toFixed(2)}% above fast EMA (limit ${o.maxSpotOverEmaPct}%)` };
  const move = Math.max(0, o.impactPct, o.quoteFractionPct ?? 0);
  const step = (1 + move / 100) ** 2; // constant product: price x (1 + quoteIn/effectiveQuote)^2
  if (ratio * step > limit) {
    return { ok: false, reason: `projected spot ${((ratio * step - 1) * 100).toFixed(2)}% above fast EMA after this chunk (limit ${o.maxSpotOverEmaPct}%)` };
  }
  const runFactor = o.runFactor * step;
  if (runFactor > 1 + o.maxRunPriceMovePct / 100) {
    return { ok: false, reason: `run would move spot ${((runFactor - 1) * 100).toFixed(2)}% (cap ${o.maxRunPriceMovePct}%)` };
  }
  return { ok: true, runFactor };
}
