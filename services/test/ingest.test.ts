import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ads, auction, buybacks, chainEvents, purchases } from "../src/db/schema.js";
import { ingestTx, rollbackSignature, finalizeSignature } from "../src/indexer/ingest.js";
import { ingestHeliusPayload } from "../src/indexer/indexer.js";
import { auctionState } from "../src/api/queries.js";
import { silentLogger } from "../src/lib/log.js";
import { fakeLogs, type ProgramEvent } from "../src/chain/events.js";
import { makeTestContext, PROGRAM_ID, randKey, randSig, truncateAll } from "./helpers.js";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeAll(async () => {
  t = await makeTestContext();
});
afterAll(async () => t.ctx.handle.close());
beforeEach(async () => truncateAll(t.ctx));

const purchase = (adId: number, x = adId % 100, y = Math.floor(adId / 100)): ProgramEvent => ({
  name: "AdPurchased", adId, ad: randKey(), owner: randKey(), x, y, w: 1, h: 1, payMode: "sol",
  lamports: 666_666_667n, tokensBurned: 0n, usdMicro: 100_000_000n, ts: 1_700_000_000n,
});
const count = async (tbl: typeof purchases | typeof ads | typeof chainEvents | typeof buybacks) =>
  (await t.ctx.db.select({ n: sql<number>`count(*)::int` }).from(tbl))[0]!.n;

