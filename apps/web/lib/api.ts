/**
 * Data layer. One interface, two adapters:
 *  - HttpApi  → @mpb/services (SPEC "Services API" table) when NEXT_PUBLIC_API_URL is set
 *  - MockApi  → deterministic in-browser world with live fake events
 */
import { API_URL, USE_MOCK } from "./config";
import type { Ad, AdShare, AuctionState, FeedItem, LeaderRow, Occupancy, PayMode, Quote, Stats, UploadResult } from "./types";

export type BuybackItem = Extract<FeedItem, { type: "buyback" }>;

export interface StreamHandlers {
  feed?: (item: FeedItem) => void;
  stats?: (stats: Stats) => void;
  status?: (s: "open" | "error") => void;
}

export interface Api {
  readonly mode: "http" | "mock";
  getStats(): Promise<Stats>;
  getAds(): Promise<Ad[]>;
  getAd(id: number): Promise<Ad>;
  /** GET /api/ads/:id/share: public facts of any indexed ad, whatever its moderation state. null until it is indexed. */
  getAdShare(id: number): Promise<AdShare | null>;
  getOccupancy(): Promise<Occupancy>;
  /** URL of the composed 1000×1000 PNG; null in mock mode (painted client side). */
  canvasPngUrl(): string | null;
  getFeed(limit?: number): Promise<FeedItem[]>;
  getLeaderboard(): Promise<LeaderRow[]>;
  getQuote(w: number, h: number, mode: PayMode): Promise<Quote>;
  getAuction(): Promise<AuctionState | null>;
  /** GET /api/buybacks?cursor=&limit= (newest first, opaque cursor) */
  getBuybacks(cursor?: string | null, limit?: number): Promise<{ items: BuybackItem[]; nextCursor: string | null }>;
  /** GET /api/events (SSE). Returns an unsubscribe function. */
  subscribe(h: StreamHandlers): () => void;
  /** POST /api/uploads (multipart file, w, h). */
  upload(file: Blob, w: number, h: number): Promise<UploadResult>;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> | null = null) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ({ error?: string } & Record<string, unknown>) | null;
    if (body?.error === "price_unavailable") throw new HttpError(503, "Live prices are unavailable right now. Try again in a minute.", body);
    if (body?.error === "token_pricing_unavailable") throw new HttpError(503, `${String(body.detail ?? "Token payments are unavailable right now.")}`, body);
    if (res.status === 429) throw new HttpError(429, "Too many requests, retrying shortly.", body);
    throw new HttpError(res.status, `${path} answered ${res.status}`, body);
  }
  return (await res.json()) as T;
}

/* ---- normalisers: @mpb/services sends unix seconds, nullable prices and its own auction shape ---- */
const ms = (t: number) => (t < 1e12 ? t * 1000 : t);
type RawAuction = {
  bids?: { bidder: string; lamports: string; ts: number; sig?: string }[];
  status: "active" | "settled";
  blocksRemaining: number;
  startedAt: number;
  endsAt: number;
  highestBid: string | null;
  highestBidder: string | null;
  bidsCount?: number;
};
function normAuction(a: RawAuction | AuctionState | null): AuctionState | null {
  if (!a) return null;
  if ("blocks" in a) return a;
  return {
    status: a.status === "active" ? "live" : "settled",
    startsAt: ms(a.startedAt),
    endsAt: ms(a.endsAt),
    blocks: a.blocksRemaining,
    highBid: a.highestBid,
    highBidder: a.highestBidder,
    bids: (a.bids ?? []).map((b) => ({ bidder: b.bidder, lamports: b.lamports, ts: ms(b.ts) })),
  };
}
function normStats(s: Stats & { auction: RawAuction | AuctionState | null }): Stats {
  return {
    ...s,
    solPriceUsd: s.solPriceUsd ?? 0,
    tokenPriceUsd: s.tokenPriceUsd ?? 0,
    marketCapUsd: s.marketCapUsd ?? 0,
    auction: normAuction(s.auction),
    updatedAt: ms(s.updatedAt),
  };
}
const normAd = (a: Ad): Ad => ({ ...a, createdAt: ms(a.createdAt) });
function normFeed(f: FeedItem): FeedItem {
  const g = { ...f, ts: ms(f.ts) } as FeedItem;
  if (g.type === "purchase" && !g.title) g.title = `Ad #${g.adId}`;
  return g;
}

