import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { processUpload, sha256Hex, UploadError } from "../src/uploads/process.js";
import { ads } from "../src/db/schema.js";
import { ingestTx } from "../src/indexer/ingest.js";
import { makeTestContext, randKey, randSig, truncateAll } from "./helpers.js";

const solid = (w: number, h: number, rgb: [number, number, number], fmt: "png" | "jpeg" = "png") =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })[fmt]().toBuffer();

describe("upload processing", () => {
  it("resizes/crops to exactly w*10 x h*10 and hashes the final bytes", async () => {
    const input = await solid(333, 517, [10, 200, 30], "jpeg");
    const out = await processUpload(input, 4, 2);
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([40, 20, "png"]);
    expect(out.sha256).toBe(sha256Hex(out.bytes));
    const webp = await processUpload(input, 1, 3, "webp");
    expect((await sharp(webp.bytes).metadata()).format).toBe("webp");
  });

  it("sniffs content, not the extension", async () => {
    await expect(processUpload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), 1, 1)).rejects.toThrow(UploadError);
    await expect(processUpload(Buffer.from("not an image at all"), 1, 1)).rejects.toThrow(/unsupported file type/);
  });

  it("rejects files over 5MB and bad dimensions", async () => {
    await expect(processUpload(Buffer.alloc(5 * 1024 * 1024 + 1), 1, 1)).rejects.toMatchObject({ status: 413 });
    await expect(processUpload(await solid(10, 10, [0, 0, 0]), 0, 1)).rejects.toThrow(/1..100/);
    await expect(processUpload(await solid(10, 10, [0, 0, 0]), 101, 1)).rejects.toThrow(/1..100/);
  });
});

describe("composer", () => {
  let t: Awaited<ReturnType<typeof makeTestContext>>;
  beforeAll(async () => {
    t = await makeTestContext();
  });
  afterAll(async () => t.ctx.handle.close());
  beforeEach(async () => truncateAll(t.ctx));

  async function addAd(id: number, x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
    const png = await solid(w * 10, h * 10, rgb);
    const sha = sha256Hex(png);
    const stored = await t.ctx.localFiles.put(png, "image/png", sha);
    await ingestTx(t.ctx.db, {
      signature: randSig(), slot: 1, finalized: true, source: "test",
      events: [{ name: "AdPurchased", adId: id, ad: randKey(), owner: randKey(), x, y, w, h, payMode: "sol", lamports: 1n, tokensBurned: 0n, usdMicro: 1n, ts: 1n }],
    });
    await t.ctx.db.update(ads).set({ title: "t", link: "https://a.example", imageUri: stored.uri, imageSha256: sha, hydrated: true }).where(eq(ads.id, id));
  }
  const px = async (png: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [...data.subarray(i, i + 4)];
  };

  it("renders a 1000x1000 PNG with approved ads only", async () => {
    await addAd(1, 0, 0, 2, 2, [255, 0, 0]);
    await addAd(2, 50, 50, 1, 1, [0, 0, 255]);
    await t.ctx.moderation.approve(1, "test");
    const img = await t.ctx.composer.rebuild();
    const meta = await sharp(img.png).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1000, 1000, "png"]);
    expect(await px(img.png, 5, 15)).toEqual([255, 0, 0, 255]);
    expect((await px(img.png, 505, 505))[3]).toBe(0); // ad 2 pending -> transparent
  });

  it("incremental approval matches a full rebuild and changes the ETag", async () => {
    await addAd(1, 0, 0, 2, 2, [255, 0, 0]);
    await addAd(2, 10, 20, 3, 1, [0, 255, 0]);
    await t.ctx.moderation.approve(1, "test");
    const before = await t.ctx.composer.rebuild();
    await t.ctx.moderation.approve(2, "test"); // incremental composite
    const inc = t.ctx.composer.image!;
    expect(inc.etag).not.toBe(before.etag);
    expect(await px(inc.png, 115, 205)).toEqual([0, 255, 0, 255]);
    const full = await t.ctx.composer.rebuild();
    expect(full.etag).toBe(inc.etag);
  });

  it("removes an ad on reject (full rebuild)", async () => {
    await addAd(1, 0, 0, 1, 1, [255, 0, 0]);
    await t.ctx.moderation.approve(1, "test");
    await t.ctx.moderation.reject(1, "nope", "test");
    expect((await px(t.ctx.composer.image!.png, 5, 5))[3]).toBe(0);
  });
});
