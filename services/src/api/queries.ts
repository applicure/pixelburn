import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ads, auction, auctionBids, buybacks } from "../db/schema.js";
import { adBlocks, countBits, emptyBitmap, setBlock } from "../lib/blocks.js";
import { TOTAL_BLOCKS, TREASURY_BPS, BPS_DENOM } from "../constants.js";
import { microToUsd, tokenUsdPerToken } from "../lib/quote-math.js";
import { buyPriceQ as sdkBuyPriceQ } from "@mpb/sdk";
import type { SolPriceSource, TokenPriceSource } from "../pricing/prices.js";
import { unix, type AuctionDto, type BuybackDto, type FeedItem, type StatsDto } from "./dto.js";

/** Sold blocks from every ad we know about, any moderation status (sold is sold). */
export async function occupancy(db: Db): Promise<{ bitmap: Uint8Array; soldBlocks: number }> {
  const rows = await db.select({ x: ads.x, y: ads.y, w: ads.w, h: ads.h, blocks: ads.blocks }).from(ads);
  const bm = emptyBitmap();
  for (const r of rows) for (const b of adBlocks(r)) setBlock(bm, b);
  return { bitmap: bm, soldBlocks: countBits(bm) };
}

export async function auctionState(db: Db): Promise<AuctionDto | null> {
  const [a] = await db.select().from(auction).where(eq(auction.id, 1));
  if (!a) return null;
  const [top] = await db
    .select({ bidder: auctionBids.bidder, lamports: auctionBids.lamports })
    .from(auctionBids)
    .orderBy(sql`${auctionBids.lamports} desc`, asc(auctionBids.ts))
    .limit(1);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(auctionBids);
  const bidRows = await db
    .select({ bidder: auctionBids.bidder, lamports: auctionBids.lamports, ts: auctionBids.ts, sig: auctionBids.signature })
    .from(auctionBids)
    .orderBy(desc(auctionBids.ts), desc(auctionBids.id))
    .limit(200);
  return {
    status: a.status,
    blocksRemaining: a.blocksRemaining,
    startedAt: unix(a.startedAt),
    endsAt: unix(a.endsAt),
    highestBid: top?.lamports ?? null,
    highestBidder: top?.bidder ?? null,
    bidsCount: n,
    winner: a.winner,
    winningLamports: a.winningLamports,
    adId: a.adId,
    bids: bidRows.map((b) => ({ bidder: b.bidder, lamports: b.lamports, ts: unix(b.ts), sig: b.sig })),
  };
}

export async function feed(db: Db, limit: number): Promise<FeedItem[]> {
  const rows = await db.execute<{
    type: "purchase" | "buyback" | "bid";
    sig: string;
    ts: Date;
    finalized: boolean;
    ad_id: number | null;
    owner: string | null;
    x: number | null;
    y: number | null;
    w: number | null;
    h: number | null;
    pay_mode: "sol" | "token" | null;
    usd_micro: string | null;
    lamports: string | null;
    tokens_burned: string | null;
    title: string | null;
  }>(sql`
    (select 'purchase' as type, p.signature as sig, p.ts, p.finalized, p.ad_id, p.owner, p.x, p.y, p.w, p.h, p.pay_mode,
            p.usd_micro::text, p.lamports::text, p.tokens_burned::text,
            case when a.status = 'approved' then a.title else null end as title
       from purchases p left join ads a on a.id = p.ad_id
      order by p.ts desc, p.id desc limit ${limit})
    union all
    (select 'buyback', signature, ts, finalized, null, null, null, null, null, null, null, null, lamports_in::text, tokens_burned::text, null
       from buybacks order by ts desc, id desc limit ${limit})
    union all
    (select 'bid', signature, ts, finalized, null, bidder, null, null, null, null, null, null, lamports::text, null, null
       from auction_bids order by ts desc, id desc limit ${limit})
    order by ts desc, sig desc
    limit ${limit}`);
  return rows.map((r): FeedItem => {
    const ts = unix(new Date(r.ts));
    if (r.type === "purchase")
      return {
        type: "purchase", sig: r.sig, ts, adId: r.ad_id!, owner: r.owner!, x: r.x!, y: r.y!, w: r.w!, h: r.h!,
        payMode: r.pay_mode!, usd: microToUsd(r.usd_micro!), lamports: r.lamports!, tokensBurned: r.tokens_burned!, finalized: r.finalized,
        title: r.title,
      };
    if (r.type === "buyback") return { type: "buyback", sig: r.sig, ts, lamportsIn: r.lamports!, tokensBurned: r.tokens_burned!, finalized: r.finalized };
    return { type: "bid", sig: r.sig, ts, bidder: r.owner!, lamports: r.lamports!, finalized: r.finalized };
  });
}

export async function leaderboard(db: Db, limit = 100) {
  const rows = await db
    .select({
      owner: ads.owner,
      blocks: sql<number>`sum(coalesce(cardinality(${ads.blocks}), 0) + case when ${ads.blocks} is null then ${ads.w} * ${ads.h} else 0 end)::int`,
      usdMicro: sql<string>`sum(${ads.usdMicro})::text`,
      tokensBurned: sql<string>`sum(${ads.paidTokens})::text`,
    })
    .from(ads)
    .where(ne(ads.status, "rejected"))
    .groupBy(ads.owner)
    .orderBy(sql`sum(${ads.usdMicro}) desc`, sql`2 desc`, ads.owner)
    .limit(limit);
  return rows.map((r) => ({ owner: r.owner, blocks: r.blocks, usd: microToUsd(r.usdMicro), tokensBurned: r.tokensBurned }));
}

