import { describe, expect, it } from "vitest";
import {
  applyTokenDiscount,
  effectiveTokenPrice,
  lamportsToTokens,
  quoteLamports,
  quoteTokensForUsd,
  quoteUsd,
  solPerTokenToQ,
  tokenUsdPerToken,
  usdToLamports,
} from "../src/lib/quote-math.js";
import { pythToMicro, StaticSolPrice, type TokenPriceSource } from "../src/pricing/prices.js";
import { QuoteService } from "../src/pricing/quote.js";
import { spotPriceQ as spotFromReserves } from "@mpb/sdk";

// Expected values mirror chain/programs/pixel/src/math.rs (ceil everywhere the buyer pays).
describe("quote math (chain-identical)", () => {
  it("prices $100 per block", () => {
    expect(quoteUsd(1, 1)).toBe(100_000_000n);
    expect(quoteUsd(10, 10)).toBe(10_000_000_000n);
  });

  it("converts USD to lamports with raw Pyth price/expo, rounding up", () => {
    // same case as math.rs test: $100 at $150.00000000 (expo -8) => 0.6666.. SOL => ceil
    expect(usdToLamports(100_000_000n, 15_000_000_000n, -8)).toBe(666_666_667n);
    expect(quoteLamports(100_000_000n, 150_000_000n)).toBe(666_666_667n);
    expect(usdToLamports(150_000_000n, 150n, 0)).toBe(1_000_000_000n); // positive shift branch
    expect(usdToLamports(100_000_000n, 15n, 1)).toBe(666_666_667n); // expo > 3 branch
  });

  it("applies the 10% token discount, rounded up", () => {
    expect(applyTokenDiscount(100_000_000n)).toBe(90_000_000n);
    expect(applyTokenDiscount(11n)).toBe(10n); // 9.9 -> 10 (never under-charges)
  });

  it("uses min(spot, ema): pumping spot never lowers tokens owed", () => {
    const ema = 10n ** 16n;
    expect(effectiveTokenPrice(ema * 3n, ema)).toBe(ema);
    expect(effectiveTokenPrice(ema / 2n, ema)).toBe(ema / 2n);
    const pumped = quoteTokensForUsd(100_000_000n, ema * 3n, ema, 150_000_000n, -6);
    const fair = quoteTokensForUsd(100_000_000n, ema, ema, 150_000_000n, -6);
    const dumped = quoteTokensForUsd(100_000_000n, ema / 2n, ema, 150_000_000n, -6);
    expect(pumped).toBe(fair);
    expect(dumped).toBe(fair * 2n);
    expect(() => effectiveTokenPrice(ema, 0n)).toThrow(/EMA/);
  });

  it("computes tokens for a $100 block with discount", () => {
    // token = 0.00001 SOL = 10_000 lamports per whole token (6dp) -> q = 0.01 * 1e18 = 1e16
    const q = solPerTokenToQ(0.00001, 6);
    expect(q).toBe(10n ** 16n);
    // $90 at $150 = 600_000_000 lamports -> / 0.01 lamports per base unit = 6e10 base units = 60,000 tokens
    expect(quoteTokensForUsd(100_000_000n, q, q, 150_000_000n, -6)).toBe(60_000_000_000n);
    expect(tokenUsdPerToken(q, 150, 6)).toBeCloseTo(0.0015, 10);
  });

  it("rounds tokens up", () => {
    expect(lamportsToTokens(1n, 3n * 10n ** 18n)).toBe(1n); // 1/3 -> 1
    expect(lamportsToTokens(10n, 3n * 10n ** 18n)).toBe(4n); // 3.33 -> 4
  });

  it("derives spot q from reserves like spot_price_q (floored)", () => {
    expect(spotFromReserves(30_000_000_000n, 1_073_000_000_000_000n)).toBe((30_000_000_000n * 10n ** 18n) / 1_073_000_000_000_000n);
  });

  it("scales Pyth prices to micro-USD", () => {
    expect(pythToMicro("15012345678", -8)).toBe(150_123_456n);
    expect(pythToMicro(15, 0)).toBe(15_000_000n);
  });
});

