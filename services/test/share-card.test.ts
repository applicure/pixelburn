import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { ads } from "../src/db/schema.js";
import { ingestTx } from "../src/indexer/ingest.js";
import { sha256Hex } from "../src/uploads/process.js";
import { adBox, burnFigure, compactTokens, drawableTitle } from "../src/card/render.js";
import { makeTestContext, randKey, randSig, truncateAll } from "./helpers.js";

// The ad image is one colour that appears nowhere in the brand, so "the buyer's image is in the card" is a pixel count.
const MAGENTA = { r: 255, g: 0, b: 254 };
const TITLE = "SecretTitleXYZ";
const LINK = "https://secretlink.example/landing";
const owner = randKey();

let t: Awaited<ReturnType<typeof makeTestContext>>;

async function magentaPixels(png: ArrayBuffer | Buffer) {
  const { data, info } = await sharp(Buffer.from(png as ArrayBuffer)).raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([1200, 630]);
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] === MAGENTA.r && data[i + 1] === MAGENTA.g && data[i + 2] === MAGENTA.b) n++;
  return n;
}

async function buy(id: number, x: number, y: number, w: number, h: number, payMode: "sol" | "token", title = TITLE) {
  const lamports = payMode === "sol" ? 7_812_345_678n : 0n;
  const tokensBurned = payMode === "token" ? 12_345_678_901_234n : 0n;
  const usdMicro = BigInt(w * h) * (payMode === "token" ? 90_000_000n : 100_000_000n);
  await ingestTx(t.ctx.db, {
    signature: randSig(), slot: 1, finalized: true, source: "test",
    events: [{ name: "AdPurchased", adId: id, ad: randKey(), owner, x, y, w, h, payMode, lamports, tokensBurned, usdMicro, ts: 1_700_000_000n + BigInt(id) }],
  });
  const png = await sharp({ create: { width: w * 10, height: h * 10, channels: 3, background: MAGENTA } }).png().toBuffer();
  const sha = sha256Hex(png);
  const stored = await t.ctx.localFiles.put(png, "image/png", sha);
  t.chain.ads.set(id, {
    id, owner, kind: "rect", updatedAt: 1_700_000_000n, x, y, w, h, title, link: LINK, imageUri: stored.uri, imageSha256: sha, payMode,
    paidLamports: lamports, paidTokens: tokensBurned, usdMicro, createdAt: 1_700_000_000n,
  });
  await t.ctx.moderation.tick();
  return { sha, uri: stored.uri };
}

const share = async (id: number) => (await t.app.request(`/api/ads/${id}/share`)).json() as Promise<Record<string, any>>;
const card = (id: number, v?: string, init?: RequestInit) => t.app.request(`/api/ads/${id}/card.png${v ? `?v=${v}` : ""}`, init);

beforeAll(async () => {
  t = await makeTestContext();
  await truncateAll(t.ctx);
});
afterAll(async () => t.ctx.handle.close());

describe("ad ids", () => {
  it("answers 404 for an id that does not exist", async () => {
    expect((await t.app.request("/api/ads/4242/share")).status).toBe(404);
    expect((await card(4242)).status).toBe(404);
  });
  it.each(["abc", "1e3", "0x10", "-1", "1.5", "99999999999", "2147483648"])("answers 404, not 500, for %s", async (id) => {
    expect((await t.app.request(`/api/ads/${id}/share`)).status).toBe(404);
    expect((await t.app.request(`/api/ads/${id}/card.png`)).status).toBe(404);
  });
});

