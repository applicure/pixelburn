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
    // Random size in [min, max], never more than what's left.
    let size = o.minChunkLamports + (span > 0n ? BigInt(Math.floor(rng() * Number(span))) : 0n);
    if (size > budget) size = budget;
    // Avoid leaving an unusable dust remainder below the minimum chunk.
    if (budget - size > 0n && budget - size < o.minChunkLamports) size = budget;
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
