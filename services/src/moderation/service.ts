import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { NOTIFY_CHANNEL } from "../db/client.js";
import { ads } from "../db/schema.js";
import type { ChainReader } from "../chain/accounts.js";
import type { Composer } from "../composer/composer.js";
import type { Logger } from "../lib/log.js";
import { runChecks, type CheckDeps } from "./checks.js";
import { blocksBoundingRect } from "../lib/blocks.js";

export interface ModerationDeps {
  db: Db;
  chain: ChainReader | null;
  composer: Composer;
  checks: CheckDeps;
  autoApprove: boolean;
  log: Logger;
}

/**
 * Off-chain moderation pipeline. Never touches the chain: rejecting only hides an ad
 * from /api/ads and the composed canvas. Occupancy still counts it (sold is sold).
 */
export class ModerationService {
  private running = false;
  constructor(private readonly d: ModerationDeps) {}

  /** Load title/link/image from the Ad account for rows created from events. */
  async hydrate(limit = 25): Promise<number> {
    if (!this.d.chain) return 0;
    const rows = await this.d.db.select().from(ads).where(eq(ads.hydrated, false)).orderBy(asc(ads.id)).limit(limit);
    let n = 0;
    for (const row of rows) {
      try {
        const acc = await this.d.chain.fetchAd(row);
        if (!acc) continue; // not visible yet at this commitment; retry next tick
        // Auction-lot ads: the authoritative block set is Auction.lot_bitmap on-chain.
        let lot: { blocks: number[]; x: number; y: number; w: number; h: number } | null = null;
        if (acc.kind === "auctionLot" && this.d.chain.fetchAuctionLotBlocks) {
          const blocks = await this.d.chain.fetchAuctionLotBlocks();
          if (blocks && blocks.length) lot = { blocks, ...blocksBoundingRect(blocks) };
        }
        await this.d.db
          .update(ads)
          .set({
            title: acc.title, link: acc.link, imageUri: acc.imageUri, imageSha256: acc.imageSha256, owner: acc.owner,
            ...(lot ?? {}),
            hydrated: true, checks: null, checkedAt: null, updatedAt: new Date(),
          })
          .where(eq(ads.id, row.id));
        n++;
      } catch (e) {
        this.d.log.warn(`hydrate ad ${row.id}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /** Run automatic checks on hydrated, pending, unchecked ads. */
  async checkPending(limit = 25): Promise<number> {
    const rows = await this.d.db
      .select()
      .from(ads)
      .where(and(eq(ads.status, "pending"), eq(ads.hydrated, true), isNull(ads.checkedAt)))
      .orderBy(asc(ads.id))
      .limit(limit);
    for (const row of rows) {
      const out = await runChecks(row, this.d.checks);
      if (out.image && !out.reject) await this.d.composer.cacheImage(row.imageSha256, out.image);
      const now = new Date();
      if (out.reject) {
        await this.d.db
          .update(ads)
          .set({ status: "rejected", reason: out.reason, checks: out.results, checkedAt: now, moderatedAt: now, moderatedBy: "auto", updatedAt: now })
          .where(eq(ads.id, row.id));
        this.d.log.info(`ad ${row.id} auto-rejected: ${out.reason}`);
      } else if (out.retry) {
        // Leave checkedAt null so it is retried; record the latest results for the admin queue.
        await this.d.db.update(ads).set({ checks: out.results, updatedAt: now }).where(eq(ads.id, row.id));
      } else if (this.d.autoApprove) {
        await this.d.db.update(ads).set({ checks: out.results, checkedAt: now, updatedAt: now }).where(eq(ads.id, row.id));
        await this.approve(row.id, "auto");
      } else {
        await this.d.db.update(ads).set({ checks: out.results, checkedAt: now, updatedAt: now }).where(eq(ads.id, row.id));
      }
    }
    return rows.length;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.hydrate();
      await this.checkPending();
    } catch (e) {
      this.d.log.error("moderation tick", e);
    } finally {
      this.running = false;
    }
  }

  async approve(id: number, by: string) {
    const now = new Date();
    const [row] = await this.d.db
      .update(ads)
      .set({ status: "approved", reason: null, moderatedAt: now, moderatedBy: by, updatedAt: now })
      .where(and(eq(ads.id, id), eq(ads.hydrated, true)))
      .returning();
    if (!row) return null;
    await this.d.composer.addAd(row);
    await this.notify(id);
    return row;
  }

  async reject(id: number, reason: string, by: string) {
    const now = new Date();
    const [prev] = await this.d.db.select({ status: ads.status }).from(ads).where(eq(ads.id, id));
    if (!prev) return null;
    const [row] = await this.d.db
      .update(ads)
      .set({ status: "rejected", reason, moderatedAt: now, moderatedBy: by, updatedAt: now })
      .where(eq(ads.id, id))
      .returning();
    if (prev.status === "approved" || this.d.composer.has(id)) await this.d.composer.rebuild();
    await this.notify(id);
    return row ?? null;
  }

  private async notify(id: number) {
    await this.d.db.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify({ kind: "ads", adIds: [id], reason: "moderated" })})`);
  }
}
