import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Keeper, type KeeperConfig } from "../src/keeper/keeper.js";
import { sendIxsResult, type KeeperActions } from "../src/keeper/actions.js";
import { checkDeviation, minBuybackTokens } from "../src/keeper/plan.js";
import { JupiterRoute, type SwapRoute } from "../src/keeper/routes.js";
import { silentLogger } from "../src/lib/log.js";
import { FakeChain, randKey } from "./helpers.js";

const cfg = (live: boolean): KeeperConfig => ({
  live, tokenMint: randKey(), crankIntervalMs: 60_000, buybackIntervalMs: 1, buybackJitterMs: 1,
  maxChunkLamports: 2_000_000_000n, minChunkLamports: 500_000_000n, maxPerRunLamports: 3_000_000_000n, reserveLamports: 0n,
  slippageBps: 100, maxPriceImpactPct: 1, jupiterApiUrl: "https://jup.invalid", jito: { enabled: false, url: "", tipLamports: 0 },
  chunkDelayMs: { min: 0, jitter: 1 },
  buybackEnabled: true, outstandingGraceSecs: 900, maxSpotOverEmaPct: 10, maxRunPriceMovePct: 5,
});

const dummyIx = () => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) });

/** Connection whose every method throws: proves dry-run touches nothing that sends. */
const explodingConn = new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : () => { throw new Error(`conn.${String(p)} called`); }) }) as unknown as Connection;

afterEach(() => vi.unstubAllGlobals());
const Q = 10n ** 16n;