describe("event ingest", () => {
  it("is idempotent by (signature, event index)", async () => {
    const sig = randSig();
    const tx = {
      signature: sig, slot: 10, finalized: true, source: "test" as const,
      events: [purchase(1), { name: "BuybackBurned", lamportsIn: 1n, tokensBurned: 2n, ts: 1n } as ProgramEvent],
    };
    const r1 = await ingestTx(t.ctx.db, tx);
    const r2 = await ingestTx(t.ctx.db, tx);
    const r3 = await Promise.all([ingestTx(t.ctx.db, tx), ingestTx(t.ctx.db, tx)]); // concurrent redelivery
    expect(r1.inserted).toBe(2);
    expect(r2).toMatchObject({ inserted: 0, skipped: 2 });
    expect(r3.every((r) => r.inserted === 0)).toBe(true);
    expect(await count(purchases)).toBe(1);
    expect(await count(buybacks)).toBe(1);
    expect(await count(ads)).toBe(1);
    expect(await count(chainEvents)).toBe(2);
  });

  it("lands new ads as pending and unhydrated", async () => {
    await ingestTx(t.ctx.db, { signature: randSig(), slot: 1, finalized: true, source: "test", events: [purchase(5)] });
    const [row] = await t.ctx.db.select().from(ads).where(eq(ads.id, 5));
    expect(row).toMatchObject({ status: "pending", hydrated: false, finalized: true, usdMicro: "100000000" });
  });

  it("upgrades provisional rows when the finalized copy arrives", async () => {
    const sig = randSig();
    const tx = { signature: sig, slot: 1, finalized: false, source: "logs" as const, events: [purchase(2)] };
    await ingestTx(t.ctx.db, tx);
    expect((await t.ctx.db.select().from(purchases))[0]!.finalized).toBe(false);
    const r = await ingestTx(t.ctx.db, { ...tx, finalized: true, source: "backfill" });
    expect(r.finalizedUpgrade).toBe(true);
    expect((await t.ctx.db.select().from(purchases))[0]!.finalized).toBe(true);
    expect((await t.ctx.db.select().from(ads))[0]!.finalized).toBe(true);
  });

  it("rolls back provisional txs dropped by a fork, never finalized ones", async () => {
    const dropped = randSig(), kept = randSig();
    await ingestTx(t.ctx.db, { signature: dropped, slot: 1, finalized: false, source: "logs", events: [purchase(3)] });
    await ingestTx(t.ctx.db, { signature: kept, slot: 1, finalized: false, source: "logs", events: [purchase(4)] });
    await finalizeSignature(t.ctx.db, kept);
    await rollbackSignature(t.ctx.db, dropped);
    await rollbackSignature(t.ctx.db, kept); // no-op: finalized
    expect((await t.ctx.db.select({ id: ads.id }).from(ads)).map((r) => r.id)).toEqual([4]);
    expect(await count(purchases)).toBe(1);
    expect(await count(chainEvents)).toBe(1);
  });

  it("applies transfers and content updates", async () => {
    await ingestTx(t.ctx.db, { signature: randSig(), slot: 1, finalized: true, source: "test", events: [purchase(9)] });
    await t.ctx.db.update(ads).set({ status: "approved", hydrated: true }).where(eq(ads.id, 9));
    const to = randKey();
    await ingestTx(t.ctx.db, {
      signature: randSig(), slot: 2, finalized: true, source: "test",
      events: [{ name: "AdTransferred", adId: 9, ad: randKey(), from: randKey(), to, ts: 2n }, { name: "AdUpdated", adId: 9, ad: randKey(), ts: 3n }],
    });
    const [row] = await t.ctx.db.select().from(ads).where(eq(ads.id, 9));
    expect(row).toMatchObject({ owner: to, status: "pending", hydrated: false });
  });

  it("ingests Helius raw webhook payloads idempotently", async () => {
    const sig = randSig();
    const payload = [{ signature: sig, slot: 77, blockTime: 1_700_000_000, meta: { err: null, logMessages: fakeLogs(PROGRAM_ID, [purchase(11)]) } }];
    const deps = { db: t.ctx.db, conn: null, programId: PROGRAM_ID, decoder: t.ctx.decoder };
    expect(await ingestHeliusPayload(payload, deps)).toEqual({ txs: 1, events: 1 });
    expect(await ingestHeliusPayload(payload, deps)).toEqual({ txs: 1, events: 0 });
    expect(await count(purchases)).toBe(1);
    // provisional until the finalized backfill confirms it
    expect((await t.ctx.db.select().from(purchases))[0]!.finalized).toBe(false);
  });

  it("tracks the final auction and creates the lot ad from AdPurchased(Auction)", async () => {
    await ingestTx(t.ctx.db, { signature: randSig(), slot: 1, finalized: true, source: "test", events: [purchase(0, 0, 0)] });
    const winner = randKey();
    await ingestTx(t.ctx.db, {
      signature: randSig(), slot: 2, finalized: true, source: "test",
      events: [
        { name: "AuctionStarted", lotBlocks: 9_999, startTs: 1_000n, endTs: 2_000n },
        { name: "AuctionBid", bidder: winner, lamports: 5n * 10n ** 9n, endTs: 2_300n, ts: 1_990n }, // anti-snipe extension
      ],
    });
    expect((await t.ctx.db.select().from(auction))[0]!.endsAt.getTime()).toBe(2_300_000);
    await ingestTx(t.ctx.db, {
      signature: randSig(), slot: 2, finalized: true, source: "test",
      events: [{ name: "AuctionBid", bidder: randKey(), lamports: 6n * 10n ** 9n, endTs: 2_300n, ts: 1_995n }],
    });
    const st = await auctionState(t.ctx.db);
    expect(st!.bids.map((b) => b.lamports)).toEqual(["6000000000", "5000000000"]); // newest first
    expect(st!.bids[1]).toMatchObject({ bidder: winner, ts: 1_990 });
    await ingestTx(t.ctx.db, {
      signature: randSig(), slot: 3, finalized: true, source: "test",
      events: [
        { name: "AdPurchased", adId: 1, ad: randKey(), owner: winner, x: 0, y: 0, w: 0, h: 0, payMode: "auction", lamports: 5n * 10n ** 9n, tokensBurned: 0n, usdMicro: 0n, ts: 2_400n },
        { name: "AuctionSettled", winner, lamports: 5n * 10n ** 9n, adId: 1, ad: randKey() },
      ],
    });
    const [row] = await t.ctx.db.select().from(ads).where(eq(ads.id, 1));
    expect(row!.payMode).toBe("auction");
    expect(row!.blocks).toHaveLength(9_999);
    expect(row!.blocks).not.toContain(0);
    expect(row).toMatchObject({ x: 0, y: 0, w: 100, h: 100 });
    expect(await count(purchases)).toBe(1); // the auction is not a fixed-price purchase
    expect((await t.ctx.db.select().from(auction))[0]).toMatchObject({ status: "settled", winner, adId: 1 });
  });
});

describe("indexer backfill", () => {
  it("never advances the cursor past a finalized tx the RPC can't return (no silent skip)", async () => {
    const { Indexer } = await import("../src/indexer/indexer.js");
    const { indexerCursor } = await import("../src/db/schema.js");
    const s1 = randSig(), s2 = randSig();
    let haveHistory = false;
    const conn = {
      // newest first, like the RPC
      getSignaturesForAddress: async () => [{ signature: s2, slot: 20, err: null, blockTime: 1 }, { signature: s1, slot: 10, err: null, blockTime: 1 }],
      getTransaction: async (sig: string) =>
        sig === s1 && !haveHistory ? null : { slot: sig === s1 ? 10 : 20, meta: { err: null, logMessages: fakeLogs(PROGRAM_ID, [purchase(sig === s1 ? 1 : 2)]) } },
      getSlot: async () => 30,
    } as never;
    const idx = new Indexer({ db: t.ctx.db, conn, programId: PROGRAM_ID, decoder: t.ctx.decoder, log: silentLogger, backfillIntervalMs: 60_000, dropAfterSecs: 180 });
    await expect(idx.backfill()).rejects.toThrow(/returned null/);
    expect(await t.ctx.db.select().from(indexerCursor)).toEqual([]); // nothing skipped, nothing advanced
    expect(await count(purchases)).toBe(0);
    haveHistory = true; // e.g. the RPC caught up / failover to a full-history node
    expect(await idx.backfill()).toBe(2);
    expect((await t.ctx.db.select().from(indexerCursor))[0]!.lastSignature).toBe(s2);
    expect(await count(purchases)).toBe(2);
  });
});

