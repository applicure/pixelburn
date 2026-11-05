import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { ads } from "../src/db/schema.js";
import { ingestTx } from "../src/indexer/ingest.js";
import { fakeLogs, type ProgramEvent } from "../src/chain/events.js";
import { generatePixelArt } from "../src/lib/pixelart.js";
import { sha256Hex } from "../src/uploads/process.js";
import { ADMIN, HELIUS_SECRET, makeTestContext, PROGRAM_ID, randKey, randSig, truncateAll } from "./helpers.js";

// ---- SPEC contract schemas (strict: no unexpected keys) ----
const u64 = z.string().regex(/^\d+$/);
const unixSecs = z.number().int().positive();
const AdSchema = z.strictObject({
  id: z.number().int(), owner: z.string(), x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int(),
  blocks: z.array(z.number().int()).optional(),
  title: z.string(), link: z.string().url(), imageUrl: z.string().url(), payMode: z.enum(["sol", "token", "auction"]),
  usd: z.number(), createdAt: unixSecs,
});
const AuctionSchema = z.strictObject({
  status: z.enum(["active", "settled"]), blocksRemaining: z.number().int(), startedAt: unixSecs, endsAt: unixSecs,
  highestBid: u64.nullable(), highestBidder: z.string().nullable(), bidsCount: z.number().int(),
  winner: z.string().nullable(), winningLamports: u64.nullable(), adId: z.number().int().nullable(),
  bids: z.array(z.strictObject({ bidder: z.string(), lamports: u64, ts: unixSecs, sig: z.string() })),
});
const StatsSchema = z.strictObject({
  soldBlocks: z.number().int(), totalBlocks: z.literal(10_000), adsCount: z.number().int(), usdRaised: z.number(),
  lamportsRaised: u64, lamportsToTreasury: u64, lamportsToBuyback: u64, lamportsSpentBuyback: u64,
  tokensBurned: u64, tokensBurnedDirect: u64, tokensBurnedBuyback: u64, tokenSupply: u64, buybackPhase: z.enum(["live", "later"]), buybackVaultLamports: u64.nullable(), burnedPct: z.number(), tokensBurnedExternal: u64, supplyReduction: u64, supplyReductionPct: z.number(),
  solPriceUsd: z.number().nullable(), tokenPriceUsd: z.number().nullable(), marketCapUsd: z.number().nullable(),
  auction: AuctionSchema.nullable(), updatedAt: unixSecs,
});
const FeedSchema = z.array(
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("purchase"), sig: z.string(), ts: unixSecs, adId: z.number(), owner: z.string(), x: z.number(), y: z.number(),
      w: z.number(), h: z.number(), payMode: z.enum(["sol", "token"]), usd: z.number(), lamports: u64, tokensBurned: u64, finalized: z.boolean(),
      title: z.string().nullable(),
    }),
    z.strictObject({ type: z.literal("buyback"), sig: z.string(), ts: unixSecs, lamportsIn: u64, tokensBurned: u64, finalized: z.boolean() }),
    z.strictObject({ type: z.literal("bid"), sig: z.string(), ts: unixSecs, bidder: z.string(), lamports: u64, finalized: z.boolean() }),
  ]),
);
const BuybackPageSchema = z.strictObject({
  items: z.array(z.strictObject({ sig: z.string(), ts: unixSecs, lamportsIn: u64, tokensBurned: u64, finalized: z.boolean() })),
  nextCursor: z.string().nullable(),
});
const LeaderboardSchema = z.array(z.strictObject({ owner: z.string(), blocks: z.number().int(), usd: z.number(), tokensBurned: u64 }));
const QuoteSchema = z.strictObject({
  usd: z.number(), usdMicro: u64, lamports: u64.optional(), tokens: u64.optional(), solPriceUsd: z.number(),
  tokenPriceUsd: z.number().nullable(), discountBps: z.literal(1000), expiresAt: unixSecs,
  tokenPaymentStatus: z.string(), tokenPaymentDetail: z.string().nullable(),
  tokenPricedBy: z.enum(["spot", "ema", "slow_ema"]).nullable(), tokenBlocksAvailable: z.number().int().nullable(),
});
const OccupancySchema = z.strictObject({ bitmap: z.string(), soldBlocks: z.number().int() });

let t: Awaited<ReturnType<typeof makeTestContext>>;
const owner = randKey();

