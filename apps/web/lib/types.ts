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

/** GET /api/ads/:id/share. `ad` is the only buyer content, and stays null until the ad is approved. */
export interface AdShare {
  id: number;
  status: "approved" | "pending" | "rejected";
  owner: string;
  x: number;
  y: number;
  w: number;
  h: number;
  blockCount: number;
  payMode: AdPayMode;
  usd: number;
  lamports: string;
  tokensBurned: string;
  createdAt: number; // unix seconds, as the API sends it
  signature: string;
  finalized: boolean;
  cluster: "devnet" | "mainnet-beta";
  cardVersion: string;
  ad: { title: string; link: string; imageUrl: string } | null;
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
  /** "later": buybacks and $PXL payments are coming soon. Absent on older APIs, which reads as "later". */
  buybackPhase?: "live" | "later";
  lamportsToBuyback: string;
  lamportsSpentBuyback: string;
  tokensBurned: string;
  tokensBurnedDirect: string;
  tokensBurnedBuyback: string;
  /** current on-chain mint supply (reflects every burn, including ones that aren't ours) */
  tokenSupply: string;
  /** our program's burns / initial supply, in percent */
  burnedPct: number;
  /** total reduction of the mint supply incl. pump.fun's own buy-and-burn. Never add it to tokensBurned. */
  supplyReduction?: string;
  supplyReductionPct?: number;
  /** burns NOT made by this program (mostly pump.fun's post-migration boost). Show separately, labelled. */
  tokensBurnedExternal?: string;
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
