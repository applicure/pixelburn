// A PUMP-paired coin on the deployed program: SOL quotes and stats must work, and token pricing must read as a state, not an error.
import { PublicKey } from "@solana/web3.js";
import { PUMP_QUOTE_MINT } from "@mpb/sdk";
import { describe, expect, it } from "vitest";
import { RpcChainReader } from "../src/chain/accounts.js";
import { OnchainTokenPrice, TokenPricingUnavailable } from "../src/pricing/prices.js";
import { QuoteService } from "../src/pricing/quote.js";

const curveKey = new PublicKey("1243xDdU9d4F7s2hEAwi2oZwNTRWpvAPJhPXFsupR86");
const curve = new Uint8Array(166);
curve.set([23, 183, 248, 55, 96, 216, 172, 96]);
new DataView(curve.buffer).setBigUint64(8, 1_073_000_000_000_000n, true);
new DataView(curve.buffer).setBigUint64(16, 998_139_534_885n, true);
curve.set(PUMP_QUOTE_MINT.toBytes(), 83);

const reader = () => {
  const conn = { getAccountInfo: async () => ({ owner: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), data: Buffer.from(curve) }) };
  const r = new RpcChainReader(conn as never, "C44yH6k1btWPyRhyE3ub855RnCrBFgZqfjB8waFq7yu9", undefined);
  r.fetchConfig = async () => ({ priceSource: { kind: "bondingCurve", curve: curveKey }, tokenEmaPriceSol: 0n, tokenSlowEmaPriceSol: 0n }) as never;
  return r;
};
const sol = { get: async () => ({ rawPrice: 15_000_000_000n, expo: -8, priceMicro: 150_000_000n, emaMicro: 150_000_000n, price: 150, publishTime: 0, stale: false }) };

describe("PUMP-paired coin", () => {
  it("reports token pricing as upgrade_pending and still quotes SOL", async () => {
    const q = new QuoteService(sol, new OnchainTokenPrice(reader()), 6);
    const dto = await q.quote(1, 1, "sol");
    expect(dto.lamports).toBe("666666667");
    expect(dto.tokenPaymentStatus).toBe("upgrade_pending");
    expect(dto.tokenPriceUsd).toBeNull();
  });
  it("gives the typed refusal for a token quote", async () => {
    const q = new QuoteService(sol, new OnchainTokenPrice(reader()), 6);
    await expect(q.quote(1, 1, "token")).rejects.toBeInstanceOf(TokenPricingUnavailable);
  });
  it("is the later phase", async () => {
    expect(await reader().fetchBuybackPhase("mainnet-beta")).toBe("later");
  });
});
