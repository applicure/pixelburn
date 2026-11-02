/**
 * Deterministic mock of the Services API (used when NEXT_PUBLIC_API_URL is unset).
 * All brands, owners and amounts below are synthetic demo data.
 */
import { mulberry32 } from "./adArt";
import {
  AUCTION_THRESHOLD_BLOCKS,
  GRID,
  LAMPORTS_PER_SOL,
  PRICE_PER_BLOCK_USD,
  TOKEN_DECIMALS,
  TOKEN_DISCOUNT_BPS,
  TOTAL_BLOCKS,
  TREASURY_BPS,
  QUOTE_TTL_MS,
} from "./config";
import { bitGet, bitSet, bytesToBase64, isRectFree, quoteLamports, quoteTokens, quoteUsd, rectBlocks } from "./quote";
import type { Ad, AuctionState, FeedItem, LeaderRow, Occupancy, PayMode, Quote, Rect, Stats, UploadResult } from "./types";

const SEED = 20260111;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TOKEN_SUPPLY = 1_000_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
const DAY = 86_400_000;

const A = ["Degen", "Solar", "Moon", "Pixel", "Hyper", "Lazy", "Neon", "Turbo", "Quiet", "Based", "Gm", "Rug-Proof", "Tiny", "Mega", "Cosmic", "Retro", "Jelly", "Frog", "Bonk", "Laser", "Copper", "Velvet", "Static", "Ghost", "Orbit", "Mint", "Pizza", "Arcade", "Cactus", "Honey"];
const B = ["Pizza", "Cats", "Labs", "DAO", "Club", "Radio", "Garage", "Pickles", "Studio", "Market", "Wizards", "Dogs", "Club", "Records", "Bakery", "Hotel", "Pass", "Mart", "Arcade", "Atlas", "Bank", "Shop", "Grill", "Kids", "Supply", "Rangers", "Collective", "Express", "Coffee", "Fund"];
const TLD = ["xyz", "fun", "io", "app", "sol", "club", "gg", "art"];

function base58(rand: () => number, n = 44) {
  let s = "";
  for (let i = 0; i < n; i++) s += B58[Math.floor(rand() * B58.length)];
  return s;
}

type Listener = { feed?: (f: FeedItem) => void; stats?: (s: Stats) => void };

interface BuybackRec {
  sig: string;
  ts: number;
  lamportsIn: bigint;
  tokensBurned: bigint;
}

interface AdRec extends Ad {
  lamports: bigint;
  tokens: bigint;
}

class MockWorld {
  rand = mulberry32(SEED);
  ads: AdRec[] = [];
  bitmap = new Uint8Array(1250);
  owners: string[] = [];
  buybacks: BuybackRec[] = [];
  bids: { bidder: string; lamports: bigint; ts: number }[] = [];
  solUsd = 182.4;
  tokenUsd = 0.00418;
  listeners = new Set<Listener>();
  timers: ReturnType<typeof setTimeout>[] = [];
  uploads = new Map<string, string>();
  started = false;

  constructor() {
    const r = this.rand;
    for (let i = 0; i < 520; i++) this.owners.push(base58(r));
    this.seedAds();
    this.seedBuybacks();
  }

  pickOwner() {
    // Zipf-ish: a few whales own many ads
    const u = this.rand();
    return this.owners[Math.floor(Math.pow(u, 2.4) * this.owners.length)];
  }

  title() {
    const r = this.rand;
    return `${A[Math.floor(r() * A.length)]} ${B[Math.floor(r() * B.length)]}`;
  }

