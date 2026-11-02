// Renders the 1000×1000 canvas from approved ads. Keeps the raw RGBA canvas in memory,
// composites newly approved ads onto it incrementally, and re-encodes PNG once per change.
// Full rebuild on startup and whenever an approved ad leaves the canvas (reject/update).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ads } from "../db/schema.js";
import { BLOCK_PX, CANVAS_PX, GRID } from "../constants.js";
import { blocksBoundingRect } from "../lib/blocks.js";
import { sha256Hex } from "../uploads/process.js";
import type { ImageFetcher } from "../moderation/checks.js";
import type { Logger } from "../lib/log.js";
import type { AdRow } from "../api/dto.js";

export interface CanvasImage {
  png: Buffer;
  etag: string;
  version: number;
  updatedAt: Date;
}

export class Composer {
  private raw: Buffer | null = null;
  private current: CanvasImage | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private version = 0;
  private included = new Set<number>();

  constructor(
    private readonly db: Db,
    private readonly fetcher: ImageFetcher,
    private readonly resolveImageUrl: (uri: string) => string,
    private readonly cacheDir: string,
    private readonly log: Logger,
  ) {}

  /** Serialize all mutations. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  get image(): CanvasImage | null {
    return this.current;
  }

  async getImage(): Promise<CanvasImage> {
    if (!this.current) await this.rebuild();
    return this.current!;
  }

  has(adId: number) {
    return this.included.has(adId);
  }

  rebuild(): Promise<CanvasImage> {
    return this.enqueue(() => this.doRebuild());
  }

  private async doRebuild(): Promise<CanvasImage> {
    {
      const rows = await this.db.select().from(ads).where(eq(ads.status, "approved")).orderBy(asc(ads.id));
      this.raw = Buffer.alloc(CANVAS_PX * CANVAS_PX * 4); // transparent
      this.included.clear();
      const layers = await this.layersFor(rows);
      if (layers.length) {
        // sharp composites sequentially; chunk to keep memory bounded.
        for (let i = 0; i < layers.length; i += 200) {
          this.raw = await sharp(this.raw, { raw: { width: CANVAS_PX, height: CANVAS_PX, channels: 4 } })
            .composite(layers.slice(i, i + 200))
            .raw()
            .toBuffer();
        }
      }
      return this.encode();
    }
  }

  /** Composite one newly approved ad onto the cached canvas. */
  addAd(row: AdRow): Promise<CanvasImage> {
    return this.enqueue(async () => {
      if (!this.raw) return this.doRebuild();
      if (this.included.has(row.id)) return this.current!;
      const layers = await this.layersFor([row]);
      if (layers.length) {
        this.raw = await sharp(this.raw, { raw: { width: CANVAS_PX, height: CANVAS_PX, channels: 4 } })
          .composite(layers)
          .raw()
          .toBuffer();
      }
      return this.encode();
    });
  }

  private async encode(): Promise<CanvasImage> {
    const png = await sharp(this.raw!, { raw: { width: CANVAS_PX, height: CANVAS_PX, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    this.version++;
    const etag = `"${createHash("sha1").update(png).digest("hex").slice(0, 20)}"`;
    this.current = { png, etag, version: this.version, updatedAt: new Date() };
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(path.join(this.cacheDir, "canvas.png"), png).catch(() => {});
    return this.current;
  }

  private async layersFor(rows: AdRow[]): Promise<OverlayOptions[]> {
    const out: OverlayOptions[] = [];
    for (const row of rows) {
      try {
        const img = await this.loadImage(row);
        if (!img) continue;
        if (row.blocks && row.blocks.length) {
          // Non-rectangular (final auction) ad: paste only the owned blocks.
          const bbox = blocksBoundingRect(row.blocks);
          const fitted = await sharp(img).resize(bbox.w * BLOCK_PX, bbox.h * BLOCK_PX, { fit: "fill" }).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
          for (const b of row.blocks) {
            const bx = b % GRID, by = Math.floor(b / GRID);
            const tile = await sharp(fitted.data, { raw: { width: fitted.info.width, height: fitted.info.height, channels: 4 } })
              .extract({ left: (bx - bbox.x) * BLOCK_PX, top: (by - bbox.y) * BLOCK_PX, width: BLOCK_PX, height: BLOCK_PX })
              .png()
              .toBuffer();
            out.push({ input: tile, left: bx * BLOCK_PX, top: by * BLOCK_PX });
          }
        } else {
          // Images are validated to exact size by moderation; resize defensively anyway.
          const fitted = await sharp(img).resize(row.w * BLOCK_PX, row.h * BLOCK_PX, { fit: "fill" }).png().toBuffer();
          out.push({ input: fitted, left: row.x * BLOCK_PX, top: row.y * BLOCK_PX });
        }
        this.included.add(row.id);
      } catch (e) {
        this.log.warn(`composer: skipping ad ${row.id}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** Image bytes for an ad, from the on-disk cache (keyed by sha256) or fetched + verified. */
  private async loadImage(row: AdRow): Promise<Buffer | null> {
    if (!row.imageUri || !row.imageSha256) return null;
    const file = path.join(this.cacheDir, "images", `${row.imageSha256}`);
    const cached = await readFile(file).catch(() => null);
    if (cached) return cached;
    const bytes = await this.fetcher.fetch(this.resolveImageUrl(row.imageUri), 5 * 1024 * 1024);
    if (sha256Hex(bytes) !== row.imageSha256) throw new Error("sha256 mismatch");
    await this.cacheImage(row.imageSha256, bytes);
    return bytes;
  }

  async cacheImage(sha: string, bytes: Buffer) {
    await mkdir(path.join(this.cacheDir, "images"), { recursive: true });
    await writeFile(path.join(this.cacheDir, "images", sha), bytes);
  }
}
