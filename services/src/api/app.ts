import { EventEmitter } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ads } from "../db/schema.js";
import type { Composer } from "../composer/composer.js";
import type { ModerationService } from "../moderation/service.js";
import type { QuoteService } from "../pricing/quote.js";
import { processUpload, UploadError } from "../uploads/process.js";
import { LocalStorage, type Storage } from "../uploads/storage.js";
import type { EventParser } from "../chain/events.js";
import type { Connection } from "@solana/web3.js";
import { ingestHeliusPayload } from "../indexer/indexer.js";
import { auctionState, buybackPage, computeStats, decodeCursor, feed, leaderboard, occupancy, type StatsDeps } from "./queries.js";
import { toAdDto, type AdRow, type AdShareDto, type FeedItem, type StatsDto } from "./dto.js";
import { CardBusy, CardService, cardState } from "../card/service.js";
import { microToUsd } from "../lib/quote-math.js";
import { rateLimit } from "./rate-limit.js";
import { TokenPricingUnavailable } from "../pricing/prices.js";
import { dbReady } from "./health.js";
import { redact } from "../lib/redact.js";
import { MAX_UPLOAD_BYTES } from "../constants.js";
import type { Logger } from "../lib/log.js";

export interface AppDeps {
  db: Db;
  log: Logger;
  composer: Composer;
  moderation: ModerationService;
  quotes: QuoteService;
  stats: Omit<StatsDeps, "db">;
  storage: Storage;
  /** Local storage used to serve /files/* (always present for dev fallback). */
  localFiles: LocalStorage;
  resolveImageUrl: (uri: string) => string;
  bus: EventEmitter;
  webOrigins: string[];
  adminToken?: string;
  helius?: { secret: string; conn: Connection | null; programId: string; decoder: EventParser };
  trustProxy?: boolean;
  rateLimits: { uploadsPerMin: number; quotePerMin: number; cardRendersPerMin?: number };
  cluster: "devnet" | "mainnet-beta";
  /** /healthz payload (monitoring). Defaults to a DB-only check. */
  health?: () => Promise<{ ok: boolean; db: boolean } & Record<string, unknown>>;
}

const QuoteQuery = z.object({
  w: z.coerce.number().int().min(1).max(100),
  h: z.coerce.number().int().min(1).max(100),
  mode: z.enum(["sol", "token"]).default("sol"),
});

