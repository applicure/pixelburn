/** Shapes mirror SPEC "Services API" table. u64 amounts are strings. */
export type PayMode = "sol" | "token";
/** Ads won in the final auction cover a block list rather than a rectangle (SPEC). */
export type AdPayMode = PayMode | "auction";

export interface Ad {
  id: number;
  owner: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  link: string;
  imageUrl: string;
  payMode: AdPayMode;
  /** present for the auction lot: block indices it covers */
  blocks?: number[];
  usd: number;
  createdAt: number; // ms epoch
}

export interface AuctionBid {
  bidder: string;
  lamports: string;
  ts: number;
}

export interface AuctionState {
  status: "pending" | "live" | "settled";
  startsAt: number | null;
  endsAt: number | null;
  blocks: number;
  highBid: string | null; // lamports
  highBidder: string | null;
  bids: AuctionBid[];
}

export interface Stats {
  soldBlocks: number;
  totalBlocks: number;
  adsCount: number;
  usdRaised: number;
  lamportsRaised: string;
  lamportsToTreasury: string;
  lamportsToBuyback: string;
  lamportsSpentBuyback: string;
  tokensBurned: string;
  tokensBurnedDirect: string;
  tokensBurnedBuyback: string;
  tokenSupply: string;
  burnedPct: number;
  solPriceUsd: number;
  tokenPriceUsd: number;
  marketCapUsd: number;
  auction: AuctionState | null;
  updatedAt: number;
}

export type FeedItem =
  | {
      type: "purchase";
      sig: string;
      ts: number;
      adId: number;
      owner: string;
      x: number;
      y: number;
      w: number;
      h: number;
      title: string;
      payMode: PayMode;
      usd: number;
      lamports: string;
      tokensBurned: string;
    }
  | { type: "buyback"; sig: string; ts: number; lamportsIn: string; tokensBurned: string }
  | { type: "bid"; sig: string; ts: number; bidder: string; lamports: string };

export interface Occupancy {
  bitmap: string; // base64 of 1250 bytes
  soldBlocks: number;
}

export interface LeaderRow {
  owner: string;
  blocks: number;
  usd: number;
  tokensBurned: string;
}

export interface Quote {
  usd: number;
  lamports?: string;
  tokens?: string;
  solPriceUsd: number;
  tokenPriceUsd: number;
  discountBps: number;
  expiresAt: number;
  /** services: 'ok' | 'not_seeded' | 'warming_up' | 'stale' | 'deviation' | 'hourly_cap' | 'unknown' | future values */
  tokenPaymentStatus?: string;
  tokenPaymentDetail?: string | null;
  tokenPricedBy?: "spot" | "ema" | "slow_ema" | null;
  tokenBlocksAvailable?: number | null;
}

export interface UploadResult {
  uri: string;
  sha256: string;
  previewUrl: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