describe("QuoteService", () => {
  const spot = solPerTokenToQ(0.00002, 6);
  const ema = solPerTokenToQ(0.00001, 6);
  const token: TokenPriceSource = { get: async () => ({ spot, ema, source: "test" }) };
  const svc = new QuoteService(new StaticSolPrice(150), token, 6);

  it("returns SPEC shape for SOL mode", async () => {
    const q = await svc.quote(2, 3, "sol", 1_000);
    expect(q).toMatchObject({ usd: 600, lamports: "4000000000", solPriceUsd: 150, discountBps: 1000, expiresAt: 1_060, tokenPaymentStatus: "ok", tokenPaymentDetail: null });
    expect(q.tokens).toBeUndefined();
  });

  it("refuses token quotes while the program would refuse token payments (e.g. EMA warming up)", async () => {
    const warming = new QuoteService(new StaticSolPrice(150), {
      get: async () => ({ spot, ema, source: "test", unavailable: { reason: "warmingUp", detail: "EMA warm-up 3/10 cranks" } }),
    }, 6);
    await expect(warming.quote(1, 1, "token")).rejects.toMatchObject({ reason: "warming_up" });
    const sol = await warming.quote(1, 1, "sol"); // SOL payments unaffected, status explains why $PIXEL is off
    expect(sol.lamports).toBeDefined();
    expect(sol).toMatchObject({ tokenPaymentStatus: "warming_up", tokenPaymentDetail: "EMA warm-up 3/10 cranks" });
    const capped = new QuoteService(new StaticSolPrice(150), {
      get: async () => ({ spot, ema, source: "test", unavailable: { reason: "capExhausted", detail: "only 0 token-paid blocks left this hour" } }),
    }, 6);
    expect((await capped.quote(1, 1, "sol")).tokenPaymentStatus).toBe("hourly_cap");
    const future = new QuoteService(new StaticSolPrice(150), {
      get: async () => ({ spot, ema, source: "test", unavailable: { reason: "someNewReason", detail: "x" } }),
    }, 6);
    expect((await future.quote(1, 1, "sol")).tokenPaymentStatus).toBe("some_new_reason"); // generic camel->snake
    const broken = new QuoteService(new StaticSolPrice(150), { get: async () => { throw new Error("rpc down"); } }, 6);
    expect(await broken.quote(1, 1, "sol")).toMatchObject({ tokenPaymentStatus: "unknown", tokenPriceUsd: null });
  });

  it("prices tokens at min(spot, fast EMA, slow EMA) and passes the hourly-cap size through", async () => {
    let askedBlocks: number | undefined;
    const slowLow = new QuoteService(new StaticSolPrice(150), {
      get: async (blocks) => ((askedBlocks = blocks), { spot: spot, ema: spot, slow: ema, source: "test", pricedBy: "slowEma", blocksAvailable: 42 }),
    }, 6);
    const q = await slowLow.quote(1, 1, "token");
    expect(q.tokens).toBe("60000000000"); // slow EMA (0.00001 SOL) wins over spot/fast (0.00002)
    expect(q).toMatchObject({ tokenPricedBy: "slow_ema", tokenBlocksAvailable: 42, tokenPaymentStatus: "ok" });
    await slowLow.quote(4, 3, "sol");
    expect(askedBlocks).toBe(12);
  });

  it("returns tokens using min(spot, ema) and the discount", async () => {
    const q = await svc.quote(1, 1, "token", 1_000);
    expect(q.tokens).toBe("60000000000"); // priced at the lower EMA, not the pumped spot
    expect(q.tokenPriceUsd).toBeCloseTo(0.0015, 10);
    expect(q.lamports).toBeUndefined();
    expect(q.expiresAt).toBe(1_060);
  });
});
