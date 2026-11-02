/**
 * Compute-unit limits (measured in chain/programs/pixel/tests/all/cu.rs, which asserts the program stays under
 * these numbers) and priority-fee estimation.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import type { Rect } from "./geometry.js";

/** Static per-instruction CU limits (measured max + headroom). See chain/NOTES.md "Compute units". */
export const CU_LIMITS = {
  initialize: 60_000,
  crankTokenPrice: 20_000,
  updateAd: 15_000,
  transferAd: 15_000,
  releaseBuyback: 20_000,
  recordBuybackBurn: 40_000,
  startFinalAuction: 80_000,
  bidFinalAuction: 20_000,
  restartFinalAuction: 15_000,
  settleFinalAuction: 70_000,
} as const;

/** Buy CU scales with the rect's row count (bitmap check/mark is per row). Measured: 1x1 ≈ 24k (SOL) / 31k (token), 100x99 ≈ 117k. */
export function buyCuLimit(rect: Pick<Rect, "h">, mode: "sol" | "token"): number {
  return (mode === "sol" ? 50_000 : 65_000) + 1_200 * rect.h;
}

export interface PriorityFeeOpts {
  /** Percentile of recent non-zero fees to use (default 75). */
  percentile?: number;
  /** Floor in micro-lamports per CU (default 1_000). */
  minMicroLamports?: number;
  /** Hard cap in micro-lamports per CU (default 200_000 = 0.2 lamports/CU). */
  maxMicroLamports?: number;
}

/**
 * Priority fee (micro-lamports per CU) from `getRecentPrioritizationFees` for the hot writable accounts,
 * percentile of the last ~150 slots, clamped to [min, max]. Falls back to `min` if the RPC call fails.
 */
export async function estimatePriorityFee(
  connection: Pick<Connection, "getRecentPrioritizationFees">,
  writableAccounts: PublicKey[],
  opts: PriorityFeeOpts = {},
): Promise<number> {
  const min = opts.minMicroLamports ?? 1_000;
  const max = opts.maxMicroLamports ?? 200_000;
  const pct = Math.min(100, Math.max(0, opts.percentile ?? 75));
  let fees: number[] = [];
  try {
    const res = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts });
    fees = res.map((r) => r.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
  } catch {
    return min;
  }
  if (fees.length === 0) return min;
  const idx = Math.min(fees.length - 1, Math.ceil((pct / 100) * fees.length) - 1);
  const v = fees[Math.max(0, idx)]!;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Total priority fee in lamports for a CU limit and price. */
export function priorityFeeLamports(cuLimit: number, microLamportsPerCu: number): bigint {
  return (BigInt(cuLimit) * BigInt(microLamportsPerCu) + 999_999n) / 1_000_000n;
}
