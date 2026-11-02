// Idempotent event ingest. One DB transaction per transaction signature.
// Idempotency key: (signature, event_index) in chain_events. Re-delivering a tx is a
// no-op, except that a `finalized` delivery upgrades provisional (`confirmed`) rows.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { NOTIFY_CHANNEL } from "../db/client.js";
import { ads, auction, auctionBids, buybacks, chainEvents, priceSnapshots, purchases } from "../db/schema.js";
import { eventToJson, type ProgramEvent } from "../chain/events.js";
import { adBlocks, blocksBoundingRect } from "../lib/blocks.js";
import { TOTAL_BLOCKS } from "../constants.js";
import type { FeedItem } from "../api/dto.js";
import { microToUsd } from "../lib/quote-math.js";

export interface TxEvents {
  signature: string;
  slot: number;
  /** Finalized = irreversible. Anything else is provisional and may be rolled back. */
  finalized: boolean;
  source: "backfill" | "logs" | "helius" | "seed" | "test";
  /** Block time fallback for events without a ts field. */
  blockTime?: number | null;
  events: ProgramEvent[];
}

export type BusMessage =
  | { kind: "feed"; item: FeedItem }
  | { kind: "stats" }
  /** Ask API processes to fully re-render the canvas (e.g. after a reseed). */
  | { kind: "canvas" }
  | { kind: "ads"; adIds: number[]; reason: "new" | "updated" | "removed" | "moderated" };

export interface IngestResult {
  inserted: number;
  skipped: number;
  finalizedUpgrade: boolean;
  messages: BusMessage[];
}

const tsDate = (ts: bigint | number | null | undefined, fallback?: number | null) =>
  new Date(Number(ts ?? fallback ?? Math.floor(Date.now() / 1000)) * 1000);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function ingestTx(db: Db, tx: TxEvents): Promise<IngestResult> {
  const result: IngestResult = { inserted: 0, skipped: 0, finalizedUpgrade: false, messages: [] };
  if (tx.events.length === 0) return result;

  await db.transaction(async (t) => {
    // Serialize concurrent deliveries of the same signature (logs + helius + backfill race).
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${tx.signature}))`);

    for (let i = 0; i < tx.events.length; i++) {
      const ev = tx.events[i]!;
      const ins = await t
        .insert(chainEvents)
        .values({
          signature: tx.signature,
          eventIndex: i,
          name: ev.name,
          slot: tx.slot,
          data: eventToJson(ev),
          finalized: tx.finalized,
          source: tx.source,
        })
        .onConflictDoNothing()
        .returning({ sig: chainEvents.signature });
      if (ins.length === 0) {
        result.skipped++;
        continue;
      }
      result.inserted++;
      await applyEvent(t, tx, i, ev, result.messages);
    }

    if (tx.finalized && result.skipped > 0) {
      const upgraded = await markFinalized(t, tx.signature);
      result.finalizedUpgrade = upgraded;
    }

    for (const m of result.messages) {
      await t.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(m)})`);
    }
  });
  return result;
}

