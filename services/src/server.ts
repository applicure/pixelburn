import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { buildContext, type ServicesContext } from "./context.js";
import { runMigrations, NOTIFY_CHANNEL } from "./db/client.js";
import { createApp } from "./api/app.js";
import { runIndexerWithLock } from "./indexer/run.js";
import { makeHealth } from "./api/health.js";
import { createLogger } from "./lib/log.js";
import type { BusMessage } from "./indexer/ingest.js";

/**
 * Bridges Postgres NOTIFY (emitted by ingest/moderation, possibly from another
 * process) to the in-process bus used by SSE, the composer, and moderation.
 */
export async function wireNotifications(ctx: ServicesContext, getStats: (fresh?: boolean) => Promise<unknown>) {
  let statsTimer: NodeJS.Timeout | null = null;
  const pushStats = () => {
    if (statsTimer) return;
    statsTimer = setTimeout(async () => {
      statsTimer = null;
      try {
        ctx.bus.emit("stats", await getStats(true));
      } catch (e) {
        ctx.log.warn(`stats push failed: ${(e as Error).message}`);
      }
    }, 500);
  };
  const sub = await ctx.handle.sql.listen(NOTIFY_CHANNEL, (payload) => {
    let m: BusMessage;
    try {
      m = JSON.parse(payload) as BusMessage;
    } catch {
      return;
    }
    if (m.kind === "feed") ctx.bus.emit("feed", m.item);
    else if (m.kind === "stats") pushStats();
    else if (m.kind === "canvas") {
      void ctx.composer.rebuild();
      pushStats();
    }
    else if (m.kind === "ads") {
      if (m.reason === "new" || m.reason === "updated") void ctx.moderation.tick();
      // An approved ad left the canvas (content update or fork rollback): full re-render.
      if ((m.reason === "updated" || m.reason === "removed") && m.adIds.some((id) => ctx.composer.has(id))) {
        void ctx.composer.rebuild();
      }
      pushStats();
    }
  });
  return { unlisten: () => sub.unlisten() };
}

async function main() {
  const cfg = loadConfig();
  const log = createLogger("api", cfg.LOG_LEVEL);
  const ctx = await buildContext(cfg, { log });
  await runMigrations(ctx.handle);

  const app = createApp({
    db: ctx.db,
    log: ctx.log,
    composer: ctx.composer,
    moderation: ctx.moderation,
    quotes: ctx.quotes,
    stats: ctx.stats,
    storage: ctx.storage,
    localFiles: ctx.localFiles,
    resolveImageUrl: ctx.resolveImageUrl,
    bus: ctx.bus,
    webOrigins: cfg.corsOrigins,
    adminToken: cfg.ADMIN_TOKEN,
    helius:
      cfg.HELIUS_WEBHOOK_SECRET && cfg.PROGRAM_ID
        ? { secret: cfg.HELIUS_WEBHOOK_SECRET, conn: ctx.conn, programId: cfg.PROGRAM_ID, decoder: ctx.decoder }
        : undefined,
    trustProxy: cfg.TRUST_PROXY,
    rateLimits: { uploadsPerMin: cfg.RATE_LIMIT_UPLOADS_PER_MIN, quotePerMin: cfg.RATE_LIMIT_QUOTE_PER_MIN },
    health: makeHealth({
      db: ctx.db, conn: ctx.conn, programId: cfg.PROGRAM_ID, backfillIntervalMs: cfg.INDEXER_BACKFILL_INTERVAL_MS, startedAt: Date.now(),
    }),
  });

  await wireNotifications(ctx, app.getStats);
  await ctx.composer.rebuild();
  const modTimer = setInterval(() => void ctx.moderation.tick(), 10_000);
  void ctx.moderation.tick();

  let indexer: { stop: () => Promise<void> } | null = null;
  if (cfg.INDEXER_ENABLED) {
    if (!cfg.PROGRAM_ID) ctx.log.warn("INDEXER_ENABLED=1 but PROGRAM_ID is unset; indexer not started");
    else {
      indexer = runIndexerWithLock({
        handle: ctx.handle, conn: ctx.conn, programId: cfg.PROGRAM_ID, decoder: ctx.decoder, log: createLogger("indexer", cfg.LOG_LEVEL),
        backfillIntervalMs: cfg.INDEXER_BACKFILL_INTERVAL_MS, dropAfterSecs: cfg.INDEXER_DROP_AFTER_SECS,
      });
    }
  }

  const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) =>
    ctx.log.info(
      `listening on ${info.address}:${info.port} public=${cfg.publicBaseUrl} cluster=${cfg.SOLANA_CLUSTER} storage=${ctx.storage.kind} indexer=${indexer ? "in-process" : "off"} cors=${cfg.corsOrigins.join(",")}`,
    ),
  );

  const shutdown = async () => {
    clearInterval(modTimer);
    await indexer?.stop();
    server.close();
    await ctx.handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
