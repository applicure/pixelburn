import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { NonSolQuoteError, PUMP_QUOTE_MINT, WSOL_MINT, buybackPhase, curveQuoteMint, parseBondingCurve, parseBondingCurveRaw, poolSpotPriceQ } from "../src/index.js";

const curve = (quote: PublicKey | null, len = 166) => {
  const d = new Uint8Array(len);
  d.set([23, 183, 248, 55, 96, 216, 172, 96]);
  const dv = new DataView(d.buffer);
  dv.setBigUint64(8, 1_073_000_000_000_000n, true);
  dv.setBigUint64(16, 998_139_534_885n, true);
  if (quote && len >= 115) d.set(quote.toBytes(), 83);
  return d;
};
const someMint = Keypair.generate().publicKey;

describe("curve quote mint", () => {
  it("reads SOL from the zero key, WSOL and a short legacy account", () => {
    expect(curveQuoteMint(curve(null)).equals(WSOL_MINT)).toBe(true);
    expect(curveQuoteMint(curve(WSOL_MINT)).equals(WSOL_MINT)).toBe(true);
    expect(curveQuoteMint(curve(null, 49)).equals(WSOL_MINT)).toBe(true);
    expect(parseBondingCurve(curve(null)).quoteLamports).toBe(998_139_534_885n);
  });
  it("never reads PUMP units as lamports", () => {
    expect(() => parseBondingCurve(curve(PUMP_QUOTE_MINT))).toThrow(NonSolQuoteError);
    expect(() => parseBondingCurve(curve(someMint))).toThrow(NonSolQuoteError);
    const raw = parseBondingCurveRaw(curve(PUMP_QUOTE_MINT));
    expect(raw.quoteMint.equals(PUMP_QUOTE_MINT)).toBe(true);
    expect(raw.quoteReserve).toBe(998_139_534_885n);
  });
  it("refuses a pool not quoted in WSOL", () => {
    const pool = new Uint8Array(301);
    pool.set([241, 154, 109, 4, 17, 177, 109, 188]);
    pool.set(PUMP_QUOTE_MINT.toBytes(), 75);
    const vault = new Uint8Array(165);
    new DataView(vault.buffer).setBigUint64(64, 1_000n, true);
    expect(() => poolSpotPriceQ(pool, vault, vault)).toThrow(NonSolQuoteError);
  });
});

describe("buybackPhase", () => {
  it("is later on mainnet before a coin exists, live on devnet", () => {
    expect(buybackPhase({ cluster: "mainnet-beta", hasConfig: false, quoteMint: null })).toBe("later");
    expect(buybackPhase({ cluster: "devnet", hasConfig: false, quoteMint: null })).toBe("live");
  });
  it("follows the coin's quote on any cluster", () => {
    for (const cluster of ["mainnet-beta", "devnet"]) {
      expect(buybackPhase({ cluster, hasConfig: true, quoteMint: WSOL_MINT })).toBe("live");
      expect(buybackPhase({ cluster, hasConfig: true, quoteMint: PUMP_QUOTE_MINT })).toBe("later");
    }
  });
  it("makes the claim that can't be false when the source is unreadable", () => {
    expect(buybackPhase({ cluster: "mainnet-beta", hasConfig: true, quoteMint: null })).toBe("later");
  });
});
