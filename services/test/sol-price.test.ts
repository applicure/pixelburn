import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { BN } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { coder, PYTH_RECEIVER_PROGRAM_ID, pythPriceFeedAccount, SOL_USD_FEED_ID } from "@mpb/sdk";
import { loadConfig } from "../src/config.js";
import { makeSolPriceSource } from "../src/context.js";
import { HermesSolPrice, PythOnchainSolPrice, StaticTokenPrice } from "../src/pricing/prices.js";
import { QuoteService } from "../src/pricing/quote.js";
import { silentLogger } from "../src/lib/log.js";

/** A real PriceUpdateV2 account body, encoded with the IDL coder (same as the program reads). */
function priceUpdateAccount(price: bigint, expo: number, publishTime: number, verified = true) {
  const body = coder.types.encode("PriceUpdateV2", {
    write_authority: PublicKey.default,
    verification_level: verified ? { Full: {} } : { Partial: { num_signatures: 1 } },
    price_message: {
      feed_id: Array.from(Buffer.from(SOL_USD_FEED_ID, "hex")),
      price: new BN(price.toString()),
      conf: new BN(1_000_000),
      exponent: expo,
      publish_time: new BN(publishTime),
      prev_publish_time: new BN(publishTime - 1),
      ema_price: new BN(price.toString()),
      ema_conf: new BN(1_000_000),
    },
    posted_slot: new BN(1),
  });
  const data = Buffer.concat([createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8), body]);
  return { data, owner: PYTH_RECEIVER_PROGRAM_ID, lamports: 1, executable: false };
}

/** Connection stub serving one account; records which address was read. */
function fakeConn(account: ReturnType<typeof priceUpdateAccount> | null) {
  const reads: string[] = [];
  const conn = {
    getAccountInfo: async (k: PublicKey) => {
      reads.push(k.toBase58());
      return account;
    },
  } as unknown as Connection;
  return { conn, reads };
}

const now = () => Math.floor(Date.now() / 1000);

describe("production never invents prices", () => {
  it("token quotes report 'unknown' in production without a program instead of a static price", async () => {
    const { buildContext } = await import("../src/context.js");
    const { createDb } = await import("../src/db/client.js");
    const { testDatabaseUrl } = await import("./helpers.js");
    const cfg = loadConfig({ NODE_ENV: "production", DATABASE_URL: testDatabaseUrl() });
    const ctx = await buildContext(cfg, { db: createDb(cfg.DATABASE_URL, { max: 1 }), log: silentLogger, sol: { get: async () => ({ rawPrice: 150_000_000n, expo: -6, priceMicro: 150_000_000n, emaMicro: 150_000_000n, price: 150, publishTime: now(), stale: false }) } });
    const q = await ctx.quotes.quote(1, 1, "sol");
    expect(q).toMatchObject({ tokenPaymentStatus: "unknown", tokenPriceUsd: null, lamports: "666666667" });
    await expect(ctx.quotes.quote(1, 1, "token")).rejects.toThrow(/PROGRAM_ID not configured/);
    await ctx.handle.close();
  });
});

describe("SOL/USD without a Hermes key: on-chain Pyth sponsored feed", () => {
  it("reads the sponsored PriceUpdateV2 account via RPC and quotes chain-exact lamports", async () => {
    const { conn, reads } = fakeConn(priceUpdateAccount(15_000_000_000n, -8, now() - 5)); // $150.00000000
    const sol = makeSolPriceSource(loadConfig({ NODE_ENV: "production" }), conn, silentLogger);
    expect(sol).toBeInstanceOf(PythOnchainSolPrice);
    const p = await sol.get();
    expect(reads[0]).toBe(pythPriceFeedAccount().toBase58()); // same account the program reads
    expect(reads[0]).toBe("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
    expect([p.rawPrice, p.expo, p.price]).toEqual([15_000_000_000n, -8, 150]);
    // $100 at $150 (expo -8) => ceil(0.666.. SOL), same as chain math.rs usd_to_lamports
    const q = await new QuoteService(sol, new StaticTokenPrice(0.00001, 6), 6).quote(1, 1, "sol");
    expect(q.lamports).toBe("666666667");
  });

  it("refuses stale or unverified prices (the program would reject them too)", async () => {
    const stale = makeSolPriceSource(loadConfig({ NODE_ENV: "production" }), fakeConn(priceUpdateAccount(15_000_000_000n, -8, now() - 600)).conn, silentLogger);
    await expect(stale.get()).rejects.toThrow(/600s old \(max 120s\)/);
    const partial = makeSolPriceSource(loadConfig({}), fakeConn(priceUpdateAccount(15_000_000_000n, -8, now(), false)).conn, silentLogger);
    await expect(partial.get()).rejects.toThrow(/not fully verified/);
    const missing = makeSolPriceSource(loadConfig({ NODE_ENV: "production" }), fakeConn(null).conn, silentLogger);
    await expect(missing.get()).rejects.toThrow(/not found/);
  });

  it("never uses SOL_USD_FALLBACK in production; dev may fall back when the live source fails", async () => {
    const prod = makeSolPriceSource(loadConfig({ NODE_ENV: "production", SOL_USD_FALLBACK: "150" }), fakeConn(null).conn, silentLogger);
    await expect(prod.get()).rejects.toThrow(/not found/);
    const dev = makeSolPriceSource(loadConfig({ NODE_ENV: "development", SOL_USD_FALLBACK: "150" }), fakeConn(null).conn, silentLogger);
    expect(await dev.get()).toMatchObject({ price: 150, stale: true });
  });

  it("uses Hermes only when HERMES_API_KEY is set; honours a PYTH_SOL_USD_ACCOUNT override", async () => {
    expect(makeSolPriceSource(loadConfig({ HERMES_API_KEY: "k-123456" }), fakeConn(null).conn, silentLogger)).toBeInstanceOf(HermesSolPrice);
    const other = PublicKey.unique().toBase58();
    const { conn, reads } = fakeConn(priceUpdateAccount(15_000_000_000n, -8, now()));
    await makeSolPriceSource(loadConfig({ PYTH_SOL_USD_ACCOUNT: other }), conn, silentLogger).get();
    expect(reads).toEqual([other]);
  });
});
