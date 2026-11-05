import { describe, expect, it } from "vitest";
import {
  WSOL_MINT,
  applyTokenDiscount,
  buyPriceQ,
  emaUpdate,
  slowEmaUpdate,
  tokenBlocksAvailable,
  estimateBurnForSolPurchase,
  tokenPricingStatus,
  withinBand,
  lamportsToTokens,
  minNextBid,
  parseBondingCurve,
  parsePumpPool,
  poolSpotPriceQ,
  PRICE_SCALE,
  quoteLamports,
  quoteTokens,
  quoteTokensExact,
  quoteUsd,
  splitSol,
  spotPriceQ,
  tokenUsdFromPriceQ,
  withSlippage,
} from "../src/index.js";

const SOL = { price: 15_000_000_000n, expo: -8 }; // $150

describe("quote math (vectors shared with programs/pixel/src/math.rs + LiteSVM tests)", () => {
  it("usd", () => {
    expect(quoteUsd(1, 1)).toBe(100_000_000n);
    expect(quoteUsd(100, 100)).toBe(1_000_000_000_000n);
    expect(() => quoteUsd(0, 1)).toThrow();
    expect(() => quoteUsd(101, 1)).toThrow();
  });

  it("lamports (ceil)", () => {
    expect(quoteLamports(100_000_000n, SOL)).toBe(666_666_667n);
    expect(quoteLamports(600_000_000n, SOL)).toBe(4_000_000_000n);
    expect(quoteLamports(1_000_000n, { price: 1n, expo: 0 })).toBe(1_000_000_000n);
    expect(quoteLamports(1_000_000n, { price: 1n, expo: 4 })).toBe(100_000n);
    expect(() => quoteLamports(1n, { price: 0n, expo: -8 })).toThrow();
    expect(() => quoteLamports(1_000_000_000_000n, { price: 1n, expo: -18 })).toThrow(); // > u64
  });

  it("50/50 split never leaks", () => {
    for (const l of [0n, 1n, 2n, 3n, 666_666_667n, (1n << 64n) - 1n]) {
      const { treasury, buyback } = splitSol(l);
      expect(treasury + buyback).toBe(l);
      expect(buyback - treasury === 0n || buyback - treasury === 1n).toBe(true);
    }
    expect(splitSol(666_666_667n)).toEqual({ treasury: 333_333_333n, buyback: 333_333_334n });
  });

  it("token discount + exact token quote", () => {
    expect(applyTokenDiscount(100_000_000n)).toBe(90_000_000n);
    expect(applyTokenDiscount(1n)).toBe(1n);
    const q = spotPriceQ(30_000_000_000n, 1_073_000_000_000_000n);
    expect(q).toBe(27_958_993_476_234n);
    // same values the LiteSVM tests assert on-chain
    expect(quoteTokensExact(400_000_000n, SOL, q, q)).toBe(85_840_000_000_003n);
    expect(quoteTokensExact(100_000_000n, SOL, q, q)).toBe(21_460_000_000_001n);
    // min(spot, ema): a pumped spot doesn't reduce tokens owed
    expect(quoteTokensExact(100_000_000n, SOL, q * 10n, q)).toBe(21_460_000_000_001n);
    // a dumped spot increases tokens owed
    expect(quoteTokensExact(100_000_000n, SOL, q / 2n, q)).toBeGreaterThan(2n * 21_460_000_000_000n - 10n);
    expect(lamportsToTokens(1_000n, PRICE_SCALE)).toBe(1_000n);
    expect(() => lamportsToTokens(1n, 0n)).toThrow();
  });

  it("display quoteTokens agrees with the exact path within rounding", () => {
    const q = spotPriceQ(30_000_000_000n, 1_073_000_000_000_000n);
    const tokenUsd = tokenUsdFromPriceQ(q, SOL, 6);
    const exact = quoteTokensExact(400_000_000n, SOL, q, q);
    const approx = quoteTokens(400_000_000n, tokenUsd, 6);
    const diff = exact > approx ? exact - approx : approx - exact;
    expect(diff <= 40_000n).toBe(true); // < 1 lamport worth of tokens (1 lamport ~ 35_766 base units here)
    // $1 per whole token, 6 decimals: $90 discounted => 90 tokens
    expect(quoteTokens(100_000_000n, { price: 1n, expo: 0 }, 6)).toBe(90_000_000n);
    expect(quoteTokens(100_000_000n, { price: 5n, expo: -1 }, 6)).toBe(180_000_000n);
  });

  it("pump layouts", () => {
    const curve = new Uint8Array(151);
    curve.set([23, 183, 248, 55, 96, 216, 172, 96]);
    const dv = new DataView(curve.buffer);
    dv.setBigUint64(8, 1_073_000_000_000_000n, true);
    dv.setBigUint64(16, 30_000_000_000n, true);
    expect(parseBondingCurve(curve)).toEqual({ quoteLamports: 30_000_000_000n, baseUnits: 1_073_000_000_000_000n, complete: false });
    const pool = new Uint8Array(301);
    pool.set([241, 154, 109, 4, 17, 177, 109, 188]);
    pool.set(WSOL_MINT.toBytes(), 75);
    const pdv = new DataView(pool.buffer);
    pdv.setBigUint64(245, (1n << 64n) - 5_000_000_000n, true); // i128 = -5e9
    pdv.setBigInt64(253, -1n, true);
    const vault = (amt: bigint) => {
      const v = new Uint8Array(165);
      new DataView(v.buffer).setBigUint64(64, amt, true);
      return v;
    };
    expect(parsePumpPool(pool).virtualQuoteReserves).toBe(-5_000_000_000n);
    expect(poolSpotPriceQ(pool, vault(1_000n), vault(10_000_000_000n))).toBe(spotPriceQ(5_000_000_000n, 1_000n));
    expect(() => parsePumpPool(curve)).toThrow();
  });

  it("ema", () => {
    const p = PRICE_SCALE;
    expect(() => emaUpdate(0n, p)).toThrow(); // no seeding from spot
    expect(emaUpdate(p, p + p / 10n)).toBe(p + p / 200n); // 5% of a 10% gap
    expect(emaUpdate(p, 100n * p)).toBe(p + p / 50n); // clamped: +2% max
    expect(emaUpdate(p, 1n)).toBe(p - p / 50n);
    expect(withinBand(p + (p * 15n) / 100n, p, 1_500n)).toBe(true);
    expect(withinBand(p + (p * 15n) / 100n + 1n, p, 1_500n)).toBe(false);
    const c = { tokenEmaPriceSol: p, emaUpdatedAt: 1_000, emaWarmupCranks: 10, emaWarmupStartedAt: 300 };
    expect(tokenPricingStatus(c, p, 1_000)).toMatchObject({ ok: true, priceQ: p, pricedBy: "spot" });
    // slow EMA below spot and fast => it sets the price
    expect(tokenPricingStatus({ ...c, tokenSlowEmaPriceSol: (p * 95n) / 100n }, p, 1_000)).toMatchObject({ ok: true, priceQ: (p * 95n) / 100n, pricedBy: "slowEma" });
    // hourly token-block cap
    const capped = { ...c, tokenBlocksCapPerHour: 1_000, tokenBlocksAllowance: 3, tokenBlocksAllowanceUpdatedAt: 1_000 };
    expect(tokenPricingStatus(capped, p, 1_000, 4)).toMatchObject({ ok: false, reason: "capExhausted" });
    expect(tokenPricingStatus(capped, p, 1_000, 3)).toMatchObject({ ok: true, blocksAvailable: 3 });
    expect(tokenBlocksAvailable(capped, 1_000 + 1_800)).toBe(503);
    expect(tokenBlocksAvailable(capped, 1_000 + 99_999)).toBe(1_000);
    expect(slowEmaUpdate(p, 100n * p)).toBe(p + ((p * 4_000n) / 10_000n) * 30n / 14_400n);
    expect(buyPriceQ(p, p, p / 2n)).toBe(p / 2n);
    expect(tokenPricingStatus({ ...c, tokenEmaPriceSol: 0n }, p, 1_000)).toMatchObject({ reason: "notSeeded" });
    expect(tokenPricingStatus({ ...c, emaWarmupCranks: 9 }, p, 1_000)).toMatchObject({ reason: "warmingUp" });
    expect(tokenPricingStatus({ ...c, emaWarmupStartedAt: 401 }, p, 1_000)).toMatchObject({ reason: "warmingUp" });
    expect(tokenPricingStatus(c, p, 1_901)).toMatchObject({ reason: "stale" });
    expect(tokenPricingStatus(c, 2n * p, 1_000)).toMatchObject({ reason: "deviation" });
    expect(tokenPricingStatus(c, (p * 115n) / 100n, 1_000)).toMatchObject({ ok: true, pricedBy: "ema" });
    // crash: spot far below the EMA is still allowed (one-sided band), priced at spot
    expect(tokenPricingStatus(c, p / 2n, 1_000)).toMatchObject({ ok: true, priceQ: p / 2n, pricedBy: "spot" });
    expect(buyPriceQ(100n * p, p)).toBe(p);
    expect(() => buyPriceQ(p, 0n)).toThrow();
  });

  it("slippage + bids", () => {
    expect(withSlippage(10_000n, 100)).toBe(10_100n);
    expect(withSlippage(1n, 1)).toBe(2n);
    expect(minNextBid(0n)).toBe(100_000_000n);
    expect(minNextBid(100_000_000n)).toBe(110_000_000n);
    expect(minNextBid(1_000_000_000n)).toBe(1_050_000_000n);
    expect(minNextBid({ highestBid: 0n })).toBe(100_000_000n);
    expect(minNextBid({ highestBid: 1_000_000_000n })).toBe(1_050_000_000n);
  });

  it("estimateBurnForSolPurchase (estimate)", () => {
    const q = spotPriceQ(30_000_000_000n, 1_073_000_000_000_000n);
    const e = estimateBurnForSolPurchase(100_000_000n, q, SOL);
    expect(e.isEstimate).toBe(true);
    expect(e.lamports).toBe(666_666_667n);
    expect(e.buybackLamports).toBe(333_333_334n);
    expect(e.estimatedTokens).toBe((333_333_334n * PRICE_SCALE) / q);
    expect(() => estimateBurnForSolPurchase(1n, 0n, SOL)).toThrow();
  });
});
