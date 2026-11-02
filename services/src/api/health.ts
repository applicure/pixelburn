import { sql } from "drizzle-orm";
import type { Connection } from "@solana/web3.js";
import type { Db } from "../db/client.js";
import { indexerCursor } from "../db/schema.js";
import { cached } from "../pricing/prices.js";

export interface HealthDeps {
  db: Db;
  conn: Connection | null;
  programId?: string;
  backfillIntervalMs: number;
  startedAt: number;
}

export async function dbReady(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** /healthz payload: DB status + indexer lag (for monitoring; never fails on RPC errors). */
export function makeHealth(d: HealthDeps) {
  const chainSlot = cached(async () => {
    if (!d.conn) return null;
    return Promise.race([d.conn.getSlot("finalized"), new Promise<null>((r) => setTimeout(() => r(null), 2_000))]).catch(() => null);
  }, 10_000);

  return async () => {
    const db = await dbReady(d.db);
    let indexer: Record<string, unknown> | null = null;
    if (db && d.programId) {
      const [cur] = await d.db.select().from(indexerCursor).limit(1);
      const [{ n: provisional } = { n: 0 }] = await d.db.execute<{ n: number }>(
        sql`select count(distinct signature)::int as n from chain_events where not finalized`,
      );
      const slot = await chainSlot().catch(() => null);
      const secsSinceCheck = cur?.lastCheckedAt ? Math.round((Date.now() - cur.lastCheckedAt.getTime()) / 1000) : null;
      indexer = {
        lastSignatureSlot: cur?.lastSlot ?? null,
        lastCheckedAt: cur?.lastCheckedAt ? Math.floor(cur.lastCheckedAt.getTime() / 1000) : null,
        secsSinceCheck,
        chainFinalizedSlot: slot,
        lagSlots: slot !== null && cur?.lastCheckedSlot != null ? Math.max(0, slot - cur.lastCheckedSlot) : null,
        provisionalTxs: provisional,
        stale: secsSinceCheck === null || secsSinceCheck > (3 * d.backfillIntervalMs) / 1000,
      };
    }
    return {
      ok: db && !(indexer && indexer.stale),
      db,
      indexer,
      uptimeSecs: Math.round((Date.now() - d.startedAt) / 1000),
    };
  };
}
