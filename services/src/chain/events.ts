// Anchor event decoding. Production uses @mpb/sdk's `parseEvents` (SdkEventParser).
// The local borsh encoder/decoder below is kept ONLY for tests and the seed script: it
// fabricates realistic "Program data:" logs, and test/events.test.ts asserts the SDK
// parser decodes them identically (a cross-check of both against the IDL layout). Everything downstream depends
// only on the `ProgramEvent` union and the `EventDecoder` interface, so swapping in
// @mpb/sdk's parser means implementing `EventDecoder` with it in one place.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { parseEvents as sdkParseEvents, type PixelEvent } from "@mpb/sdk";
import { BorshReader, BorshWriter } from "./borsh.js";

export type PayModeOnChain = "sol" | "token" | "auction";

export type ProgramEvent =
  | {
      name: "AdPurchased";
      adId: number;
      /** Ad account address */
      ad: string;
      owner: string;
      x: number;
      y: number;
      w: number;
      h: number;
      payMode: PayModeOnChain;
      lamports: bigint;
      tokensBurned: bigint;
      usdMicro: bigint;
      ts: bigint;
    }
  | { name: "AdUpdated"; adId: number; ad: string; ts: bigint }
  | { name: "AdTransferred"; adId: number; ad: string; from: string; to: string; ts: bigint }
  | { name: "TokenPriceUpdated"; spot: bigint; ema: bigint; slowEma: bigint; ts: bigint }
  | { name: "BuybackReleased"; keeper: string; lamports: bigint; ts: bigint }
  | { name: "BuybackBurned"; lamportsIn: bigint; tokensBurned: bigint; ts: bigint }
  | { name: "BuybackWrittenOff"; keeper: string; lamports: bigint; ts: bigint }
  | { name: "AuctionStarted"; lotBlocks: number; startTs: bigint; endTs: bigint }
  /** endTs: auction end after this bid (anti-snipe extension). */
  | { name: "AuctionBid"; bidder: string; lamports: bigint; endTs: bigint; ts: bigint }
  | { name: "AuctionRestarted"; endTs: bigint }
  /** Auction clock resumed after a pause; endTs moved out by pausedSecs. */
  | { name: "AuctionResumed"; endTs: bigint; pausedSecs: bigint }
  | { name: "AuctionSettled"; winner: string; lamports: bigint; adId: number; ad: string };

export type EventName = ProgramEvent["name"];

/** Turns a transaction's log lines into our program's events, in emission order. */
export interface EventParser {
  parse(logs: readonly string[]): ProgramEvent[];
}

/** Single-payload decoder (local test codec). */
export interface EventDecoder {
  decode(data: Uint8Array): ProgramEvent | null;
}

const b58 = (k: PublicKey) => k.toBase58();
const bi = (n: number | bigint) => BigInt(n);

/** Map the SDK's typed event union onto ours (PublicKey -> base58, timestamps -> bigint). */
export function fromSdkEvent(e: PixelEvent): ProgramEvent | null {
  switch (e.name) {
    case "AdPurchased": {
      const d = e.data;
      return {
        name: e.name, adId: d.adId, ad: b58(d.ad), owner: b58(d.owner), x: d.x, y: d.y, w: d.w, h: d.h, payMode: d.payMode,
        lamports: d.lamports, tokensBurned: d.tokensBurned, usdMicro: d.usdMicro, ts: bi(d.ts),
      };
    }
    case "AdUpdated":
      return { name: e.name, adId: e.data.adId, ad: b58(e.data.ad), ts: bi(e.data.ts) };
    case "AdTransferred":
      return { name: e.name, adId: e.data.adId, ad: b58(e.data.ad), from: b58(e.data.from), to: b58(e.data.to), ts: bi(e.data.ts) };
    case "TokenPriceUpdated":
      return { name: e.name, spot: e.data.spot, ema: e.data.ema, slowEma: e.data.slowEma, ts: bi(e.data.ts) };
    case "BuybackReleased":
      return { name: e.name, keeper: b58(e.data.keeper), lamports: e.data.lamports, ts: bi(e.data.ts) };
    case "BuybackBurned":
      return { name: e.name, lamportsIn: e.data.lamportsIn, tokensBurned: e.data.tokensBurned, ts: bi(e.data.ts) };
    case "BuybackWrittenOff":
      return { name: e.name, keeper: b58(e.data.keeper), lamports: e.data.lamports, ts: bi(e.data.ts) };
    case "AuctionStarted":
      return { name: e.name, lotBlocks: e.data.lotBlocks, startTs: bi(e.data.startTs), endTs: bi(e.data.endTs) };
    case "AuctionBid":
      return { name: e.name, bidder: b58(e.data.bidder), lamports: e.data.lamports, endTs: bi(e.data.endTs), ts: bi(e.data.ts) };
    case "AuctionRestarted":
      return { name: e.name, endTs: bi(e.data.endTs) };
    case "AuctionResumed":
      return { name: e.name, endTs: bi(e.data.endTs), pausedSecs: bi(e.data.pausedSecs) };
    case "AuctionSettled":
      return { name: e.name, winner: b58(e.data.winner), lamports: e.data.lamports, adId: e.data.adId, ad: b58(e.data.ad) };
    default:
      // An event added to the program that services doesn't know yet: skip (kept forward-compatible).
      return null;
  }
}

