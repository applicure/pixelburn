import { EventParser } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";
import { big, enumKind, type PayMode } from "./accounts.js";
import { coder } from "./coder.js";
import { PROGRAM_ID } from "./constants.js";

export type PixelEvent =
  | {
      name: "AdPurchased";
      data: {
        adId: number;
        /** Ad account address */
        ad: PublicKey;
        owner: PublicKey;
        x: number;
        y: number;
        w: number;
        h: number;
        payMode: PayMode;
        lamports: bigint;
        tokensBurned: bigint;
        usdMicro: bigint;
        ts: number;
      };
    }
  | { name: "AdUpdated"; data: { adId: number; ad: PublicKey; ts: number } }
  | { name: "AdTransferred"; data: { adId: number; ad: PublicKey; from: PublicKey; to: PublicKey; ts: number } }
  | { name: "TokenPriceUpdated"; data: { spot: bigint; ema: bigint; slowEma: bigint; ts: number } }
  | { name: "BuybackReleased"; data: { keeper: PublicKey; lamports: bigint; ts: number } }
  | { name: "BuybackBurned"; data: { lamportsIn: bigint; tokensBurned: bigint; ts: number } }
  | { name: "BuybackWrittenOff"; data: { keeper: PublicKey; lamports: bigint; ts: number } }
  | { name: "AuctionStarted"; data: { lotBlocks: number; startTs: number; endTs: number } }
  | { name: "AuctionBid"; data: { bidder: PublicKey; lamports: bigint; endTs: number; ts: number } }
  | { name: "AuctionSettled"; data: { winner: PublicKey; lamports: bigint; adId: number; ad: PublicKey } }
  | { name: "AuctionRestarted"; data: { endTs: number } }
  | { name: "AuctionResumed"; data: { endTs: number; pausedSecs: number } };

export type PixelEventName = PixelEvent["name"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;
const g = (r: Raw, snake: string) => {
  if (snake in r) return r[snake];
  return r[snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())];
};
const n = (v: unknown) => Number(String(v));

/** Normalise an Anchor-decoded event into the typed `PixelEvent` union (bigint for u64/u128). */
export function normalizeEvent(name: string, r: Raw): PixelEvent | null {
  switch (name) {
    case "AdPurchased":
      return {
        name,
        data: {
          adId: n(g(r, "ad_id")),
          ad: r.ad,
          owner: r.owner,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          payMode: enumKind(g(r, "pay_mode")).kind as PayMode,
          lamports: big(r.lamports),
          tokensBurned: big(g(r, "tokens_burned")),
          usdMicro: big(g(r, "usd_micro")),
          ts: n(r.ts),
        },
      };
    case "AdUpdated":
      return { name, data: { adId: n(g(r, "ad_id")), ad: r.ad, ts: n(r.ts) } };
    case "AdTransferred":
      return { name, data: { adId: n(g(r, "ad_id")), ad: r.ad, from: r.from, to: r.to, ts: n(r.ts) } };
    case "TokenPriceUpdated":
      return { name, data: { spot: big(r.spot), ema: big(r.ema), slowEma: big(g(r, "slow_ema")), ts: n(r.ts) } };
    case "BuybackReleased":
      return { name, data: { keeper: r.keeper, lamports: big(r.lamports), ts: n(r.ts) } };
    case "BuybackBurned":
      return { name, data: { lamportsIn: big(g(r, "lamports_in")), tokensBurned: big(g(r, "tokens_burned")), ts: n(r.ts) } };
    case "BuybackWrittenOff":
      return { name, data: { keeper: r.keeper, lamports: big(r.lamports), ts: n(r.ts) } };
    case "AuctionStarted":
      return { name, data: { lotBlocks: n(g(r, "lot_blocks")), startTs: n(g(r, "start_ts")), endTs: n(g(r, "end_ts")) } };
    case "AuctionBid":
      return { name, data: { bidder: r.bidder, lamports: big(r.lamports), endTs: n(g(r, "end_ts")), ts: n(r.ts) } };
    case "AuctionSettled":
      return { name, data: { winner: r.winner, lamports: big(r.lamports), adId: n(g(r, "ad_id")), ad: r.ad } };
    case "AuctionResumed":
      return { name, data: { endTs: n(g(r, "end_ts")), pausedSecs: n(g(r, "paused_secs")) } };
    case "AuctionRestarted":
      return { name, data: { endTs: n(g(r, "end_ts")) } };
    default:
      return null;
  }
}

/**
 * Parse `emit!` events from a transaction's log messages. Only events emitted by `programId`
 * (tracked through the invoke stack) are returned, so CPI'd look-alikes from other programs are ignored.
 */
export function parseEvents(logs: readonly string[], programId: PublicKey = PROGRAM_ID): PixelEvent[] {
  const parser = new EventParser(programId, coder);
  const out: PixelEvent[] = [];
  for (const ev of parser.parseLogs([...logs])) {
    const e = normalizeEvent(ev.name, ev.data as Raw);
    if (e) out.push(e);
  }
  return out;
}

/** Decode a single base64 "Program data:" payload. */
export function decodeEventData(base64: string): PixelEvent | null {
  const ev = coder.events.decode(base64);
  return ev ? normalizeEvent(ev.name, ev.data as Raw) : null;
}