export interface StatsDeps {
  db: Db;
  sol: SolPriceSource;
  token: TokenPriceSource;
  decimals: number;
  /** current on-chain supply (base units), or null when no mint is configured */
  tokenSupply: () => Promise<bigint | null>;
  buybackPhase?: () => Promise<"live" | "later" | null>;
  buybackVaultLamports?: () => Promise<bigint | null>;
  cluster?: string;
  staticInitialSupply: bigint;
}

export async function computeStats(d: StatsDeps): Promise<StatsDto> {
  const { db } = d;
  const [agg] = await db.execute<{
    usd_micro: string;
    lamports_sol: string;
    lamports_treasury: string;
    tokens_direct: string;
  }>(sql`
    select coalesce(sum(usd_micro), 0)::text as usd_micro,
           coalesce(sum(lamports) filter (where pay_mode = 'sol'), 0)::text as lamports_sol,
           coalesce(sum(floor(lamports * ${TREASURY_BPS.toString()}::numeric / ${BPS_DENOM.toString()}::numeric)) filter (where pay_mode = 'sol'), 0)::text as lamports_treasury,
           coalesce(sum(tokens_burned), 0)::text as tokens_direct
      from purchases`);
  const [bb] = await db.execute<{ spent: string; burned: string }>(
    sql`select coalesce(sum(lamports_in), 0)::text as spent, coalesce(sum(tokens_burned), 0)::text as burned from buybacks`,
  );
  const [{ n: adsCount } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(ads);
  const occ = await occupancy(db);
  const auc = await auctionState(db);

  const auctionLamports = BigInt(auc?.status === "settled" ? (auc.winningLamports ?? "0") : "0");
  const lamportsSol = BigInt(agg!.lamports_sol);
  const toTreasury = BigInt(agg!.lamports_treasury);
  const tokensDirect = BigInt(agg!.tokens_direct);
  const tokensBuyback = BigInt(bb!.burned);
  const burned = tokensDirect + tokensBuyback;

  // Denominator is the token's INITIAL supply (TOKEN_INITIAL_SUPPLY, pump.fun: 1e9 tokens = 1e15 base
  // units). Protocol burns and third-party burns are never merged: burnedPct is protocol-only;
  // supplyReduction(Pct) is the total drop from the initial supply, whoever burned.
  const initial = d.staticInitialSupply;
  const onchain = await d.tokenSupply().catch(() => null);
  const supply = onchain !== null ? onchain : initial > burned ? initial - burned : 0n;
  const supplyReduction = initial > supply ? initial - supply : 0n;
  const pctOf = (x: bigint) => (initial > 0n ? Number((x * 1_000_000n) / initial) / 10_000 : 0);

  const sol = await d.sol.get().catch(() => null);
  let tokenPriceUsd: number | null = null;
  if (sol) {
    const t = await d.token.get().catch(() => null);
    // Same price token buyers are charged: min(spot, fast EMA, slow EMA).
    if (t && t.ema > 0n) tokenPriceUsd = tokenUsdPerToken(sdkBuyPriceQ(t.spot, t.ema, t.slow ?? t.ema), sol.price, d.decimals);
  }
  // Never fails stats: an unreadable phase falls back to what the cluster implies, an unreadable vault to null.
  const phase = (await d.buybackPhase?.().catch(() => null)) ?? (d.cluster === "mainnet-beta" ? "later" : "live");
  const vault = (await d.buybackVaultLamports?.().catch(() => null)) ?? null;
  const marketCapUsd = tokenPriceUsd !== null ? (tokenPriceUsd * Number(supply)) / 10 ** d.decimals : null;

  return {
    soldBlocks: occ.soldBlocks,
    totalBlocks: TOTAL_BLOCKS,
    adsCount,
    usdRaised: microToUsd(agg!.usd_micro),
    lamportsRaised: (lamportsSol + auctionLamports).toString(),
    lamportsToTreasury: toTreasury.toString(),
    lamportsToBuyback: (lamportsSol - toTreasury + auctionLamports).toString(),
    lamportsSpentBuyback: bb!.spent,
    tokensBurned: burned.toString(),
    tokensBurnedDirect: tokensDirect.toString(),
    tokensBurnedBuyback: tokensBuyback.toString(),
    tokenSupply: supply.toString(),
    burnedPct: pctOf(burned),
    tokensBurnedExternal: (supplyReduction > burned ? supplyReduction - burned : 0n).toString(),
    supplyReduction: supplyReduction.toString(),
    supplyReductionPct: pctOf(supplyReduction),
    solPriceUsd: sol?.price ?? null,
    tokenPriceUsd,
    marketCapUsd,
    buybackPhase: phase,
    buybackVaultLamports: vault === null ? null : vault.toString(),
    auction: auc,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Opaque keyset cursor over (ts desc, id desc). */
export const encodeCursor = (ts: Date, id: number) => Buffer.from(`${ts.getTime()}:${id}`).toString("base64url");
export function decodeCursor(c: string): { ts: Date; id: number } | null {
  const m = /^(\d+):(\d+)$/.exec(Buffer.from(c, "base64url").toString());
  return m ? { ts: new Date(Number(m[1])), id: Number(m[2]) } : null;
}

export async function buybackPage(db: Db, limit: number, cursor: { ts: Date; id: number } | null) {
  const rows = await db
    .select()
    .from(buybacks)
    .where(cursor ? or(lt(buybacks.ts, cursor.ts), and(eq(buybacks.ts, cursor.ts), lt(buybacks.id, cursor.id))) : undefined)
    .orderBy(desc(buybacks.ts), desc(buybacks.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r): BuybackDto => ({ sig: r.signature, ts: unix(r.ts), lamportsIn: r.lamportsIn, tokensBurned: r.tokensBurned, finalized: r.finalized })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.ts, last.id) : null,
  };
}