async function applyEvent(t: Tx, tx: TxEvents, idx: number, ev: ProgramEvent, out: BusMessage[]) {
  const base = { signature: tx.signature, eventIndex: idx, slot: tx.slot, finalized: tx.finalized };
  switch (ev.name) {
    case "AdPurchased": {
      const when = tsDate(ev.ts, tx.blockTime);
      if (ev.payMode === "auction") {
        // Final-auction winner: the ad covers the lot (every block unsold when the auction
        // started). x,y,w,h are 0 on-chain; hydration replaces `blocks` with Auction.lot_bitmap.
        const sold = new Set<number>();
        for (const a of await t.select({ x: ads.x, y: ads.y, w: ads.w, h: ads.h, blocks: ads.blocks }).from(ads)) {
          for (const b of adBlocks(a)) sold.add(b);
        }
        const free: number[] = [];
        for (let b = 0; b < TOTAL_BLOCKS; b++) if (!sold.has(b)) free.push(b);
        await t
          .insert(ads)
          .values({
            id: ev.adId, address: ev.ad, owner: ev.owner, ...blocksBoundingRect(free), blocks: free, payMode: "auction",
            paidLamports: ev.lamports.toString(), createdAt: when, signature: tx.signature, finalized: tx.finalized,
            status: "pending", hydrated: false,
          })
          .onConflictDoNothing();
        out.push({ kind: "ads", adIds: [ev.adId], reason: "new" }, { kind: "stats" });
        return;
      }
      await t
        .insert(purchases)
        .values({
          ...base,
          adId: ev.adId, owner: ev.owner, x: ev.x, y: ev.y, w: ev.w, h: ev.h, payMode: ev.payMode,
          lamports: ev.lamports.toString(), tokensBurned: ev.tokensBurned.toString(), usdMicro: ev.usdMicro.toString(),
          ts: when,
        })
        .onConflictDoNothing();
      await t
        .insert(ads)
        .values({
          id: ev.adId, address: ev.ad, owner: ev.owner, x: ev.x, y: ev.y, w: ev.w, h: ev.h, payMode: ev.payMode,
          paidLamports: ev.lamports.toString(), paidTokens: ev.tokensBurned.toString(), usdMicro: ev.usdMicro.toString(),
          createdAt: when, signature: tx.signature, finalized: tx.finalized, status: "pending", hydrated: false,
        })
        .onConflictDoNothing();
      out.push({
        kind: "feed",
        item: {
          type: "purchase", sig: tx.signature, ts: Math.floor(when.getTime() / 1000), adId: ev.adId, owner: ev.owner,
          x: ev.x, y: ev.y, w: ev.w, h: ev.h, payMode: ev.payMode, usd: microToUsd(ev.usdMicro),
          lamports: ev.lamports.toString(), tokensBurned: ev.tokensBurned.toString(), finalized: tx.finalized,
          title: null, // not approved yet at purchase time
        },
      });
      out.push({ kind: "ads", adIds: [ev.adId], reason: "new" }, { kind: "stats" });
      return;
    }
    case "AdUpdated": {
      // Content changed on-chain: re-hydrate from the account and send back to moderation.
      await t
        .update(ads)
        .set({ hydrated: false, status: "pending", reason: null, checks: null, checkedAt: null, moderatedAt: null, updatedAt: new Date() })
        .where(eq(ads.id, ev.adId));
      out.push({ kind: "ads", adIds: [ev.adId], reason: "updated" });
      return;
    }
    case "AdTransferred": {
      await t.update(ads).set({ owner: ev.to, updatedAt: new Date() }).where(eq(ads.id, ev.adId));
      out.push({ kind: "ads", adIds: [ev.adId], reason: "updated" });
      return;
    }
    case "TokenPriceUpdated": {
      await t
        .insert(priceSnapshots)
        .values({
          ts: tsDate(ev.ts, tx.blockTime), source: "chain", tokenSpotSol: ev.spot.toString(), tokenEmaSol: ev.ema.toString(), tokenSlowEmaSol: ev.slowEma.toString(),
          signature: tx.signature, eventIndex: idx, finalized: tx.finalized,
        })
        .onConflictDoNothing();
      return;
    }
    case "BuybackBurned": {
      const when = tsDate(ev.ts, tx.blockTime);
      await t
        .insert(buybacks)
        .values({ ...base, lamportsIn: ev.lamportsIn.toString(), tokensBurned: ev.tokensBurned.toString(), ts: when })
        .onConflictDoNothing();
      out.push({
        kind: "feed",
        item: {
          type: "buyback", sig: tx.signature, ts: Math.floor(when.getTime() / 1000),
          lamportsIn: ev.lamportsIn.toString(), tokensBurned: ev.tokensBurned.toString(), finalized: tx.finalized,
        },
      });
      out.push({ kind: "stats" });
      return;
    }
    case "BuybackWrittenOff":
    case "BuybackReleased":
      // Recorded in chain_events only (keeper accountability); BuybackBurned carries the numbers.
      return;
    case "AuctionStarted": {
      await t
        .insert(auction)
        .values({
          id: 1, status: "active", blocksRemaining: ev.lotBlocks, startedAt: tsDate(ev.startTs), endsAt: tsDate(ev.endTs),
          startSignature: tx.signature,
        })
        .onConflictDoNothing();
      out.push({ kind: "stats" });
      return;
    }
    case "AuctionBid": {
      const when = tsDate(ev.ts, tx.blockTime);
      await t
        .insert(auctionBids)
        .values({ ...base, bidder: ev.bidder, lamports: ev.lamports.toString(), ts: when })
        .onConflictDoNothing();
      // Bids may extend the end (anti-snipe). Never move it backwards on out-of-order delivery.
      await t
        .update(auction)
        .set({ endsAt: sql`greatest(${auction.endsAt}, ${tsDate(ev.endTs).toISOString()}::timestamptz)`, updatedAt: new Date() })
        .where(eq(auction.id, 1));
      out.push({
        kind: "feed",
        item: { type: "bid", sig: tx.signature, ts: Math.floor(when.getTime() / 1000), bidder: ev.bidder, lamports: ev.lamports.toString(), finalized: tx.finalized },
      });
      out.push({ kind: "stats" });
      return;
    }
    case "AuctionResumed": {
      await t.update(auction).set({ endsAt: tsDate(ev.endTs), updatedAt: new Date() }).where(eq(auction.id, 1));
      out.push({ kind: "stats" });
      return;
    }
    case "AuctionRestarted": {
      await t.update(auction).set({ status: "active", endsAt: tsDate(ev.endTs), updatedAt: new Date() }).where(eq(auction.id, 1));
      out.push({ kind: "stats" });
      return;
    }
    case "AuctionSettled": {
      await t
        .update(auction)
        .set({ status: "settled", winner: ev.winner, winningLamports: ev.lamports.toString(), adId: ev.adId, settleSignature: tx.signature, updatedAt: new Date() })
        .where(eq(auction.id, 1));
      out.push({ kind: "stats" });
      return;
    }
  }
}