beforeAll(async () => {
  t = await makeTestContext({ uploadsPerMin: 3 });
  await truncateAll(t.ctx);
  const ev = (adId: number, x: number, y: number, w: number, h: number, payMode: "sol" | "token"): ProgramEvent => ({
    name: "AdPurchased", adId, ad: randKey(), owner, x, y, w, h, payMode, lamports: payMode === "sol" ? BigInt(w * h) * 666_666_667n : 0n,
    tokensBurned: payMode === "token" ? 60_000_000_000n * BigInt(w * h) : 0n, usdMicro: BigInt(w * h) * (payMode === "token" ? 90_000_000n : 100_000_000n), ts: 1_700_000_000n + BigInt(adId),
  });
  const events = [ev(0, 0, 0, 2, 2, "sol"), ev(1, 10, 10, 1, 1, "token"), ev(2, 20, 20, 3, 1, "sol")];
  for (const e of events) {
    if (e.name !== "AdPurchased") continue;
    await ingestTx(t.ctx.db, { signature: randSig(), slot: 1, finalized: true, source: "test", events: [e] });
    const png = await generatePixelArt(e.w, e.h, e.adId);
    const sha = sha256Hex(png);
    const stored = await t.ctx.localFiles.put(png, "image/png", sha);
    t.chain.ads.set(e.adId, {
      id: e.adId, owner, kind: "rect", updatedAt: e.ts, x: e.x, y: e.y, w: e.w, h: e.h, title: `Ad ${e.adId}`, link: e.adId === 2 ? "https://bit.ly/x" : `https://ad${e.adId}.example`,
      imageUri: stored.uri, imageSha256: sha, payMode: e.payMode, paidLamports: e.lamports, paidTokens: e.tokensBurned, usdMicro: e.usdMicro, createdAt: e.ts,
    });
  }
  await ingestTx(t.ctx.db, { signature: randSig(), slot: 2, finalized: true, source: "test", events: [{ name: "BuybackBurned", lamportsIn: 10n ** 9n, tokensBurned: 5n * 10n ** 11n, ts: 1_700_000_100n }] });
  // Real pipeline: hydrate from (fake) chain, then automatic checks.
  await t.ctx.moderation.tick();
});
afterAll(async () => t.ctx.handle.close());

const get = (path: string, init?: RequestInit) => t.app.request(path, init);
const auth = { Authorization: `Bearer ${ADMIN}` };