const UploadFields = z.object({
  w: z.coerce.number().int().min(1).max(100),
  h: z.coerce.number().int().min(1).max(100),
  format: z.enum(["png", "webp"]).default("png"),
});

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createApp(d: AppDeps) {
  const app = new Hono();
  let sseClients = 0;

  const clientIp = (c: Context): string => {
    if (d.trustProxy) {
      const xff = c.req.header("x-forwarded-for");
      if (xff) return xff.split(",")[0]!.trim();
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? "unknown";
  };

  app.onError((err, c) => {
    if (err instanceof UploadError) return c.json({ error: err.message }, err.status);
    d.log.error(`${c.req.method} ${c.req.path}: ${err.message}`, err);
    return c.json({ error: "internal_error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.use(
    "*",
    cors({
      origin: d.webOrigins.includes("*") ? "*" : d.webOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "If-None-Match"],
      exposeHeaders: ["ETag", "RateLimit-Limit", "RateLimit-Remaining", "Retry-After"],
      maxAge: 600,
    }),
  );

  // Liveness/readiness. /readyz = DB reachable (used by the Docker HEALTHCHECK);
  // /healthz = DB + indexer lag for monitoring (200 while the DB is up, `ok:false` if the indexer is stale).
  app.get("/readyz", async (c) => ((await dbReady(d.db)) ? c.json({ ok: true }) : c.json({ ok: false }, 503)));
  app.get("/healthz", async (c) => {
    const h = d.health ? await d.health() : { ok: await dbReady(d.db), db: await dbReady(d.db) };
    c.header("Cache-Control", "no-store");
    return c.json({ ...h, sseClients }, h.db ? 200 : 503);
  });
  app.get("/health", (c) => c.json({ ok: true }));

  // ---- stats (memoized briefly; SSE pushes fresh values) ----
  let statsCache: { at: number; v: Promise<StatsDto> } | null = null;
  const getStats = (fresh = false) => {
    if (!fresh && statsCache && Date.now() - statsCache.at < 2_000) return statsCache.v;
    const v = computeStats({ db: d.db, ...d.stats });
    statsCache = { at: Date.now(), v };
    v.catch(() => (statsCache = null));
    return v;
  };

  app.get("/api/stats", async (c) => c.json(await getStats()));

  app.get("/api/ads", async (c) => {
    const rows = await d.db.select().from(ads).where(eq(ads.status, "approved")).orderBy(asc(ads.id));
    c.header("Cache-Control", "public, max-age=5");
    return c.json(rows.map((r) => toAdDto(r, d.resolveImageUrl)));
  });

  app.get("/api/ads/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 0) return c.json({ error: "invalid_id" }, 400);
    const [row] = await d.db.select().from(ads).where(eq(ads.id, id));
    if (!row) return c.json({ error: "not_found" }, 404);
    // Unapproved ads are not public; expose only their moderation status so a buyer's UI can say "under review".
    if (row.status !== "approved") return c.json({ error: "not_found", status: row.status, reason: row.status === "rejected" ? row.reason : null }, 404);
    return c.json(toAdDto(row, d.resolveImageUrl));
  });

  // ---- share: the ad page's data and its server-rendered card ----
  const cards = new CardService(d.db, d.composer, d.cluster, d.stats.decimals, d.log);
  const cardRenderLimit = rateLimit({ perMinute: d.rateLimits.cardRendersPerMin ?? 60, key: "card", clientIp });

  /** A real on-chain ad id or nothing: `1e3`, `0x10` and ids past int4 never reach the database. */
  const adRow = async (raw: string): Promise<AdRow | null> => {
    if (!/^\d{1,10}$/.test(raw) || Number(raw) > 2_147_483_647) return null;
    const [row] = await d.db.select().from(ads).where(eq(ads.id, Number(raw)));
    return row ?? null;
  };

  app.get("/api/ads/:id/share", async (c) => {
    const row = await adRow(c.req.param("id"));
    c.header("Cache-Control", "no-cache");
    if (!row) return c.json({ error: "not_found" }, 404);
    const state = cardState(row);
    const dto: AdShareDto = {
      id: row.id,
      status: state,
      owner: row.owner,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      blockCount: row.blocks?.length || row.w * row.h,
      payMode: row.payMode,
      usd: microToUsd(row.usdMicro),
      lamports: row.paidLamports,
      tokensBurned: row.paidTokens,
      createdAt: Math.floor(row.createdAt.getTime() / 1000),
      signature: row.signature,
      finalized: row.finalized,
      cluster: d.cluster,
      cardVersion: cards.version(row),
      ad: state === "approved" ? { title: row.title, link: row.link, imageUrl: row.imageUri ? d.resolveImageUrl(row.imageUri) : "" } : null,
    };
    return c.json(dto);
  });

  app.get("/api/ads/:id/card.png", async (c) => {
    const row = await adRow(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    let card = cards.cached(row);
    if (!card) {
      // Only renders count against the limit: crawlers and repeat views of a finished card cost nothing.
      const limited = await cardRenderLimit(c, async () => {});
      if (limited) return limited;
      try {
        card = await cards.render(row);
      } catch (e) {
        if (!(e instanceof CardBusy)) throw e;
        c.header("Retry-After", "10");
        return c.json({ error: "busy" }, 503);
      }
    }
    c.header("X-Content-Type-Options", "nosniff");
    if (!card.complete) {
      c.header("Cache-Control", "no-store");
    } else {
      // No `immutable`, even on a current URL: a rejection has to be able to take the picture down.
      c.header("Cache-Control", `public, max-age=${c.req.query("v") === card.version ? 300 : 60}`);
      c.header("ETag", `"${card.version}"`);
      if (c.req.header("if-none-match")?.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(`"${card.version}"`)) return c.body(null, 304);
    }
    c.header("Content-Type", "image/png");
    return c.body(new Uint8Array(card.png));
  });

  app.get("/api/occupancy", async (c) => {
    const o = await occupancy(d.db);
    c.header("Cache-Control", "no-cache");
    return c.json({ bitmap: Buffer.from(o.bitmap).toString("base64"), soldBlocks: o.soldBlocks });
  });

  app.get("/api/canvas.png", async (c) => {
    const img = await d.composer.getImage();
    const inm = c.req.header("if-none-match");
    c.header("ETag", img.etag);
    c.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    c.header("Last-Modified", img.updatedAt.toUTCString());
    if (inm && inm.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(img.etag)) return c.body(null, 304);
    c.header("Content-Type", "image/png");
    return c.body(new Uint8Array(img.png));
  });

  app.get("/api/feed", async (c) => {
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(c.req.query("limit") ?? 50);
    return c.json(await feed(d.db, limit));
  });

  app.get("/api/leaderboard", async (c) => {
    const limit = z.coerce.number().int().min(1).max(500).catch(100).parse(c.req.query("limit") ?? 100);
    return c.json(await leaderboard(d.db, limit));
  });

  app.get(
    "/api/quote",
    rateLimit({ perMinute: d.rateLimits.quotePerMin, key: "quote", clientIp }),
    async (c) => {
      const q = QuoteQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
      try {
        c.header("Cache-Control", "no-store");
        return c.json(await d.quotes.quote(q.data.w, q.data.h, q.data.mode));
      } catch (e) {
        if (e instanceof TokenPricingUnavailable) {
          // e.g. warmingUp / stale / deviation / notSeeded: the program would reject buy_with_token now.
          return c.json({ error: "token_pricing_unavailable", reason: e.reason, tokenPaymentStatus: e.reason, detail: e.message }, 503);
        }
        d.log.warn(`quote failed: ${(e as Error).message}`);
        return c.json({ error: "price_unavailable", detail: redact((e as Error).message) }, 503);
      }
    },
  );

  app.get("/api/auction", async (c) => c.json(await auctionState(d.db)));

  app.get("/api/buybacks", async (c) => {
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(c.req.query("limit") ?? 50);
    const raw = c.req.query("cursor");
    const cursor = raw ? decodeCursor(raw) : null;
    if (raw && !cursor) return c.json({ error: "invalid_cursor" }, 400);
    return c.json(await buybackPage(d.db, limit, cursor));
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const onFeed = (item: FeedItem) => void stream.writeSSE({ event: "feed", data: JSON.stringify(item), id: String(++id) });
      const onStats = (s: StatsDto) => void stream.writeSSE({ event: "stats", data: JSON.stringify(s), id: String(++id) });
      d.bus.on("feed", onFeed);
      d.bus.on("stats", onStats);
      sseClients++;
      stream.onAbort(() => {
        sseClients--;
        d.bus.off("feed", onFeed);
        d.bus.off("stats", onStats);
      });
      await stream.writeSSE({ event: "stats", data: JSON.stringify(await getStats()), id: String(++id) });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (!stream.aborted) await stream.write(": ping\n\n");
      }
    }),
  );

  app.post(
    "/api/uploads",
    rateLimit({ perMinute: d.rateLimits.uploadsPerMin, key: "uploads", clientIp }),
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (c) => c.json({ error: "file exceeds 5MB" }, 413) }),
    async (c) => {
      const body = await c.req.parseBody();
      const fields = UploadFields.safeParse({ w: body.w, h: body.h, format: body.format ?? undefined });
      if (!fields.success) return c.json({ error: "invalid_fields", issues: fields.error.issues }, 400);
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: "missing file" }, 400);
      if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "file exceeds 5MB" }, 413);
      const processed = await processUpload(Buffer.from(await file.arrayBuffer()), fields.data.w, fields.data.h, fields.data.format);
      const stored = await d.storage.put(processed.bytes, processed.contentType, processed.sha256);
      // Pre-warm the composer cache so approval doesn't need to refetch from Arweave.
      await d.composer.cacheImage(processed.sha256, processed.bytes);
      return c.json({
        uri: stored.uri,
        sha256: processed.sha256,
        previewUrl: stored.url,
        width: processed.width,
        height: processed.height,
        contentType: processed.contentType,
      });
    },
  );

  app.get("/files/:name", async (c) => {
    const name = c.req.param("name");
    const bytes = await d.localFiles.read(name);
    if (!bytes) return c.json({ error: "not_found" }, 404);
    c.header("Content-Type", name.endsWith(".webp") ? "image/webp" : name.endsWith(".jpg") ? "image/jpeg" : "image/png");
    c.header("Cache-Control", "public, max-age=31536000, immutable"); // content-addressed
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(bytes));
  });

  // ---- admin ----
  const admin: MiddlewareHandler = async (c, next) => {
    if (!d.adminToken) return c.json({ error: "admin_disabled" }, 503);
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer (.+)$/i.exec(h);
    if (!m || !safeEqual(m[1]!, d.adminToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };

  app.get("/api/admin/queue", admin, async (c) => {
    const status = z.enum(["pending", "approved", "rejected"]).catch("pending").parse(c.req.query("status") ?? "pending");
    const limit = z.coerce.number().int().min(1).max(500).catch(100).parse(c.req.query("limit") ?? 100);
    const rows = await d.db
      .select()
      .from(ads)
      .where(eq(ads.status, status))
      .orderBy(status === "pending" ? asc(ads.id) : desc(ads.moderatedAt))
      .limit(limit);
    return c.json(
      rows.map((r) => ({
        ...toAdDto(r, d.resolveImageUrl),
        status: r.status,
        reason: r.reason,
        checks: r.checks,
        hydrated: r.hydrated,
        finalized: r.finalized,
        imageUri: r.imageUri,
        imageSha256: r.imageSha256,
        signature: r.signature,
        checkedAt: r.checkedAt ? Math.floor(r.checkedAt.getTime() / 1000) : null,
        moderatedAt: r.moderatedAt ? Math.floor(r.moderatedAt.getTime() / 1000) : null,
        moderatedBy: r.moderatedBy,
      })),
    );
  });

  app.post("/api/admin/ads/:id/approve", admin, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const row = await d.moderation.approve(id, "admin");
    if (!row) return c.json({ error: "not_found_or_not_hydrated" }, 404);
    return c.json({ ok: true, id, status: row.status });
  });

  app.post("/api/admin/ads/:id/reject", admin, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : "rejected by moderator";
    const row = await d.moderation.reject(id, reason, "admin");
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, id, status: row.status, reason });
  });

  // ---- Helius webhook ----
  app.post("/webhooks/helius", bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
    if (!d.helius) return c.json({ error: "webhook_disabled" }, 503);
    const auth = c.req.header("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!safeEqual(token, d.helius.secret)) return c.json({ error: "unauthorized" }, 401);
    const payload = await c.req.json().catch(() => null);
    if (payload === null) return c.json({ error: "invalid_json" }, 400);
    const r = await ingestHeliusPayload(payload, { db: d.db, ...d.helius });
    return c.json({ ok: true, ...r });
  });

  return Object.assign(app, { getStats });
}
