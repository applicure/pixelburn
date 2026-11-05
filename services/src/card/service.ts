// Share cards: which version of the card an ad is on, and rendering it without letting anyone burn the CPU.
//  - Only ever renders the ad's CURRENT moderation state, read from the row. A stale ?v= cannot bring back an old image.
//  - The cache key is (ad, version), not anything from the URL, so query strings cannot force renders. Distinct renders
//    are bounded by ads × states; a global limit bounds them in time, with single-flight per card.
import { createHash } from "node:crypto";
import type { Composer } from "../composer/composer.js";
import type { Db } from "../db/client.js";
import { occupancy } from "../api/queries.js";
import type { AdRow } from "../api/dto.js";
import { microToUsd } from "../lib/quote-math.js";
import type { Logger } from "../lib/log.js";
import { renderCard, type CardState } from "./render.js";

/** Bump when the card's look changes, so that image URLs change with it. */
const RENDER_REV = 1;
const MAX_ENTRIES = 256;
const TTL_MS = 3_600_000;
const MAX_RENDERING = 2;
const MAX_WAITING = 16;

export class CardBusy extends Error {}

export type Cluster = "devnet" | "mainnet-beta";

/** Anything not explicitly approved is treated as not public. */
export function cardState(row: Pick<AdRow, "status">): CardState {
  return row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "pending";
}

/**
 * Changes with approval state and content. It goes in the image URL, because X caches previews by URL.
 * For an unapproved ad it is derived only from public on-chain figures, so it cannot leak the hidden content.
 */
export function cardVersion(row: AdRow, cluster: Cluster): string {
  const state = cardState(row);
  const pub = [RENDER_REV, cluster, state, row.id, row.x, row.y, row.w, row.h, row.blocks?.length ?? 0, row.payMode, row.paidLamports, row.paidTokens, row.usdMicro];
  const parts = state === "approved" ? [...pub, row.title, row.imageSha256] : pub;
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

export interface RenderedCard {
  png: Buffer;
  version: string;
  /** False when the approved image could not be read: do not let anyone keep this copy. */
  complete: boolean;
}

export class CardService {
  private readonly cache = new Map<string, { at: number; canvas: number; card: RenderedCard }>();
  private readonly inflight = new Map<string, Promise<RenderedCard>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly composer: Composer,
    private readonly cluster: Cluster,
    private readonly decimals: number,
    private readonly log: Logger,
  ) {}

  version(row: AdRow) {
    return cardVersion(row, this.cluster);
  }

  /** A finished card for this exact row state, if there is one: costs no rendering. */
  cached(row: AdRow): RenderedCard | null {
    const key = `${row.id}:${this.version(row)}`;
    const hit = this.cache.get(key);
    if (!hit) return null;
    // The map shows the wall: when the wall changes (a rejected ad comes off it), older copies must not outlive it.
    if (Date.now() - hit.at > TTL_MS || hit.canvas !== this.composer.image?.version) {
      this.cache.delete(key);
      return null;
    }
    // Map order doubles as LRU
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.card;
  }

  /** Renders or joins a render in progress. Throws CardBusy when too many are queued. */
  async render(row: AdRow): Promise<RenderedCard> {
    const version = this.version(row);
    const key = `${row.id}:${version}`;
    const running = this.inflight.get(key);
    if (running) return running;
    if (this.active >= MAX_RENDERING && this.waiting.length >= MAX_WAITING) throw new CardBusy("too many cards rendering");
    const p = this.withSlot(() => this.draw(row, version)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    const card = await p;
    if (card.complete) {
      this.cache.set(key, { at: Date.now(), canvas: this.composer.image?.version ?? -1, card });
      while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    }
    return card;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_RENDERING) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async draw(row: AdRow, version: string): Promise<RenderedCard> {
    const state = cardState(row);
    let image: Buffer | null = null;
    let complete = true;
    if (state === "approved") {
      try {
        // The composer's path: on-disk cache keyed by sha256, else the allow-listed fetcher, verified against the on-chain hash.
        image = await this.composer.loadImage(row);
      } catch (e) {
        this.log.warn(`card: ad ${row.id} image unavailable: ${(e as Error).message}`);
      }
      if (!image) complete = false;
    }
    const [canvas, occ] = await Promise.all([this.composer.getImage(), occupancy(this.db)]);
    const png = await renderCard({
      state,
      id: row.id,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      blockCount: row.blocks?.length || row.w * row.h,
      payMode: row.payMode,
      usd: microToUsd(row.usdMicro),
      lamports: row.paidLamports,
      tokens: row.paidTokens,
      decimals: this.decimals,
      cluster: this.cluster,
      ...(state === "approved" ? { title: row.title, image } : {}),
      canvasPng: canvas.png,
      sold: occ.bitmap,
    });
    return { png, version, complete };
  }
}
