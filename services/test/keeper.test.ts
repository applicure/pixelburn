import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Keeper, type KeeperConfig } from "../src/keeper/keeper.js";
import type { KeeperActions } from "../src/keeper/actions.js";
import { minBuybackTokens } from "../src/keeper/plan.js";
import { silentLogger } from "../src/lib/log.js";
import { FakeChain, randKey } from "./helpers.js";

const cfg = (live: boolean): KeeperConfig => ({
  live, tokenMint: randKey(), crankIntervalMs: 60_000, buybackIntervalMs: 1, buybackJitterMs: 1,
  maxChunkLamports: 2_000_000_000n, minChunkLamports: 500_000_000n, maxPerRunLamports: 3_000_000_000n, reserveLamports: 0n,
  slippageBps: 100, maxPriceImpactPct: 1, jupiterApiUrl: "https://jup.invalid", jito: { enabled: false, url: "", tipLamports: 0 },
  chunkDelayMs: { min: 0, jitter: 1 },
});

const dummyIx = () => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) });

/** Connection whose every method throws: proves dry-run touches nothing that sends. */
const explodingConn = new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : () => { throw new Error(`conn.${String(p)} called`); }) }) as unknown as Connection;

afterEach(() => vi.unstubAllGlobals());

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
    chain.fetchBuybackVaultLamports = async () => 5_000_000_000n;
    const k = new Keeper(explodingConn, null, actions, chain, cfg(false), silentLogger, async () => {});
    expect(await k.crankOnce()).toBeNull();
    const r = await k.buybackOnce();
    expect(r.sent).toEqual([]);
    expect(r.chunks.reduce((a, b) => a + b, 0n)).toBe(3_000_000_000n); // capped per run
    expect(calls.filter((c) => c.startsWith("record")).length).toBe(r.chunks.length);
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