  link(title: string) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return `https://${slug}.${TLD[Math.floor(this.rand() * TLD.length)]}`;
  }

  size(): [number, number] {
    const r = this.rand();
    const table: [number, [number, number]][] = [
      [0.26, [1, 1]], [0.4, [2, 1]], [0.52, [2, 2]], [0.6, [3, 2]], [0.68, [3, 3]],
      [0.75, [4, 2]], [0.81, [4, 4]], [0.86, [6, 2]], [0.9, [5, 5]], [0.93, [8, 3]],
      [0.955, [10, 4]], [0.975, [8, 8]], [0.99, [12, 6]], [1, [16, 10]],
    ];
    for (const [p, s] of table) if (r <= p) return this.rand() < 0.5 ? s : [s[1], s[0]];
    return [1, 1];
  }

  place(w: number, h: number): Rect | null {
    // density falls off from the top-left, like the 2005 page that filled from the top
    for (let tries = 0; tries < 60; tries++) {
      const gy = Math.pow(this.rand(), 1.35);
      const gx = this.rand();
      const x = Math.floor(gx * (GRID - w + 1));
      const y = Math.floor(gy * (GRID - h + 1));
      const rect = { x, y, w, h };
      if (isRectFree(this.bitmap, rect)) return rect;
    }
    return null;
  }

  makeAd(rect: Rect, ts: number, payMode?: PayMode): AdRec {
    const title = this.title();
    const id = this.ads.length + 1;
    const mode: PayMode = payMode ?? (this.rand() < 0.34 ? "token" : "sol");
    const usdMicro = quoteUsd(rect.w, rect.h);
    const solUsd = this.solUsd * (0.92 + this.rand() * 0.16);
    const tokUsd = this.tokenUsd * (0.7 + this.rand() * 0.5);
    return {
      id,
      owner: this.pickOwner(),
      ...rect,
      title,
      link: this.link(title),
      imageUrl: `mock://ad/${id}`,
      payMode: mode,
      usd: rect.w * rect.h * PRICE_PER_BLOCK_USD,
      createdAt: ts,
      lamports: mode === "sol" ? quoteLamports(usdMicro, solUsd) : 0n,
      tokens: mode === "token" ? quoteTokens(usdMicro, tokUsd) : 0n,
    };
  }

  commit(ad: AdRec) {
    this.ads.push(ad);
    for (const i of rectBlocks(ad)) bitSet(this.bitmap, i);
  }

  seedAds() {
    const target = 3480;
    const now = Date.now();
    const start = now - 46 * DAY;
    let sold = 0;
    const pending: AdRec[] = [];
    while (sold < target) {
      const [w, h] = this.size();
      const rect = this.place(w, h);
      if (!rect) continue;
      // fake timestamps sorted later
      const ad = this.makeAd(rect, 0);
      this.commit(ad);
      pending.push(ad);
      sold += w * h;
    }
    const ts = pending.map(() => start + Math.pow(this.rand(), 0.7) * (now - start - 60_000)).sort((a, b) => a - b);
    pending.forEach((a, i) => (a.createdAt = Math.round(ts[i])));
  }

  seedBuybacks() {
    const now = Date.now();
    let t = now - 45 * DAY;
    while (t < now - 60_000) {
      t += (6 + this.rand() * 10) * 3600_000;
      if (t > now) break;
      const toBuyback = this.lamportsToBuybackUntil(t);
      const spent = this.buybacks.reduce((a, b) => a + b.lamportsIn, 0n);
      const avail = toBuyback - spent;
      if (avail <= 0n) continue;
      const lamportsIn = (avail * BigInt(Math.round((0.55 + this.rand() * 0.4) * 1000))) / 1000n;
      this.buybacks.push({ sig: base58(this.rand, 88), ts: Math.round(t), lamportsIn, tokensBurned: this.tokensFor(lamportsIn, 0.8 + this.rand() * 0.35) });
    }
  }

  lamportsToBuybackUntil(t: number) {
    let l = 0n;
    for (const a of this.ads) if (a.createdAt <= t) l += a.lamports;
    return (l * BigInt(10_000 - TREASURY_BPS)) / 10_000n;
  }

  tokensFor(lamports: bigint, priceFactor = 1) {
    const sol = Number(lamports) / LAMPORTS_PER_SOL;
    const tokens = (sol * this.solUsd) / (this.tokenUsd * priceFactor);
    return BigInt(Math.round(tokens * 10 ** TOKEN_DECIMALS));
  }

  // ---------- API surface ----------
  stats(): Stats {
    let lamportsRaised = 0n, burnedDirect = 0n, usd = 0, sold = 0;
    for (const a of this.ads) {
      lamportsRaised += a.lamports;
      burnedDirect += a.tokens;
      usd += a.usd;
      sold += a.w * a.h;
    }
    const toTreasury = (lamportsRaised * BigInt(TREASURY_BPS)) / 10_000n;
    const toBuyback = lamportsRaised - toTreasury;
    let spent = 0n, burnedBuyback = 0n;
    for (const b of this.buybacks) {
      spent += b.lamportsIn;
      burnedBuyback += b.tokensBurned;
    }
    const burned = burnedDirect + burnedBuyback;
    const circ = TOKEN_SUPPLY - burned;
    return {
      soldBlocks: sold,
      totalBlocks: TOTAL_BLOCKS,
      adsCount: this.ads.length,
      usdRaised: usd,
      lamportsRaised: lamportsRaised.toString(),
      lamportsToTreasury: toTreasury.toString(),
      lamportsToBuyback: toBuyback.toString(),
      lamportsSpentBuyback: spent.toString(),
      tokensBurned: burned.toString(),
      tokensBurnedDirect: burnedDirect.toString(),
      tokensBurnedBuyback: burnedBuyback.toString(),
      tokenSupply: circ.toString(),
      burnedPct: Number((burned * 1_000_000n) / TOKEN_SUPPLY) / 10_000,
      solPriceUsd: this.solUsd,
      tokenPriceUsd: this.tokenUsd,
      marketCapUsd: (Number(circ) / 10 ** TOKEN_DECIMALS) * this.tokenUsd,
      auction: this.auction(sold),
      updatedAt: Date.now(),
    };
  }

  auction(sold = this.soldBlocks()): AuctionState | null {
    if (sold < AUCTION_THRESHOLD_BLOCKS) return null;
    return null;
  }

  soldBlocks() {
    let n = 0;
    for (const a of this.ads) n += a.w * a.h;
    return n;
  }

  publicAd(a: AdRec): Ad {
    return {
      id: a.id, owner: a.owner, x: a.x, y: a.y, w: a.w, h: a.h, title: a.title,
      link: a.link, imageUrl: a.imageUrl, payMode: a.payMode, usd: a.usd, createdAt: a.createdAt,
    };
  }

  occupancy(): Occupancy {
    return { bitmap: bytesToBase64(this.bitmap), soldBlocks: this.soldBlocks() };
  }

  feedOf(a: AdRec): FeedItem {
    return {
      type: "purchase", sig: `mock${a.id.toString(36)}${a.owner.slice(0, 40)}`, ts: a.createdAt, adId: a.id, owner: a.owner,
      x: a.x, y: a.y, w: a.w, h: a.h, title: a.title, payMode: a.payMode === "token" ? "token" : "sol", usd: a.usd,
      lamports: a.lamports.toString(), tokensBurned: a.tokens.toString(),
    };
  }

  feed(limit = 50): FeedItem[] {
    const items: FeedItem[] = [
      ...this.ads.slice(-limit).map((a) => this.feedOf(a)),
      ...this.buybacks.slice(-limit).map((b) => ({ type: "buyback" as const, sig: b.sig, ts: b.ts, lamportsIn: b.lamportsIn.toString(), tokensBurned: b.tokensBurned.toString() })),
    ];
    return items.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  buybackHistory() {
    return this.buybacks.map((b) => ({ sig: b.sig, ts: b.ts, lamportsIn: b.lamportsIn.toString(), tokensBurned: b.tokensBurned.toString() }));
  }

  leaderboard(): LeaderRow[] {
    const m = new Map<string, { blocks: number; usd: number; tokens: bigint }>();
    for (const a of this.ads) {
      const r = m.get(a.owner) ?? { blocks: 0, usd: 0, tokens: 0n };
      r.blocks += a.w * a.h;
      r.usd += a.usd;
      // attribute direct burns, plus the buyback share their SOL funded
      r.tokens += a.tokens + this.tokensFor((a.lamports * BigInt(10_000 - TREASURY_BPS)) / 10_000n);
      m.set(a.owner, r);
    }
    return [...m.entries()]
      .map(([owner, r]) => ({ owner, blocks: r.blocks, usd: r.usd, tokensBurned: r.tokens.toString() }))
      .sort((a, b) => b.blocks - a.blocks || b.usd - a.usd)
      .slice(0, 50);
  }

  /** Mock-only override for designing every token-payment state: /canvas?tokenStatus=hourly_cap&tokenBlocks=24 */
  tokenGate(blocks: number) {
    const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const forced = q?.get("tokenStatus");
    const available = q?.get("tokenBlocks") ? Number(q.get("tokenBlocks")) : 640;
    const pricedBy = (q?.get("pricedBy") as "spot" | "ema" | "slow_ema" | null) ?? "ema";
    let status = forced ?? "ok";
    if (status === "ok" && blocks > available) status = "hourly_cap";
    const details: Record<string, string> = {
      warming_up: "EMA warm-up in progress",
      deviation: "spot is more than 15% above the fast EMA",
      hourly_cap: `${available} token-paid blocks left this hour`,
      stale: "EMA older than max age",
      not_seeded: "price source not seeded",
    };
    return {
      tokenPaymentStatus: status,
      tokenPaymentDetail: status === "ok" ? null : details[status] ?? "unavailable",
      tokenPricedBy: status === "ok" ? pricedBy : null,
      tokenBlocksAvailable: available,
    };
  }

  buybackPage(cursor: string | null, limit: number) {
    const all = this.buybacks
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((b) => ({ type: "buyback" as const, sig: b.sig, ts: b.ts, lamportsIn: b.lamportsIn.toString(), tokensBurned: b.tokensBurned.toString() }));
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
  }

  quote(w: number, h: number, mode: PayMode): Quote {
    const usdMicro = quoteUsd(w, h);
    const base = {
      ...this.tokenGate(w * h),
      usd: w * h * PRICE_PER_BLOCK_USD,
      solPriceUsd: this.solUsd,
      tokenPriceUsd: this.tokenUsd,
      discountBps: TOKEN_DISCOUNT_BPS,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    };
    return mode === "sol"
      ? { ...base, lamports: quoteLamports(usdMicro, this.solUsd).toString() }
      : { ...base, usd: base.usd * (1 - TOKEN_DISCOUNT_BPS / 10_000), tokens: quoteTokens(usdMicro, this.tokenUsd).toString() };
  }

  // ---------- live simulation ----------
  emitFeed(f: FeedItem) {
    for (const l of this.listeners) l.feed?.(f);
  }
  emitStats() {
    const s = this.stats();
    for (const l of this.listeners) l.stats?.(s);
  }

  tickPrices() {
    this.solUsd = Math.max(120, this.solUsd * (1 + (this.rand() - 0.5) * 0.004));
    this.tokenUsd = Math.max(0.001, this.tokenUsd * (1 + (this.rand() - 0.48) * 0.012));
  }

  simulatePurchase() {
    this.tickPrices();
    if (this.soldBlocks() >= AUCTION_THRESHOLD_BLOCKS) return;
    const [w, h] = this.rand() < 0.7 ? [1 + Math.floor(this.rand() * 3), 1 + Math.floor(this.rand() * 2)] : this.size();
    const rect = this.place(w, h);
    if (!rect) return;
    const ad = this.makeAd(rect, Date.now());
    this.commit(ad);
    this.emitFeed(this.feedOf(ad));
    this.emitStats();
  }

  simulateBuyback() {
    const s = this.stats();
    const avail = BigInt(s.lamportsToBuyback) - BigInt(s.lamportsSpentBuyback);
    const lamportsIn = avail > 0n ? avail / 3n + BigInt(Math.round(this.rand() * 3 * LAMPORTS_PER_SOL)) : BigInt(Math.round((1 + this.rand() * 4) * LAMPORTS_PER_SOL));
    const b = { sig: base58(this.rand, 88), ts: Date.now(), lamportsIn, tokensBurned: this.tokensFor(lamportsIn) };
    this.buybacks.push(b);
    this.emitFeed({ type: "buyback", sig: b.sig, ts: b.ts, lamportsIn: b.lamportsIn.toString(), tokensBurned: b.tokensBurned.toString() });
    this.emitStats();
  }

  start() {
    if (this.started) return;
    this.started = true;
    const loopP = () => {
      this.timers.push(setTimeout(() => { this.simulatePurchase(); loopP(); }, 3200 + this.rand() * 4200));
    };
    const loopB = () => {
      this.timers.push(setTimeout(() => { this.simulateBuyback(); loopB(); }, 11000 + this.rand() * 9000));
    };
    loopP();
    this.timers.push(setTimeout(() => { this.simulateBuyback(); loopB(); }, 5200));
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.started = false;
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    this.start();
    return () => {
      this.listeners.delete(l);
      if (!this.listeners.size) this.stop();
    };
  }

  /** Commit a purchase made through the mock chain adapter (user's own ad). */
  commitUserPurchase(p: { owner: string; rect: Rect; title: string; link: string; imageUrl: string; payMode: PayMode; lamports: bigint; tokens: bigint }) {
    if (!isRectFree(this.bitmap, p.rect)) throw new Error("Those blocks were just bought by someone else. Pick another spot.");
    const ad: AdRec = {
      id: this.ads.length + 1, owner: p.owner, ...p.rect, title: p.title, link: p.link, imageUrl: p.imageUrl,
      payMode: p.payMode, usd: p.rect.w * p.rect.h * PRICE_PER_BLOCK_USD, createdAt: Date.now(),
      lamports: p.lamports, tokens: p.tokens,
    };
    this.commit(ad);
    this.emitFeed(this.feedOf(ad));
    this.emitStats();
    return ad;
  }

  previewAuction(): AuctionState {
    const now = Date.now();
    const r = mulberry32(99);
    const bids = Array.from({ length: 9 }, (_, i) => ({
      bidder: base58(r),
      lamports: BigInt(Math.round((380 + i * 57 + r() * 30) * LAMPORTS_PER_SOL)).toString(),
      ts: now - (9 - i) * 3.1 * 3600_000,
    })).reverse();
    return {
      status: "live",
      startsAt: now - 30 * 3600_000,
      endsAt: now + 41 * 3600_000 + 17 * 60_000,
      blocks: 100,
      highBid: bids[0].lamports,
      highBidder: bids[0].bidder,
      bids,
    };
  }

  isBlockSold(i: number) {
    return bitGet(this.bitmap, i) === 1;
  }
}

let world: MockWorld | null = null;
export function mockWorld() {
  if (!world) world = new MockWorld();
  return world;
}

export async function mockUpload(file: Blob, w: number, h: number): Promise<UploadResult> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const previewUrl = URL.createObjectURL(file);
  void w;
  void h;
  return { uri: `ar://mock-${sha256.slice(0, 43)}`, sha256, previewUrl };
}