async function markFinalized(t: Tx, signature: string): Promise<boolean> {
  const r = await t
    .update(chainEvents)
    .set({ finalized: true })
    .where(and(eq(chainEvents.signature, signature), eq(chainEvents.finalized, false)))
    .returning({ s: chainEvents.signature });
  if (r.length === 0) return false;
  for (const tbl of [purchases, buybacks, auctionBids, ads, priceSnapshots] as const) {
    await t.update(tbl).set({ finalized: true }).where(eq(tbl.signature, signature));
  }
  return true;
}

/** Mark a provisional signature final (called by the finalizer when getSignatureStatuses says finalized). */
export async function finalizeSignature(db: Db, signature: string): Promise<boolean> {
  return db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${signature}))`);
    return markFinalized(t, signature);
  });
}

/**
 * Undo every effect of a provisional transaction that was dropped by a fork.
 * Finalized signatures are never rolled back.
 */
export async function rollbackSignature(db: Db, signature: string): Promise<BusMessage[]> {
  const messages: BusMessage[] = [];
  await db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${signature}))`);
    const evs = await t.select().from(chainEvents).where(eq(chainEvents.signature, signature));
    if (evs.length === 0 || evs.some((e) => e.finalized)) return;
    for (const e of evs) {
      const d = e.data as Record<string, string | number>;
      switch (e.name) {
        case "AdPurchased":
          await t.delete(purchases).where(eq(purchases.signature, signature));
          await t.delete(ads).where(and(eq(ads.id, Number(d.adId)), eq(ads.signature, signature)));
          messages.push({ kind: "ads", adIds: [Number(d.adId)], reason: "removed" }, { kind: "stats" });
          break;
        case "AdUpdated":
          // Re-hydrate from chain: the account now reflects the surviving fork.
          await t.update(ads).set({ hydrated: false, status: "pending", checks: null }).where(eq(ads.id, Number(d.adId)));
          messages.push({ kind: "ads", adIds: [Number(d.adId)], reason: "updated" });
          break;
        case "AdTransferred":
          await t.update(ads).set({ owner: String(d.from) }).where(eq(ads.id, Number(d.adId)));
          break;
        case "TokenPriceUpdated":
          await t.delete(priceSnapshots).where(eq(priceSnapshots.signature, signature));
          break;
        case "BuybackBurned":
          await t.delete(buybacks).where(eq(buybacks.signature, signature));
          messages.push({ kind: "stats" });
          break;
        case "AuctionStarted":
          await t.delete(auction).where(and(eq(auction.id, 1), eq(auction.startSignature, signature)));
          break;
        case "AuctionBid":
          await t.delete(auctionBids).where(eq(auctionBids.signature, signature));
          // endsAt extension is not reverted here; the next finalized AuctionBid/Restarted or a
          // hydrate from the Auction account corrects it (see NOTES known gaps).
          break;
        case "AuctionSettled":
          await t
            .update(auction)
            .set({ status: "active", winner: null, winningLamports: null, adId: null, settleSignature: null })
            .where(eq(auction.settleSignature, signature));
          break;
      }
    }
    await t.delete(chainEvents).where(eq(chainEvents.signature, signature));
    for (const m of messages) await t.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(m)})`);
  });
  return messages;
}
