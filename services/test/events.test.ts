import { describe, expect, it } from "vitest";
import {
  encodeEvent,
  fakeLogs,
  LocalEventDecoder,
  parseEventsFromLogs,
  type ProgramEvent,
} from "../src/chain/events.js";
import { PROGRAM_ID, randKey } from "./helpers.js";
import { SdkEventParser } from "../src/chain/events.js";
import { PROGRAM_ID as SDK_PROGRAM_ID } from "@mpb/sdk";
import { planBuybackChunks, minOutWithSlippage } from "../src/keeper/plan.js";
import { blockIndex, countBits, emptyBitmap, getBlock, isRectFree, rectBlocks, setBlock } from "../src/lib/blocks.js";

const dec = new LocalEventDecoder();

const samples: ProgramEvent[] = [
  { name: "AdPurchased", adId: 8, ad: randKey(), owner: randKey(), x: 0, y: 0, w: 0, h: 0, payMode: "auction", lamports: 5n, tokensBurned: 0n, usdMicro: 0n, ts: 1n },
  { name: "AdPurchased", adId: 7, ad: randKey(), owner: randKey(), x: 1, y: 2, w: 3, h: 4, payMode: "token", lamports: 0n, tokensBurned: 123n, usdMicro: 1_200_000_000n, ts: 1_700_000_000n },
  { name: "AdUpdated", adId: 7, ad: randKey(), ts: 1n },
  { name: "AdTransferred", adId: 7, ad: randKey(), from: randKey(), to: randKey(), ts: 2n },
  { name: "TokenPriceUpdated", spot: 10n ** 20n + 5n, ema: 99n, slowEma: 98n, ts: 3n },
  { name: "BuybackBurned", lamportsIn: 5_000_000_000n, tokensBurned: 77n, ts: 4n },
  { name: "BuybackReleased", keeper: randKey(), lamports: 9n, ts: 4n },
  { name: "BuybackWrittenOff", keeper: randKey(), lamports: 7n, ts: 5n },
  { name: "AuctionStarted", lotBlocks: 100, startTs: 5n, endTs: 99n },
  { name: "AuctionBid", bidder: randKey(), lamports: 10n ** 12n, endTs: 100n, ts: 6n },
  { name: "AuctionRestarted", endTs: 1000n },
  { name: "AuctionResumed", endTs: 2000n, pausedSecs: 120n },
  { name: "AuctionSettled", winner: randKey(), lamports: 10n ** 12n, adId: 300, ad: randKey() },
];

describe("event decoding", () => {
  it.each(samples)("round-trips $name", (ev) => {
    expect(dec.decode(encodeEvent(ev))).toEqual(ev);
  });

  it("returns null for unknown discriminators", () => {
    expect(dec.decode(new Uint8Array(16))).toBeNull();
  });

  it("only takes Program data emitted by our program (CPI-aware)", () => {
    const other = randKey();
    const mine = samples[1]!;
    const foreign = Buffer.from(encodeEvent(samples[6]!)).toString("base64");
    const logs = [
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program ${other} invoke [2]`,
      `Program data: ${foreign}`, // emitted inside a CPI by another program -> ignored
      `Program ${other} success`,
      ...fakeLogs(PROGRAM_ID, [mine]).slice(2, 3),
      `Program ${PROGRAM_ID} success`,
    ];
    expect(parseEventsFromLogs(logs, PROGRAM_ID, dec)).toEqual([mine]);
  });

  it("preserves emission order (event index)", () => {
    const logs = fakeLogs(PROGRAM_ID, [samples[4]!, samples[1]!]);
    expect(parseEventsFromLogs(logs, PROGRAM_ID, dec).map((e) => e.name)).toEqual(["TokenPriceUpdated", "AdPurchased"]);
  });
});

describe("@mpb/sdk parser vs local codec", () => {
  it("SDK parseEvents decodes our encoder's payloads identically (IDL layout cross-check)", () => {
    const sdk = new SdkEventParser(SDK_PROGRAM_ID.toBase58());
    const logs = fakeLogs(SDK_PROGRAM_ID.toBase58(), samples);
    expect(sdk.parse(logs)).toEqual(samples);
  });

  it("SDK parser ignores events emitted under another program's invoke frame", () => {
    const sdk = new SdkEventParser(SDK_PROGRAM_ID.toBase58());
    const logs = fakeLogs(randKey(), samples); // framed by some other program
    expect(sdk.parse(logs)).toEqual([]);
  });
});

describe("blocks", () => {
  it("indexes and tests occupancy", () => {
    expect(blockIndex(3, 2)).toBe(203);
    const bm = emptyBitmap();
    rectBlocks({ x: 0, y: 0, w: 2, h: 2 }).forEach((b) => setBlock(bm, b));
    expect(countBits(bm)).toBe(4);
    expect(getBlock(bm, 101)).toBe(true);
    expect(bm[0]).toBe(0b11); // LSB-first
    expect(isRectFree(bm, { x: 1, y: 1, w: 1, h: 1 })).toBe(false);
    expect(isRectFree(bm, { x: 2, y: 0, w: 1, h: 1 })).toBe(true);
  });
});

describe("keeper buyback planning", () => {
  const base = { reserveLamports: 10n, maxPerRunLamports: 1_000n, minChunkLamports: 50n, maxChunkLamports: 200n };
  it("splits into capped chunks within budget", () => {
    let i = 0;
    const rng = () => [0.1, 0.9, 0.5, 0.3][i++ % 4]!;
    const chunks = planBuybackChunks({ ...base, vaultLamports: 5_000n, rng });
    expect(chunks.reduce((a, b) => a + b, 0n)).toBeLessThanOrEqual(1_000n);
    expect(chunks.reduce((a, b) => a + b, 0n)).toBeGreaterThan(1_000n - 50n); // at most sub-minimum dust left
    for (const c of chunks) {
      expect(c).toBeGreaterThanOrEqual(50n);
      expect(c).toBeLessThanOrEqual(200n); // never above the max chunk (a price-impact limit)
    }
  });
  it("keeps the reserve and skips dust", () => {
    expect(planBuybackChunks({ ...base, vaultLamports: 40n })).toEqual([]);
    const chunks = planBuybackChunks({ ...base, vaultLamports: 100n, rng: () => 0 });
    expect(chunks.reduce((a, b) => a + b, 0n)).toBe(90n);
  });
  it("computes min-out with slippage", () => {
    expect(minOutWithSlippage(10_000n, 100)).toBe(9_900n);
  });
});
