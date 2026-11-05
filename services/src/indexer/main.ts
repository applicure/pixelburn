// Standalone indexer process: `pnpm --filter @mpb/services indexer` / Docker target `indexer`.
// Only one indexer is active at a time (Postgres advisory lock); extra instances wait.
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { createDb, runMigrations } from "../db/client.js";
import { SdkEventParser } from "../chain/events.js";
import { createLogger } from "../lib/log.js";
import { heartbeat } from "../lib/heartbeat.js";
import { runIndexerWithLock } from "./run.js";
import { assertDatabaseIsForProgram } from "./guard.js";
import { makeHistoryFallbacks } from "./indexer.js";

const cfg = loadConfig();
const log = createLogger("indexer", cfg.LOG_LEVEL);
const hb = process.env.HEARTBEAT_FILE || "/tmp/indexer.heartbeat";
heartbeat(hb);
if (!cfg.PROGRAM_ID) {
  // Stay up (healthy, idle) instead of crash-looping before the program is deployed.
  log.warn("PROGRAM_ID is not set; indexer idle");
  setInterval(() => heartbeat(hb), 30_000);
} else {
  const h = createDb(cfg.DATABASE_URL, { max: 4 });
  await runMigrations(h);
  if (cfg.SOLANA_CLUSTER === "mainnet-beta") await assertDatabaseIsForProgram(h.db, cfg.PROGRAM_ID);
  const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed", wsEndpoint: cfg.wsUrl });
  log.info(`starting: program=${cfg.PROGRAM_ID} cluster=${cfg.SOLANA_CLUSTER}`);
  const historyFallbacks = await makeHistoryFallbacks(conn, cfg.historyRpcFallbacks, log);
  log.info(`history fallbacks: ${historyFallbacks.map((f) => f.label).join(", ") || "none"}`);
  const runner = runIndexerWithLock({
    handle: h, conn, programId: cfg.PROGRAM_ID, decoder: new SdkEventParser(cfg.PROGRAM_ID), log,
    backfillIntervalMs: cfg.INDEXER_BACKFILL_INTERVAL_MS, dropAfterSecs: cfg.INDEXER_DROP_AFTER_SECS, heartbeatFile: hb, exitOnLockLoss: true, historyFallbacks,
  });
  const stop = async () => {
    await runner.stop();
    await h.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