describe("moderation", () => {
  let pendingVersion: string, approvedVersion: string, secrets: { sha: string; uri: string };

  it("pending: figures only, nothing of the buyer's in the JSON or the card", async () => {
    secrets = await buy(10, 40, 22, 3, 2, "sol");
    const res = await t.app.request("/api/ads/10/share");
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const s of [TITLE, LINK, secrets.sha, secrets.uri]) expect(raw).not.toContain(s);
    const dto = JSON.parse(raw);
    expect(dto).toMatchObject({ id: 10, status: "pending", ad: null, x: 40, y: 22, w: 3, h: 2, usd: 600, payMode: "sol", lamports: "7812345678", tokensBurned: "0", owner, cluster: "devnet" });
    pendingVersion = dto.cardVersion;

    const png = await card(10, pendingVersion);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(await magentaPixels(await png.arrayBuffer())).toBe(0);
  });

  it("approved: the image is in the card pixel-exact, and the version changes", async () => {
    await t.ctx.moderation.approve(10, "test");
    const dto = await share(10);
    expect(dto.status).toBe("approved");
    expect(dto.ad).toMatchObject({ title: TITLE, link: LINK });
    expect(dto.ad.imageUrl).toContain(secrets.sha);
    approvedVersion = dto.cardVersion;
    expect(approvedVersion).not.toBe(pendingVersion);
    const box = adBox(3, 2);
    expect(box).toEqual({ iw: 480, ih: 320, exact: true, wide: false }); // ×16, every source pixel a whole square
    expect(await magentaPixels(await (await card(10, approvedVersion)).arrayBuffer())).toBeGreaterThanOrEqual(box.iw * box.ih);
  });

  it("an old pending URL shows the current card, never a frozen state", async () => {
    expect(await magentaPixels(await (await card(10, pendingVersion)).arrayBuffer())).toBeGreaterThan(0);
  });

  it("revalidates with an ETag and never promises immutability", async () => {
    const res = await card(10, approvedVersion);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag")).toBe(`"${approvedVersion}"`);
    expect((await card(10, approvedVersion, { headers: { "If-None-Match": `"${approvedVersion}"` } })).status).toBe(304);
    expect((await card(10, "stale")).headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("rejected after approval: the picture comes down, even on the URL that had it", async () => {
    await t.ctx.moderation.reject(10, `blocklist: secretlink.example ${TITLE}`, "test");
    const raw = await (await t.app.request("/api/ads/10/share")).text();
    for (const s of [TITLE, LINK, secrets.sha, "blocklist"]) expect(raw).not.toContain(s);
    const dto = JSON.parse(raw);
    expect(dto).toMatchObject({ status: "rejected", ad: null });
    expect(dto.cardVersion).not.toBe(approvedVersion);
    expect(dto.cardVersion).not.toBe(pendingVersion);
    expect(await magentaPixels(await (await card(10, approvedVersion)).arrayBuffer())).toBe(0);
    expect(await magentaPixels(await (await card(10, dto.cardVersion)).arrayBuffer())).toBe(0);
  });

  it("an owner's content update goes back to pending and hides the image again", async () => {
    await buy(11, 60, 60, 2, 2, "token");
    await t.ctx.moderation.approve(11, "test");
    const before = await share(11);
    await ingestTx(t.ctx.db, { signature: randSig(), slot: 2, finalized: true, source: "test", events: [{ name: "AdUpdated", adId: 11, ad: randKey(), ts: 1_700_000_100n }] });
    const after = await share(11);
    expect(after).toMatchObject({ status: "pending", ad: null });
    expect(after.cardVersion).not.toBe(before.cardVersion);
    // token figures survive moderation: they are public on-chain data
    expect(after.tokensBurned).toBe("12345678901234");
    await t.ctx.composer.rebuild();
    expect(await magentaPixels(await (await card(11)).arrayBuffer())).toBe(0);
  });
});

describe("images come only through the validated path", () => {
  it("never fetches a URI off the allow-list; the card still renders and is not cacheable", async () => {
    await buy(20, 80, 80, 2, 2, "sol");
    const uri = "https://169.254.169.254/latest/meta-data";
    await t.ctx.db.update(ads).set({ imageUri: uri, imageSha256: "ab".repeat(32) }).where(eq(ads.id, 20));
    const [row] = await t.ctx.db.update(ads).set({ status: "approved" }).where(eq(ads.id, 20)).returning();
    expect(row!.status).toBe("approved");
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await card(20);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await t.ctx.db.update(ads).set({ status: "pending" }).where(eq(ads.id, 20));
  });

  it("markup in a title is drawn as outlines, not parsed", async () => {
    const evil = `</svg><image href="https://evil.example/x"/>`;
    await buy(21, 90, 90, 2, 2, "sol", evil);
    await t.ctx.moderation.approve(21, "test");
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await card(21);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(await magentaPixels(await res.arrayBuffer())).toBeGreaterThan(0);
  });
});

describe("cost", () => {
  it("limits renders per client but not views of a finished card, and query strings do not force renders", async () => {
    const lim = await makeTestContext({ cardRendersPerMin: 1 });
    const get = (id: number, q = "") => lim.app.request(`/api/ads/${id}/card.png${q}`);
    expect((await get(10)).status).toBe(200); // the single allowed render
    for (let i = 0; i < 5; i++) expect((await get(10, `?v=bust${i}`)).status).toBe(200);
    const second = await get(11);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    await lim.ctx.handle.close();
  });
});

describe("figures", () => {
  const base = { usd: 1200, lamports: "7812345678", tokens: "0", decimals: 6 };
  it("SOL: half goes to buyback, and nothing says burned", () => {
    const b = burnFigure({ ...base, payMode: "sol" });
    expect(b.figure).toBe("$600");
    expect(`${b.label} ${b.sub}`).toMatch(/half of 7\.81 SOL/);
    expect(b.label).not.toMatch(/\bBURNED\b/i);
  });
  it("token: the amount from the transaction", () => {
    expect(burnFigure({ ...base, payMode: "token", tokens: "12345678901234" })).toMatchObject({ label: "$PXL BURNED", figure: "12.35M" });
    expect(compactTokens("812345000000", 6)).toBe("812,345");
    expect(compactTokens("1234567890000000", 6)).toBe("1.23B");
    expect(compactTokens("500000", 6)).toBe("0.50");
  });
  it("whole-number scale up, even for the extremes", () => {
    for (const [w, h] of [[1, 1], [2, 2], [8, 8], [20, 4], [3, 16], [40, 40]] as const) {
      const b = adBox(w, h);
      expect(b.exact).toBe(true);
      expect(b.iw % (w * 10)).toBe(0);
      expect(b.ih % (h * 10)).toBe(0);
    }
    expect(adBox(100, 100)).toMatchObject({ iw: 490, ih: 490, exact: false });
    expect(adBox(100, 1).wide).toBe(true);
  });
  it("a title the fonts cannot draw falls back to the ad number", () => {
    expect(drawableTitle("Café Müller", 3)).toBe("Café Müller");
    expect(drawableTitle("日本語のタイトル", 3)).toBe("Ad #3");
    expect(drawableTitle("Rocket 🚀 Labs", 3)).toBe("Rocket Labs");
    expect(drawableTitle(undefined, 3)).toBe("Ad #3");
  });
});