const HttpApi: Api = {
  mode: "http",
  getStats: () => getJson<Stats & { auction: RawAuction | null }>("/api/stats").then(normStats),
  getAds: () => getJson<Ad[]>("/api/ads").then((a) => a.map(normAd)),
  getAd: (id) => getJson<Ad>(`/api/ads/${id}`).then(normAd),
  getAdShare: async (id) => {
    const res = await fetch(`${API_URL}/api/ads/${id}/share`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, `/api/ads/${id}/share answered ${res.status}`);
    return (await res.json()) as AdShare;
  },
  getOccupancy: () => getJson<Occupancy>("/api/occupancy"),
  canvasPngUrl: () => `${API_URL}/api/canvas.png`,
  getFeed: (limit = 50) => getJson<FeedItem[]>(`/api/feed?limit=${limit}`).then((f) => f.map(normFeed)),
  getLeaderboard: () => getJson<LeaderRow[]>("/api/leaderboard"),
  // services sends expiresAt in unix seconds like every other timestamp
  getQuote: (w, h, mode) => getJson<Quote>(`/api/quote?w=${w}&h=${h}&mode=${mode}`).then((q) => ({ ...q, expiresAt: ms(q.expiresAt) })),
  getAuction: async () => normAuction(await getJson<RawAuction | null>("/api/auction")),
  getBuybacks: async (cursor, limit = 50) => {
    const r = await getJson<{ items: Omit<BuybackItem, "type">[]; nextCursor: string | null }>(
      `/api/buybacks?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    return { items: r.items.map((i) => ({ ...i, type: "buyback" as const, ts: ms(i.ts) })), nextCursor: r.nextCursor };
  },
  subscribe(h) {
    let es: EventSource | null = null;
    let closed = false;
    let retry = 1000;
    const open = () => {
      if (closed) return;
      es = new EventSource(`${API_URL}/api/events`);
      es.onopen = () => {
        retry = 1000;
        h.status?.("open");
      };
      es.addEventListener("feed", (e) => h.feed?.(normFeed(JSON.parse((e as MessageEvent).data))));
      es.addEventListener("stats", (e) => h.stats?.(normStats(JSON.parse((e as MessageEvent).data))));
      es.onerror = () => {
        h.status?.("error");
        es?.close();
        setTimeout(open, (retry = Math.min(retry * 2, 30_000)));
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
    };
  },
  async upload(file, w, h) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("w", String(w));
    fd.append("h", String(h));
    const res = await fetch(`${API_URL}/api/uploads`, { method: "POST", body: fd });
    if (!res.ok) throw new HttpError(res.status, `Upload failed (${res.status}). Try a PNG or JPG under 5 MB.`);
    return (await res.json()) as UploadResult;
  },
};

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

/** Mock lives in its own chunk so production (HTTP) bundles never ship it. */
const mock = () => import("./mock");
const w = async () => (await mock()).mockWorld();

const MockApi: Api = {
  mode: "mock",
  getStats: async () => delay((await w()).stats()),
  getAds: async () => {
    const m = await w();
    return delay(m.ads.map((a) => m.publicAd(a)));
  },
  getAd: async (id) => {
    const m = await w();
    const a = m.ads.find((x) => x.id === id);
    if (!a) throw new HttpError(404, `Ad ${id} not found`);
    return delay(m.publicAd(a));
  },
  getAdShare: async (id) => delay((await w()).adShare(id), 900),
  getOccupancy: async () => delay((await w()).occupancy()),
  canvasPngUrl: () => null,
  getFeed: async (limit = 50) => delay((await w()).feed(limit)),
  getLeaderboard: async () => delay((await w()).leaderboard()),
  getQuote: async (wd, h, mode) => {
    const q = (await w()).quote(wd, h, mode);
    if (mode === "token" && q.tokenPaymentStatus !== "ok")
      throw new HttpError(503, q.tokenPaymentDetail ?? "Token payments are unavailable", { error: "token_pricing_unavailable", tokenPaymentStatus: q.tokenPaymentStatus });
    return delay(q, 180);
  },
  getAuction: async () => delay((await w()).auction()),
  getBuybacks: async (cursor, limit = 50) => delay((await w()).buybackPage(cursor ?? null, limit)),
  subscribe(h) {
    let off: (() => void) | null = null;
    let closed = false;
    w().then((m) => {
      if (closed) return;
      h.status?.("open");
      off = m.subscribe({ feed: h.feed, stats: h.stats });
    });
    return () => {
      closed = true;
      off?.();
    };
  },
  upload: async (file, wd, h) => (await mock()).mockUpload(file, wd, h),
};

export const api: Api = USE_MOCK ? MockApi : HttpApi;
