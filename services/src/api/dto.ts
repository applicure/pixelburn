// Wire shapes for the HTTP API (SPEC "Services API"). Conventions:
//  - camelCase; u64 base-unit amounts (lamports, token base units) are decimal strings
//  - USD amounts and prices are JS numbers (dollars, not micro)
//  - all timestamps are unix seconds (number)
import type { ads as adsTable } from "../db/schema.js";
import { microToUsd } from "../lib/quote-math.js";

export type AdRow = typeof adsTable.$inferSelect;

export interface AdDto {
  id: number;
  owner: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Present only for the final-auction ad (non-rectangular). */
  blocks?: number[];
  title: string;
  link: string;
  imageUrl: string;
  payMode: "sol" | "token" | "auction";
  usd: number;
  createdAt: number;
}

/**
 * GET /api/ads/:id/share. What the ad page and the share panel may know. `ad` is the ONLY place buyer content appears,
 * and it stays null until the ad is approved. Everything else is public on-chain data.
 */
export interface AdShareDto {
  id: number;
  status: "approved" | "pending" | "rejected";
  owner: string;
  x: number;
  y: number;
  w: number;
  h: number;
  blockCount: number;
  payMode: "sol" | "token" | "auction";
  usd: number;
  lamports: string;
  tokensBurned: string;
  createdAt: number;
  signature: string;
  finalized: boolean;
  cluster: "devnet" | "mainnet-beta";
  /** Goes in the card image URL: changes with approval state and content. */
  cardVersion: string;
  ad: { title: string; link: string; imageUrl: string } | null;
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
      payMode: "sol" | "token";
      usd: number;
      lamports: string;
      tokensBurned: string;
      finalized: boolean;
      /** Ad title once the ad is approved; null while pending/rejected (incl. live SSE items right after purchase). */
      title: string | null;
    }
  | { type: "buyback"; sig: string; ts: number; lamportsIn: string; tokensBurned: string; finalized: boolean }
  | { type: "bid"; sig: string; ts: number; bidder: string; lamports: string; finalized: boolean };

export interface BuybackDto {
  sig: string;
  ts: number;
  lamportsIn: string;
  tokensBurned: string;
  finalized: boolean;
}

export interface AuctionBidDto {
  bidder: string;
  lamports: string;
  ts: number;
  sig: string;
}

export interface AuctionDto {
  status: "active" | "settled";
  blocksRemaining: number;
  startedAt: number;
  endsAt: number;
  highestBid: string | null;
  highestBidder: string | null;
  bidsCount: number;
  winner: string | null;
  winningLamports: string | null;
  adId: number | null;
  /** Newest first (max 200). */
  bids: AuctionBidDto[];
}

export interface StatsDto {
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
  /** Protocol burns only (direct + buyback) as % of the INITIAL supply. */
  burnedPct: number;
  /** Burned by others: supplyReduction − protocol burns (e.g. pump.fun's migration boost). */
  tokensBurnedExternal: string;
  /** initial supply − current supply (everyone's burns; never merged into burnedPct). */
  supplyReduction: string;
  supplyReductionPct: number;
  solPriceUsd: number | null;
  tokenPriceUsd: number | null;
  marketCapUsd: number | null;
  auction: AuctionDto | null;
  updatedAt: number;
}

export const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export function toAdDto(row: AdRow, resolveImageUrl: (uri: string) => string): AdDto {
  const dto: AdDto = {
    id: row.id,
    owner: row.owner,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    title: row.title,
    link: row.link,
    imageUrl: row.imageUri ? resolveImageUrl(row.imageUri) : "",
    payMode: row.payMode,
    usd: microToUsd(row.usdMicro),
    createdAt: unix(row.createdAt),
  };
  if (row.blocks && row.blocks.length) dto.blocks = row.blocks;
  return dto;
}
