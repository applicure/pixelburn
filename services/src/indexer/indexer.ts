// Indexer: finalized backfill from a cursor + provisional live stream via onLogs +
// a finalizer that promotes/rolls back provisional transactions.
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chainEvents, indexerCursor } from "../db/schema.js";
import type { EventParser } from "../chain/events.js";
import { finalizeSignature, ingestTx, rollbackSignature } from "./ingest.js";
import type { Logger } from "../lib/log.js";

export interface IndexerOptions {
  db: Db;
  conn: Connection;
  programId: string;
  decoder: EventParser;
  log: Logger;
  backfillIntervalMs: number;
  /** Provisional txs whose signature status is unknown for this long are treated as dropped. */
  dropAfterSecs: number;
  /** Called after every successful backfill pass (heartbeat). */
  onBackfillOk?: () => void;
}

export class Indexer {
  private stopped = false;
  private subId: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  private backfillRunning = false;
  readonly program: PublicKey;

  constructor(private readonly o: IndexerOptions) {
    this.program = new PublicKey(o.programId);
  }

  async start() {
    // A failing first pass (RPC down) must not prevent the periodic retries below.
    await this.backfill().catch((e) => this.o.log.error(`initial backfill failed: ${(e as Error).message}`));
    this.subscribe();
    this.timers.push(
      setInterval(() => void this.backfill().catch((e) => this.o.log.error(`backfill failed: ${(e as Error).message}`)), this.o.backfillIntervalMs),
    );
    this.timers.push(setInterval(() => void this.finalize().catch((e) => this.o.log.error(`finalizer failed: ${(e as Error).message}`)), 15_000));
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    if (this.subId !== null) await this.o.conn.removeOnLogsListener(this.subId).catch(() => {});
  }

  /** Fetch every finalized signature newer than the cursor (oldest first) and ingest it. */
  async backfill(): Promise<number> {
    if (this.backfillRunning) return 0;
    this.backfillRunning = true;
    try {
      const { db, conn, programId } = this.o;
      const [cur] = await db.select().from(indexerCursor).where(eq(indexerCursor.id, programId));
      const until = cur?.lastSignature ?? undefined;
      const sigs: ConfirmedSignatureInfo[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await conn.getSignaturesForAddress(this.program, { before, until, limit: 1000 }, "finalized");
        sigs.push(...page);
        if (page.length < 1000 || this.stopped) break;
        before = page[page.length - 1]!.signature;
      }
      sigs.reverse(); // oldest first
      let n = 0;
      for (const s of sigs) {
        if (this.stopped) break;
        if (!s.err) {
          const tx = await conn.getTransaction(s.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
          const logs = tx?.meta?.logMessages;
          if (logs && !tx.meta?.err) {
            const events = this.o.decoder.parse(logs);
            await ingestTx(db, { signature: s.signature, slot: s.slot, finalized: true, source: "backfill", blockTime: s.blockTime, events });
            n++;
          }
        }
        // Cursor only advances over finalized history, so a restart never skips anything.
        await db
          .insert(indexerCursor)
          .values({ id: programId, lastSignature: s.signature, lastSlot: s.slot, updatedAt: new Date() })
          .onConflictDoUpdate({ target: indexerCursor.id, set: { lastSignature: s.signature, lastSlot: s.slot, updatedAt: new Date() } });
      }
      // Liveness/lag marker for /healthz, written even when nothing new was found.
      const checkedSlot = await conn.getSlot("finalized").catch(() => null);
      await db
        .insert(indexerCursor)
        .values({ id: programId, lastCheckedAt: new Date(), lastCheckedSlot: checkedSlot, updatedAt: new Date() })
        .onConflictDoUpdate({ target: indexerCursor.id, set: { lastCheckedAt: new Date(), lastCheckedSlot: checkedSlot } });
      this.o.onBackfillOk?.();
      if (n) this.o.log.info(`backfill ingested ${n} txs`);
      return n;
    } finally {
      this.backfillRunning = false;
    }
  }

  private subscribe() {
    const { conn, programId, db, decoder, log } = this.o;
    this.subId = conn.onLogs(
      this.program,
      (l, ctx) => {
        if (l.err) return;
        const events = decoder.parse(l.logs);
        if (!events.length) return;
        ingestTx(db, { signature: l.signature, slot: ctx.slot, finalized: false, source: "logs", events }).catch((e) =>
          log.error(`live ingest failed: ${(e as Error).message}`),
        );
      },
      "confirmed",
    );
    log.info(`subscribed to program logs ${programId}`);
  }

  /** Promote provisional rows to finalized, or roll back those dropped by a fork. */
  async finalize(): Promise<{ finalized: number; rolledBack: number }> {
    const { db, conn, dropAfterSecs } = this.o;
    const rows = await db
      .selectDistinct({ sig: chainEvents.signature, at: chainEvents.ingestedAt })
      .from(chainEvents)
      .where(and(eq(chainEvents.finalized, false), lt(chainEvents.ingestedAt, new Date(Date.now() - 5_000))))
      .limit(256);
    if (!rows.length) return { finalized: 0, rolledBack: 0 };
    const { value } = await conn.getSignatureStatuses(rows.map((r) => r.sig), { searchTransactionHistory: true });
    let finalized = 0, rolledBack = 0;
    for (let i = 0; i < rows.length; i++) {
      const st = value[i];
      const row = rows[i]!;
      if (st?.confirmationStatus === "finalized" && !st.err) {
        if (await finalizeSignature(db, row.sig)) finalized++;
      } else if (st?.err || (!st && Date.now() - row.at.getTime() > dropAfterSecs * 1000)) {
        await rollbackSignature(db, row.sig);
        rolledBack++;
      }
    }
    if (finalized || rolledBack) this.o.log.info(`finalizer: ${finalized} finalized, ${rolledBack} rolled back`);
    return { finalized, rolledBack };
  }
}

/**
 * Helius webhook ingest. Accepts raw or enhanced webhook payloads (array of txs).
 * Raw payloads carry meta.logMessages; enhanced ones do not, so we fetch the tx by
 * signature. Webhook deliveries are treated as provisional (confirmed).
 */
export async function ingestHeliusPayload(
  payload: unknown,
  deps: { db: Db; conn: Connection | null; programId: string; decoder: EventParser },
): Promise<{ txs: number; events: number }> {
  const items = Array.isArray(payload) ? payload : [payload];
  let txs = 0, events = 0;
  for (const raw of items as Record<string, any>[]) {
    const signature: string | undefined = raw?.signature ?? raw?.transaction?.signatures?.[0];
    if (!signature) continue;
    let logs: string[] | undefined = raw?.meta?.logMessages;
    let slot: number = raw?.slot ?? 0;
    let blockTime: number | null = raw?.blockTime ?? raw?.timestamp ?? null;
    if (raw?.meta?.err || raw?.transactionError) continue;
    if (!logs && deps.conn) {
      const tx = await deps.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) continue;
      logs = tx.meta?.logMessages ?? undefined;
      slot = tx.slot;
      blockTime = tx.blockTime ?? blockTime;
    }
    if (!logs) continue;
    const evs = deps.decoder.parse(logs);
    if (!evs.length) continue;
    const r = await ingestTx(deps.db, { signature, slot, finalized: false, source: "helius", blockTime, events: evs });
    txs++;
    events += r.inserted;
  }
  return { txs, events };
}