describe("indexer history fallback", () => {
  const logs = () => {
    const lines: string[] = [];
    const log = { debug() {}, info: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(m), error: (m: string) => void lines.push(m) };
    return { lines, log };
  };

  it("retries a null getTransaction once on a second provider, logs which served it, and ingests", async () => {
    const { Indexer } = await import("../src/indexer/indexer.js");
    const { indexerCursor } = await import("../src/db/schema.js");
    const s1 = randSig();
    const tx = { slot: 10, meta: { err: null, logMessages: fakeLogs(PROGRAM_ID, [purchase(1)]) } };
    const primary = {
      getSignaturesForAddress: async () => [{ signature: s1, slot: 10, err: null, blockTime: 1 }],
      getTransaction: async () => null, // primary lacks history
      getSlot: async () => 30,
    } as never;
    const asked: string[] = [];
    const fallbacks = [
      { label: "helius-devnet", conn: { getTransaction: async () => (asked.push("helius-devnet"), null), getGenesisHash: async () => "G" } as never },
      { label: "public-devnet", conn: { getTransaction: async () => (asked.push("public-devnet"), tx), getGenesisHash: async () => "G" } as never },
    ];
    const { lines, log } = logs();
    const idx = new Indexer({ db: t.ctx.db, conn: primary, programId: PROGRAM_ID, decoder: t.ctx.decoder, log, backfillIntervalMs: 60_000, dropAfterSecs: 180, historyFallbacks: fallbacks });
    expect(await idx.backfill()).toBe(1);
    expect(asked).toEqual(["helius-devnet", "public-devnet"]);
    expect(lines.some((l) => l.includes(`served by public-devnet`) && l.includes(s1))).toBe(true);
    expect((await t.ctx.db.select().from(indexerCursor))[0]!.lastSignature).toBe(s1);
    expect(await count(purchases)).toBe(1);
  });

  it("halts (no cursor advance) when no provider has the tx, naming every provider tried", async () => {
    const { Indexer } = await import("../src/indexer/indexer.js");
    const { indexerCursor } = await import("../src/db/schema.js");
    const s1 = randSig();
    const primary = { getSignaturesForAddress: async () => [{ signature: s1, slot: 10, err: null, blockTime: 1 }], getTransaction: async () => null, getSlot: async () => 30 } as never;
    const fallbacks = [{ label: "public-devnet", conn: { getTransaction: async () => null, getGenesisHash: async () => "G" } as never }];
    const idx = new Indexer({ db: t.ctx.db, conn: primary, programId: PROGRAM_ID, decoder: t.ctx.decoder, log: silentLogger, backfillIntervalMs: 60_000, dropAfterSecs: 180, historyFallbacks: fallbacks });
    await expect(idx.backfill()).rejects.toThrow(/from primary, public-devnet; not advancing the cursor/);
    expect(await t.ctx.db.select().from(indexerCursor)).toEqual([]);
  });

  it("only keeps fallbacks on the primary's cluster (genesis hash) and never offers mainnet on devnet", async () => {
    const { makeHistoryFallbacks } = await import("../src/indexer/indexer.js");
    const { loadConfig } = await import("../src/config.js");
    const dev = loadConfig({ SOLANA_CLUSTER: "devnet", SOLANA_RPC_HELIUS_KEY: "hk-123456", SOLANA_RPC: "https://x.solana-mainnet.quiknode.pro/k1234567/", RPC_URL: "https://primary.example/" });
    expect(dev.historyRpcFallbacks.map((f) => f.label)).toEqual(["helius-devnet", "public-devnet"]);
    expect(dev.historyRpcFallbacks.some((f) => /mainnet|quiknode/.test(f.url))).toBe(false);
    const main = loadConfig({ SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_HELIUS_KEY: "hk-123456", SOLANA_RPC: "https://x.solana-mainnet.quiknode.pro/k1234567/" });
    expect(main.historyRpcFallbacks.map((f) => f.label)).toEqual(["helius-mainnet", "public-mainnet"]); // quicknode is the primary
    const hashes: Record<string, string> = { "https://a/": "DEV", "https://b/": "MAIN" };
    const kept = await makeHistoryFallbacks(
      { getGenesisHash: async () => "DEV" } as never,
      [{ label: "a", url: "https://a/" }, { label: "b", url: "https://b/" }],
      silentLogger,
      (url) => ({ getGenesisHash: async () => hashes[url]!, getTransaction: async () => null }) as never,
    );
    expect(kept.map((k) => k.label)).toEqual(["a"]);
  });
});