describe("keeper", () => {
  it("dry-run never touches the network for sending, even with ix builders available", async () => {
    const calls: string[] = [];
    const actions: KeeperActions = {
      crankTokenPriceIxs: async () => [dummyIx()],
      releaseBuybackIxs: async (_k, l) => (calls.push(`release ${l}`), [dummyIx()]),
      recordBuybackBurnIxs: async (_k, l, t) => (calls.push(`record ${l} ${t}`), [dummyIx()]),
    };
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/quote")) {
        return new Response(JSON.stringify({ inAmount: "1", outAmount: "1000000", otherAmountThreshold: "990000", priceImpactPct: "0.001", routePlan: [] }));
      }
      return new Response(JSON.stringify({ swapInstruction: { programId: PublicKey.default.toBase58(), accounts: [], data: "" }, addressLookupTableAddresses: [] }));
    });
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 5_000_000_000n;
    const routes = [new JupiterRoute(explodingConn, "https://jup.invalid", randKey(), 100, silentLogger)];
    const k = new Keeper(explodingConn, null, actions, chain, cfg(false), silentLogger, async () => {}, routes);
    expect(await k.crankOnce()).toBeNull();
    const r = await k.buybackOnce();
    expect(r.sent).toEqual([]);
    expect(r.chunks.reduce((a, b) => a + b, 0n)).toBe(3_000_000_000n); // capped per run
    expect(calls.filter((c) => c.startsWith("record")).length).toBe(r.chunks.length);
  });

  it("never releases without a swap: no route -> no release/record, run skipped", async () => {
    const calls: string[] = [];
    const actions: KeeperActions = {
      crankTokenPriceIxs: async () => [dummyIx()],
      releaseBuybackIxs: async () => (calls.push("release"), [dummyIx()]),
      recordBuybackBurnIxs: async () => (calls.push("record"), [dummyIx()]),
    };
    const noRoute: SwapRoute = { name: "none", plan: async () => null }; // e.g. Jupiter can't route PXTEST on devnet
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 5_000_000_000n;
    const k = new Keeper(explodingConn, null, actions, chain, cfg(false), silentLogger, async () => {}, [noRoute]);
    const r = await k.buybackOnce();
    expect(r.sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("caps a run at the on-chain releasable allowance and uses the first route that can serve", async () => {
    const planned: bigint[] = [];
    const curve: SwapRoute = { name: "pump-curve", plan: async (l) => (planned.push(l), { route: "pump-curve", minTokensOut: 10n ** 12n, lamportsSpent: l, impactPct: 0.5, build: async () => ({ ixs: [dummyIx()], lookupTables: [] }) }) };
    const jup: SwapRoute = { name: "jupiter", plan: async () => { throw new Error("must not be reached"); } };
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 50_000_000_000n;
    (chain as any).fetchBuybackReleasable = async () => 1_000_000_000n;
    const actions: KeeperActions = { crankTokenPriceIxs: async () => null, releaseBuybackIxs: async () => [dummyIx()], recordBuybackBurnIxs: async () => [dummyIx()] };
    const k = new Keeper(explodingConn, null, actions, chain, cfg(false), silentLogger, async () => {}, [curve, jup]);
    const r = await k.buybackOnce();
    expect(r.chunks.reduce((a, b) => a + b, 0n)).toBe(1_000_000_000n);
    expect(planned.reduce((a, b) => a + b, 0n)).toBe(1_000_000_000n);
  });

  it("an outstanding release blocks new releases: waits within grace, then resumes (buy+record, no release)", async () => {
    const calls: string[] = [];
    const actions: KeeperActions = {
      crankTokenPriceIxs: async () => null,
      releaseBuybackIxs: async () => (calls.push("release"), [dummyIx()]),
      recordBuybackBurnIxs: async (_k, l, t) => (calls.push(`record ${l} ${t}`), [dummyIx()]),
    };
    const route: SwapRoute = { name: "pumpswap-pool", plan: async (l) => ({ route: "pumpswap-pool", minTokensOut: 7n, lamportsSpent: l - 1n, impactPct: 1, build: async () => ({ ixs: [dummyIx()], lookupTables: [] }) }) };
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 5_000_000_000n;
    let since = 60;
    (chain as any).fetchBuybackOutstanding = async () => ({ lamports: 20_000_000n, sinceSecs: since });
    const k = new Keeper(explodingConn, null, actions, chain, cfg(false), silentLogger, async () => {}, [route]);
    expect(await k.buybackOnce()).toEqual({ chunks: [], sent: [] });
    expect(calls).toEqual([]); // within grace: nothing
    since = 1_000;
    await k.buybackOnce();
    expect(calls).toEqual(["record 19999999 7"]); // resumed with the outstanding lamports, never a new release
  });

  it("refunds an old outstanding release when no route can buy, and honours KEEPER_BUYBACK_ENABLED=0", async () => {
    const calls: string[] = [];
    const actions: KeeperActions = {
      crankTokenPriceIxs: async () => null,
      releaseBuybackIxs: async () => (calls.push("release"), [dummyIx()]),
      recordBuybackBurnIxs: async (_k, l, t) => (calls.push(`record ${l} ${t}`), [dummyIx()]),
    };
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 5_000_000_000n;
    (chain as any).fetchBuybackOutstanding = async () => ({ lamports: 20_000_000n, sinceSecs: 5_000 });
    await new Keeper(explodingConn, null, actions, chain, cfg(false), silentLogger, async () => {}, []).buybackOnce();
    expect(calls).toEqual(["record 0 0"]);
    calls.length = 0;
    await new Keeper(explodingConn, null, actions, chain, { ...cfg(false), buybackEnabled: false }, silentLogger, async () => {}, []).buybackOnce();
    expect(calls).toEqual([]);
  });

  it("deviation guard: never let a buyback push spot past the band", () => {
    const base = { emaQ: Q, runFactor: 1, maxSpotOverEmaPct: 10, maxRunPriceMovePct: 5 };
    expect(checkDeviation({ ...base, spotQ: Q, impactPct: 1 })).toMatchObject({ ok: true }); // 1.01^2 = +2.01%
    expect(checkDeviation({ ...base, spotQ: (Q * 111n) / 100n, impactPct: 0.1 })).toMatchObject({ ok: false }); // already +11%
    const near = checkDeviation({ ...base, spotQ: (Q * 108n) / 100n, impactPct: 1.5 }); // 1.08 * 1.015^2 = 1.1126
    expect(near.ok).toBe(false);
    expect(checkDeviation({ ...base, spotQ: Q, impactPct: 3 })).toMatchObject({ ok: false }); // 1.03^2 = +6.09% > 5% run cap
    const a = checkDeviation({ ...base, spotQ: Q, impactPct: 1 });
    if (!a.ok) throw new Error("first chunk should pass");
    // cumulative: two +2.01% chunks pass (4.06%), a third would exceed 5%
    const b = checkDeviation({ ...base, spotQ: Q, impactPct: 1, runFactor: a.runFactor });
    if (!b.ok) throw new Error("second chunk should pass");
    expect(checkDeviation({ ...base, spotQ: Q, impactPct: 1, runFactor: b.runFactor })).toMatchObject({ ok: false });
    expect(checkDeviation({ ...base, spotQ: null, impactPct: 0 })).toMatchObject({ ok: false }); // fail closed
  });

  it("stops a run before releasing once the projected move would breach the run cap", async () => {
    const calls: string[] = [];
    const actions: KeeperActions = {
      crankTokenPriceIxs: async () => null,
      releaseBuybackIxs: async (_k, l) => (calls.push(`release ${l}`), [dummyIx()]),
      recordBuybackBurnIxs: async () => [dummyIx()],
    };
    const route: SwapRoute = { name: "pumpswap-pool", plan: async (l) => ({ route: "pumpswap-pool", minTokensOut: 10n ** 12n, lamportsSpent: l, impactPct: 1.9, build: async () => ({ ixs: [dummyIx()], lookupTables: [] }) }) };
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 50_000_000_000n;
    const k = new Keeper(explodingConn, null, actions, chain, { ...cfg(false), maxPriceImpactPct: 8, minChunkLamports: 500_000_000n, maxChunkLamports: 500_000_000n, maxPerRunLamports: 2_000_000_000n }, silentLogger, async () => {}, [route]);
    await k.buybackOnce();
    // +3.84% per chunk: the first fits the 5% run cap, the second (7.8% cumulative) would not
    expect(calls).toEqual(["release 500000000"]);
  });

  it("sizes buys from the route's reserve cap (0.5% of effective quote) and skips too-thin pools", async () => {
    const released: bigint[] = [];
    const actions: KeeperActions = {
      crankTokenPriceIxs: async () => null,
      releaseBuybackIxs: async (_k, l) => (released.push(l), [dummyIx()]),
      recordBuybackBurnIxs: async () => [dummyIx()],
    };
    const mk = (cap: bigint): SwapRoute => ({
      name: "pumpswap-pool",
      maxQuoteIn: async () => cap,
      plan: async (l) => ({ route: "pumpswap-pool", minTokensOut: 10n ** 12n, lamportsSpent: l, impactPct: 0.6, quoteFractionPct: 0.5, build: async () => ({ ixs: [dummyIx()], lookupTables: [] }) }),
    });
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 50_000_000_000n;
    const base = { ...cfg(false), minChunkLamports: 5_000_000n, maxChunkLamports: 20_000_000n, maxPerRunLamports: 20_000_000n };
    await new Keeper(explodingConn, null, actions, chain, base, silentLogger, async () => {}, [mk(5_050_000n)]).buybackOnce();
    expect(released.every((l) => l <= 5_050_000n)).toBe(true);
    expect(released.length).toBeGreaterThan(0);
    released.length = 0;
    await new Keeper(explodingConn, null, actions, chain, base, silentLogger, async () => {}, [mk(4_000_000n)]).buybackOnce();
    expect(released).toEqual([]); // max buy < min chunk: skipped, nothing released
  });

  it("per-chunk impact cap measures price impact without fees (quoteIn/reserves)", async () => {
    const released: bigint[] = [];
    const actions: KeeperActions = {
      crankTokenPriceIxs: async () => null,
      releaseBuybackIxs: async (_k, l) => (released.push(l), [dummyIx()]),
      recordBuybackBurnIxs: async () => [dummyIx()],
    };
    // 0.5% of reserves + ~1.25% pool fee: fee-inclusive 1.75% would wrongly trip a 1% cap
    const route: SwapRoute = { name: "pumpswap-pool", plan: async (l) => ({ route: "pumpswap-pool", minTokensOut: 10n ** 12n, lamportsSpent: l, impactPct: 1.75, quoteFractionPct: 0.5, build: async () => ({ ixs: [dummyIx()], lookupTables: [] }) }) };
    const chain = new FakeChain();
    chain.fetchTokenPrice = async () => ({ spot: Q, ema: Q, slow: Q });
    chain.fetchBuybackVaultLamports = async () => 50_000_000_000n;
    const c = { ...cfg(false), maxPriceImpactPct: 1, minChunkLamports: 5_000_000n, maxChunkLamports: 5_000_000n, maxPerRunLamports: 5_000_000n };
    await new Keeper(explodingConn, null, actions, chain, c, silentLogger, async () => {}, [route]).buybackOnce();
    expect(released).toEqual([5_000_000n]);
  });

  it("projects with the larger of avg-price impact and quoteIn/reserves", () => {
    const r = checkDeviation({ spotQ: (Q * 105n) / 100n, emaQ: Q, impactPct: 0.2, quoteFractionPct: 2.5, runFactor: 1, maxSpotOverEmaPct: 10, maxRunPriceMovePct: 5 });
    expect(r.ok).toBe(false); // 1.05 * 1.025^2 = 1.103 > 1.10 (impact alone would have passed)
  });

  describe("L-B1: resolving an outstanding release", () => {
    /** Live-mode Connection stub: simulate returns the queued errors in order, then success. */
    function liveConn(simErrs: unknown[]) {
      const sent: string[] = [];
      const conn = {
        getLatestBlockhash: async () => ({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1_000 }),
        simulateTransaction: async () => ({ value: { err: simErrs.length ? simErrs.shift() : null, logs: [], unitsConsumed: 1 } }),
        sendRawTransaction: async () => (sent.push("tx"), "sig"),
        confirmTransaction: async () => ({ value: { err: null } }),
        getParsedTokenAccountsByOwner: async () => ({ value: [] }),
      } as unknown as Connection;
      return { conn, sent };
    }
    const outstandingChain = (spotOverEma = 1n) => {
      const chain = new FakeChain();
      chain.fetchTokenPrice = async () => ({ spot: Q * spotOverEma, ema: Q, slow: Q });
      chain.fetchBuybackVaultLamports = async () => 5_000_000_000n;
      (chain as any).fetchBuybackOutstanding = async () => ({ lamports: 20_000_000n, sinceSecs: 5_000 });
      return chain;
    };
    const recorder = () => {
      const calls: string[] = [];
      const actions: KeeperActions = {
        crankTokenPriceIxs: async () => null,
        releaseBuybackIxs: async () => (calls.push("release"), [dummyIx()]),
        recordBuybackBurnIxs: async (_k, l, t) => (calls.push(`record ${l} ${t}`), [dummyIx()]),
      };
      return { calls, actions };
    };
    const okRoute: SwapRoute = { name: "pumpswap-pool", plan: async (l) => ({ route: "pumpswap-pool", minTokensOut: 7n, lamportsSpent: l, impactPct: 0.8, quoteFractionPct: 0.4, build: async () => ({ ixs: [dummyIx()], lookupTables: [] }) }) };
    const live = { ...cfg(true), maxPriceImpactPct: 1, maxSpotOverEmaPct: 12 };

    it("checks the band first: outside it, refunds with record(0, 0) instead of buying", async () => {
      const { calls, actions } = recorder();
      const { conn } = liveConn([]);
      const chain = outstandingChain(2n); // spot 2x the fast EMA (boost wave)
      const k = new Keeper(conn, Keypair.generate(), actions, chain, live, silentLogger, async () => {}, [okRoute]);
      expect(await k.resolveOutstanding([])).toBe("resolved");
      expect(calls).toEqual(["record 0 0"]);
    });

    it.each([6035, 6034, 6033])("falls back to a refund when the resume tx is rejected with %i", async (code) => {
      const { calls, actions } = recorder();
      const { conn, sent } = liveConn([{ InstructionError: [2, { Custom: code }] }]);
      const k = new Keeper(conn, Keypair.generate(), actions, outstandingChain(), live, silentLogger, async () => {}, [okRoute]);
      const s: string[] = [];
      expect(await k.resolveOutstanding(s)).toBe("resolved");
      expect(calls).toEqual(["record 20000000 7", "record 0 0"]); // resume attempt, then refund
      expect(sent).toEqual(["tx"]); // only the refund was actually sent (resume failed in simulation)
      expect(s).toHaveLength(1);
    });

    it("only reports resolved after a confirmed signature (dry-run / other failures stay 'waiting')", async () => {
      const { actions } = recorder();
      const dry = new Keeper(explodingConn, null, actions, outstandingChain(), cfg(false), silentLogger, async () => {}, [okRoute]);
      expect(await dry.resolveOutstanding([])).toBe("waiting");
      const { conn } = liveConn([{ InstructionError: [2, { Custom: 6000 }] }]); // unrelated error: no refund
      const k = new Keeper(conn, Keypair.generate(), actions, outstandingChain(), live, silentLogger, async () => {}, [okRoute]);
      expect(await k.resolveOutstanding([])).toBe("waiting");
    });

    it("sendIxsResult never throws and has no signature on failure", async () => {
      const { conn } = liveConn([{ InstructionError: [1, { Custom: 6035 }] }]);
      const r = await sendIxsResult(conn, Keypair.generate(), [dummyIx()], { live: true }, silentLogger, "t");
      expect(r).toMatchObject({ ok: false, sig: null, errorCode: 6035 });
      const boom = await sendIxsResult(explodingConn, Keypair.generate(), [dummyIx()], { live: true }, silentLogger, "t");
      expect(boom).toMatchObject({ ok: false, sig: null });
    });
  });

  it("refuses to start live without a keypair", () => {
    expect(() => new Keeper(explodingConn, null, {} as KeeperActions, null, cfg(true), silentLogger)).toThrow(/KEEPER_KEYPAIR/);
    expect(() => new Keeper(explodingConn, Keypair.generate(), {} as KeeperActions, null, cfg(true), silentLogger)).not.toThrow();
  });

  it("mirrors the on-chain record_buyback_burn bar (EMA only)", () => {
    // 1 SOL at EMA q=1e16 (0.01 lamports per base unit) -> fair 1e11, 1% slippage -> 9.9e10
    expect(minBuybackTokens(1_000_000_000n, 10n ** 16n, 100)).toBe(99_000_000_000n);
  });
});
