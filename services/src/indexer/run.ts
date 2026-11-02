import type { Connection } from "@solana/web3.js";
import { AdvisoryLease, LOCK_INDEXER, type DbHandle } from "../db/client.js";
import type { EventParser } from "../chain/events.js";
import type { Logger } from "../lib/log.js";
import { heartbeat } from "../lib/heartbeat.js";
import { Indexer } from "./indexer.js";

export interface RunIndexerOptions {
  handle: DbHandle;
  conn: Connection;
  programId: string;
  decoder: EventParser;
  log: Logger;
  backfillIntervalMs: number;
  dropAfterSecs: number;
  heartbeatFile?: string;
  /**
   * Standalone indexer: exit(1) when the lock connection is lost, so Docker restarts the
   * container (which then waits for the lock again). In-API mode: stop and re-acquire.
   */
  exitOnLockLoss?: boolean;
}

/**
 * Runs the indexer only while holding the Postgres advisory lock LOCK_INDEXER, so at most
 * one indexer is active across API/indexer processes. A second instance (e.g. during a
 * rolling deploy) waits; if the lock connection dies, indexing stops and re-acquires.
 */
export function runIndexerWithLock(o: RunIndexerOptions): { stop: () => Promise<void> } {
  let stopped = false;
  let lease: AdvisoryLease | null = null;
  let indexer: Indexer | null = null;

  const loop = async () => {
    while (!stopped) {
      lease = new AdvisoryLease(o.handle, LOCK_INDEXER);
      let lastWaitLog = 0;
      let lost = false;
      const got = await lease.acquire({
        onWait: () => {
          heartbeat(o.heartbeatFile); // waiting for the lock is a healthy state
          if (Date.now() - lastWaitLog > 60_000) {
            o.log.info("waiting for indexer lock (another indexer is active)");
            lastWaitLog = Date.now();
          }
        },
        onLost: () => {
          lost = true;
          void indexer?.stop();
          indexer = null;
          if (o.exitOnLockLoss) {
            o.log.error("indexer lock connection lost; exiting so the container restarts");
            process.exit(1);
          }
          o.log.error("indexer lock connection lost; stopping indexer and re-acquiring");
        },
      });
      if (!got || stopped) break;
      o.log.info("indexer lock acquired");
      heartbeat(o.heartbeatFile);
      indexer = new Indexer({
        db: o.handle.db, conn: o.conn, programId: o.programId, decoder: o.decoder, log: o.log,
        backfillIntervalMs: o.backfillIntervalMs, dropAfterSecs: o.dropAfterSecs,
        onBackfillOk: () => heartbeat(o.heartbeatFile),
      });
      try {
        await indexer.start();
      } catch (e) {
        o.log.error(`indexer start failed: ${(e as Error).message}`);
      }
      // Hold until the lease is lost or we're stopped.
      while (!stopped && !lost) await new Promise((r) => setTimeout(r, 1_000));
      await lease.release().catch(() => {});
      if (!stopped) await new Promise((r) => setTimeout(r, 5_000));
    }
  };
  void loop();

  return {
    stop: async () => {
      stopped = true;
      await indexer?.stop();
      await lease?.release();
    },
  };
}