describe("API contract (SPEC shapes)", () => {
  it("moderation pipeline: hydrated, checked, blocklisted ad auto-rejected", async () => {
    const rows = await t.ctx.db.select().from(ads).orderBy(ads.id);
    expect(rows.map((r) => [r.id, r.status, r.hydrated])).toEqual([[0, "pending", true], [1, "pending", true], [2, "rejected", true]]);
    expect(rows[2]!.reason).toMatch(/blocklist/);
  });

  it("GET /api/admin/queue requires the bearer token", async () => {
    expect((await get("/api/admin/queue")).status).toBe(401);
    expect((await get("/api/admin/queue", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    const res = await get("/api/admin/queue", { headers: auth });
    expect(res.status).toBe(200);
    const q = (await res.json()) as { id: number; checks: unknown[] }[];
    expect(q.map((r) => r.id)).toEqual([0, 1]);
    expect(q[0]!.checks.length).toBeGreaterThan(5);
  });

  it("/api/ads only lists approved ads; approve via admin", async () => {
    expect(await (await get("/api/ads")).json()).toEqual([]);
    const etag0 = (await get("/api/canvas.png")).headers.get("etag");
    for (const id of [0, 1]) expect((await get(`/api/admin/ads/${id}/approve`, { method: "POST", headers: auth })).status).toBe(200);
    const list = z.array(AdSchema).parse(await (await get("/api/ads")).json());
    expect(list.map((a) => a.id)).toEqual([0, 1]);
    expect(list[0]).toMatchObject({ x: 0, y: 0, w: 2, h: 2, payMode: "sol", usd: 400, title: "Ad 0" });
    expect((await get("/api/canvas.png")).headers.get("etag")).not.toBe(etag0);
  });

  it("GET /api/ads/:id", async () => {
    AdSchema.parse(await (await get("/api/ads/1")).json());
    const rejected = await get("/api/ads/2");
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({ status: "rejected" });
    expect((await get("/api/ads/abc")).status).toBe(400);
  });

  it("GET /api/occupancy includes unapproved (sold) blocks", async () => {
    const o = OccupancySchema.parse(await (await get("/api/occupancy")).json());
    const bm = Buffer.from(o.bitmap, "base64");
    expect(bm.length).toBe(1250);
    expect(o.soldBlocks).toBe(4 + 1 + 3); // includes the rejected ad #2
    const bit = (i: number) => (bm[i >> 3]! >> (i & 7)) & 1;
    expect(bit(2020)).toBe(1); // ad 2 at (20,20)
  });

  it("GET /api/canvas.png with ETag/304", async () => {
    const res = await get("/api/canvas.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toMatch(/max-age/);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 1000]);
    const again = await get("/api/canvas.png", { headers: { "If-None-Match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  it("GET /api/stats", async () => {
    const s = StatsSchema.parse(await (await get("/api/stats")).json());
    expect(s).toMatchObject({ soldBlocks: 8, adsCount: 3, usdRaised: 790, lamportsSpentBuyback: "1000000000", tokensBurnedBuyback: "500000000000" });
    expect(BigInt(s.lamportsToTreasury) + BigInt(s.lamportsToBuyback)).toBe(BigInt(s.lamportsRaised));
    expect(BigInt(s.tokensBurned)).toBe(BigInt(s.tokensBurnedDirect) + BigInt(s.tokensBurnedBuyback));
    // Denominator = INITIAL supply (1e15); protocol and third-party burns are never merged.
    const initial = 1_000_000_000_000_000n, onchainSupply = 900_000_000_000_000n;
    expect(s.tokenSupply).toBe(onchainSupply.toString());
    expect(s.burnedPct).toBe(Number((BigInt(s.tokensBurned) * 1_000_000n) / initial) / 10_000);
    expect(s.supplyReduction).toBe((initial - onchainSupply).toString());
    expect(s.supplyReductionPct).toBe(10);
    expect(BigInt(s.tokensBurnedExternal)).toBe(initial - onchainSupply - BigInt(s.tokensBurned));
    expect(s.solPriceUsd).toBe(150);
  });

  it("GET /api/feed newest first", async () => {
    const f = FeedSchema.parse(await (await get("/api/feed?limit=50")).json());
    expect(f[0]!.type).toBe("buyback");
    expect(f.map((x) => x.ts)).toEqual([...f.map((x) => x.ts)].sort((a, b) => b - a));
    expect(FeedSchema.parse(await (await get("/api/feed?limit=2")).json())).toHaveLength(2);
  });

  it("feed purchase items carry the title only for approved ads", async () => {
    const f = FeedSchema.parse(await (await get("/api/feed?limit=50")).json());
    const byAd = new Map(f.filter((x) => x.type === "purchase").map((x) => [(x as { adId: number }).adId, (x as { title: string | null }).title]));
    expect(byAd.get(0)).toBe("Ad 0"); // approved
    expect(byAd.get(2)).toBeNull(); // auto-rejected
  });

  it("GET /api/buybacks pages with an opaque cursor", async () => {
    for (let i = 0; i < 4; i++) {
      await ingestTx(t.ctx.db, { signature: randSig(), slot: 3 + i, finalized: true, source: "test", events: [{ name: "BuybackBurned", lamportsIn: BigInt(i + 2), tokensBurned: 1n, ts: 1_700_000_200n + BigInt(i) }] });
    }
    const p1 = BuybackPageSchema.parse(await (await get("/api/buybacks?limit=2")).json());
    expect(p1.items.map((b) => b.lamportsIn)).toEqual(["5", "4"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = BuybackPageSchema.parse(await (await get(`/api/buybacks?limit=2&cursor=${p1.nextCursor}`)).json());
    expect(p2.items.map((b) => b.lamportsIn)).toEqual(["3", "2"]);
    const p3 = BuybackPageSchema.parse(await (await get(`/api/buybacks?limit=2&cursor=${p2.nextCursor}`)).json());
    expect(p3.items.map((b) => b.lamportsIn)).toEqual(["1000000000"]);
    expect(p3.nextCursor).toBeNull();
    expect((await get("/api/buybacks?cursor=garbage!!")).status).toBe(400);
  });

  it("GET /api/leaderboard", async () => {
    const lb = LeaderboardSchema.parse(await (await get("/api/leaderboard")).json());
    expect(lb).toEqual([{ owner, blocks: 5, usd: 490, tokensBurned: "60000000000" }]); // rejected ad excluded
  });

  it("GET /api/quote", async () => {
    const sol = QuoteSchema.parse(await (await get("/api/quote?w=1&h=1&mode=sol")).json());
    expect(sol).toMatchObject({ usd: 100, lamports: "666666667" });
    const tok = QuoteSchema.parse(await (await get("/api/quote?w=1&h=1&mode=token")).json());
    expect(tok.tokens).toBe("60000000000");
    expect(tok.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(59);
    expect((await get("/api/quote?w=101&h=1")).status).toBe(400);
    expect((await get("/api/quote?w=1&h=1&mode=btc")).status).toBe(400);
  });

  it("GET /api/auction", async () => {
    expect(await (await get("/api/auction")).json()).toBeNull();
  });

  it("GET /api/events streams stats then feed", async () => {
    const res = await get("/api/events");
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^event: stats\ndata: \{/);
    t.ctx.bus.emit("feed", { type: "buyback", sig: "s", ts: 1, lamportsIn: "1", tokensBurned: "1", finalized: true });
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toMatch(/event: feed/);
    await reader.cancel();
  });

  it("POST /api/uploads processes and stores the image", async () => {
    const input = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ff00ff" } }).jpeg().toBuffer();
    const fd = new FormData();
    fd.set("file", new Blob([new Uint8Array(input)], { type: "image/png" }), "lies.png"); // wrong declared type: sniffing decides
    fd.set("w", "3");
    fd.set("h", "2");
    const res = await get("/api/uploads", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const body = z.object({ uri: z.string().url(), sha256: z.string().regex(/^[0-9a-f]{64}$/), previewUrl: z.string().url() }).parse(await res.json());
    const file = await get(new URL(body.previewUrl).pathname);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(sha256Hex(bytes)).toBe(body.sha256);
    const meta = await sharp(bytes).metadata();
    expect([meta.width, meta.height]).toEqual([30, 20]);
  });

  it("POST /api/uploads rejects non-images and is rate limited", async () => {
    const fd = new FormData();
    fd.set("file", new Blob(["hello"], { type: "image/png" }), "x.png");
    fd.set("w", "1");
    fd.set("h", "1");
    expect((await get("/api/uploads", { method: "POST", body: fd })).status).toBe(415);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await get("/api/uploads", { method: "POST", body: fd })).status);
    expect(statuses).toContain(429);
  });

  it("admin reject removes the ad from /api/ads but not from occupancy", async () => {
    const res = await get("/api/admin/ads/1/reject", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ reason: "spam" }) });
    expect(await res.json()).toMatchObject({ ok: true, status: "rejected", reason: "spam" });
    expect((z.array(AdSchema).parse(await (await get("/api/ads")).json())).map((a) => a.id)).toEqual([0]);
    expect(OccupancySchema.parse(await (await get("/api/occupancy")).json()).soldBlocks).toBe(8);
    const [row] = await t.ctx.db.select().from(ads).where(eq(ads.id, 1));
    expect(row!.moderatedBy).toBe("admin");
  });

  it("POST /webhooks/helius authenticates and ingests", async () => {
    const payload = [{ signature: randSig(), slot: 5, meta: { err: null, logMessages: fakeLogs(PROGRAM_ID, [{ name: "BuybackBurned", lamportsIn: 1n, tokensBurned: 1n, ts: 1_700_000_200n }]) } }];
    const req = (h: Record<string, string>) => get("/webhooks/helius", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(payload) });
    expect((await req({})).status).toBe(401);
    expect((await req({ authorization: "nope" })).status).toBe(401);
    const ok = await req({ authorization: HELIUS_SECRET });
    expect(await ok.json()).toEqual({ ok: true, txs: 1, events: 1 });
    expect(await (await req({ authorization: HELIUS_SECRET })).json()).toEqual({ ok: true, txs: 1, events: 0 });
  });

  it("/readyz and /healthz", async () => {
    expect(await (await get("/readyz")).json()).toEqual({ ok: true });
    const h = await get("/healthz");
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true, db: true, sseClients: 0 });
  });

  it("CORS allows the web origin", async () => {
    const res = await get("/api/stats", { headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});