/** Production parser: @mpb/sdk (Anchor EventParser over the program's IDL, invoke-stack aware). */
export class SdkEventParser implements EventParser {
  private readonly pid: PublicKey;
  constructor(programId: string) {
    this.pid = new PublicKey(programId);
  }
  parse(logs: readonly string[]): ProgramEvent[] {
    return sdkParseEvents(logs, this.pid)
      .map(fromSdkEvent)
      .filter((e: ProgramEvent | null): e is ProgramEvent => e !== null);
  }
}

/** Test-only parser over the local codec. */
export class LocalEventParser implements EventParser {
  private readonly dec = new LocalEventDecoder();
  constructor(private readonly programId: string) {}
  parse(logs: readonly string[]): ProgramEvent[] {
    return parseEventsFromLogs([...logs], this.programId, this.dec);
  }
}

export const EVENT_NAMES: EventName[] = [
  "AdPurchased",
  "AdUpdated",
  "AdTransferred",
  "TokenPriceUpdated",
  "BuybackReleased",
  "BuybackBurned",
  "BuybackWrittenOff",
  "AuctionStarted",
  "AuctionBid",
  "AuctionRestarted",
  "AuctionResumed",
  "AuctionSettled",
];

export function eventDiscriminator(name: string): Uint8Array {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

const discHex = new Map<string, EventName>(
  EVENT_NAMES.map((n) => [Buffer.from(eventDiscriminator(n)).toString("hex"), n]),
);

const PAY_MODES: PayModeOnChain[] = ["sol", "token", "auction"];
const payModeFrom = (v: number): PayModeOnChain => {
  const m = PAY_MODES[v];
  if (!m) throw new RangeError(`unknown PayMode ${v}`);
  return m;
};

export class LocalEventDecoder implements EventDecoder {
  decode(data: Uint8Array): ProgramEvent | null {
    if (data.length < 8) return null;
    const name = discHex.get(Buffer.from(data.subarray(0, 8)).toString("hex"));
    if (!name) return null;
    const r = new BorshReader(data.subarray(8));
    switch (name) {
      case "AdPurchased":
        return {
          name, adId: r.u32(), ad: r.pubkey(), owner: r.pubkey(), x: r.u8(), y: r.u8(), w: r.u8(), h: r.u8(),
          payMode: payModeFrom(r.u8()), lamports: r.u64(), tokensBurned: r.u64(), usdMicro: r.u64(), ts: r.i64(),
        };
      case "AdUpdated":
        return { name, adId: r.u32(), ad: r.pubkey(), ts: r.i64() };
      case "AdTransferred":
        return { name, adId: r.u32(), ad: r.pubkey(), from: r.pubkey(), to: r.pubkey(), ts: r.i64() };
      case "TokenPriceUpdated":
        return { name, spot: r.u128(), ema: r.u128(), slowEma: r.u128(), ts: r.i64() };
      case "BuybackReleased":
        return { name, keeper: r.pubkey(), lamports: r.u64(), ts: r.i64() };
      case "BuybackBurned":
        return { name, lamportsIn: r.u64(), tokensBurned: r.u64(), ts: r.i64() };
      case "BuybackWrittenOff":
        return { name, keeper: r.pubkey(), lamports: r.u64(), ts: r.i64() };
      case "AuctionStarted":
        return { name, lotBlocks: r.u16(), startTs: r.i64(), endTs: r.i64() };
      case "AuctionBid":
        return { name, bidder: r.pubkey(), lamports: r.u64(), endTs: r.i64(), ts: r.i64() };
      case "AuctionRestarted":
        return { name, endTs: r.i64() };
      case "AuctionResumed":
        return { name, endTs: r.i64(), pausedSecs: r.i64() };
      case "AuctionSettled":
        return { name, winner: r.pubkey(), lamports: r.u64(), adId: r.u32(), ad: r.pubkey() };
    }
  }
}

/** Inverse of LocalEventDecoder; used by tests and seed to fabricate realistic logs. */
export function encodeEvent(ev: ProgramEvent): Uint8Array {
  const w = new BorshWriter().raw(eventDiscriminator(ev.name));
  switch (ev.name) {
    case "AdPurchased":
      w.u32(ev.adId).pubkey(ev.ad).pubkey(ev.owner).u8(ev.x).u8(ev.y).u8(ev.w).u8(ev.h).u8(PAY_MODES.indexOf(ev.payMode))
        .u64(ev.lamports).u64(ev.tokensBurned).u64(ev.usdMicro).i64(ev.ts);
      break;
    case "AdUpdated":
      w.u32(ev.adId).pubkey(ev.ad).i64(ev.ts);
      break;
    case "AdTransferred":
      w.u32(ev.adId).pubkey(ev.ad).pubkey(ev.from).pubkey(ev.to).i64(ev.ts);
      break;
    case "TokenPriceUpdated":
      w.u128(ev.spot).u128(ev.ema).u128(ev.slowEma).i64(ev.ts);
      break;
    case "BuybackReleased":
      w.pubkey(ev.keeper).u64(ev.lamports).i64(ev.ts);
      break;
    case "BuybackBurned":
      w.u64(ev.lamportsIn).u64(ev.tokensBurned).i64(ev.ts);
      break;
    case "BuybackWrittenOff":
      w.pubkey(ev.keeper).u64(ev.lamports).i64(ev.ts);
      break;
    case "AuctionStarted":
      w.u16(ev.lotBlocks).i64(ev.startTs).i64(ev.endTs);
      break;
    case "AuctionBid":
      w.pubkey(ev.bidder).u64(ev.lamports).i64(ev.endTs).i64(ev.ts);
      break;
    case "AuctionRestarted":
      w.i64(ev.endTs);
      break;
    case "AuctionResumed":
      w.i64(ev.endTs).i64(ev.pausedSecs);
      break;
    case "AuctionSettled":
      w.pubkey(ev.winner).u64(ev.lamports).u32(ev.adId).pubkey(ev.ad);
      break;
  }
  return w.done();
}

/**
 * Extract our program's events from transaction log lines. Tracks the invoke stack so
 * `Program data:` lines emitted by other programs (CPI callees/callers) are ignored.
 * Returns events in emission order; the array index is the event index used for
 * idempotency.
 */
export function parseEventsFromLogs(logs: string[], programId: string, decoder: EventDecoder): ProgramEvent[] {
  const stack: string[] = [];
  const out: ProgramEvent[] = [];
  const invokeRe = /^Program (\w+) invoke \[\d+\]$/;
  const exitRe = /^Program (\w+) (success|failed)/;
  for (const line of logs) {
    let m = invokeRe.exec(line);
    if (m) {
      stack.push(m[1]!);
      continue;
    }
    m = exitRe.exec(line);
    if (m) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === programId) {
      try {
        const ev = decoder.decode(Buffer.from(line.slice("Program data: ".length).trim(), "base64"));
        if (ev) out.push(ev);
      } catch {
        // Malformed/unknown layout: skip but keep going; logged by caller via count mismatch.
      }
    }
  }
  return out;
}

/** JSON-safe representation for storage (bigints -> strings). */
export function eventToJson(ev: ProgramEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
}

/** Build realistic log lines for a set of events (tests/seed). */
export function fakeLogs(programId: string, events: ProgramEvent[]): string[] {
  return [
    `Program ${programId} invoke [1]`,
    "Program log: Instruction: Fake",
    ...events.map((e) => `Program data: ${Buffer.from(encodeEvent(e)).toString("base64")}`),
    `Program ${programId} consumed 12345 of 200000 compute units`,
    `Program ${programId} success`,
  ];
}
