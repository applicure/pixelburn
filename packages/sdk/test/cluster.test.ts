import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "../src/idl/pixel.json" with { type: "json" };
import {
  PROGRAM_ID, PROGRAM_IDS, SOL_USD_FEED_ID, buybackVaultPda, canvasPda, configPda, crankTokenPriceIx, initializeIx, programIdForCluster, setPriceSourceIx,
} from "../src/index.js";

const mainnet = PROGRAM_IDS["mainnet-beta"];
const devnet = PROGRAM_IDS.devnet;

describe("cluster-keyed program ids", () => {
  it("keeps the live devnet deployment as the default, and the id from the IDL", () => {
    expect(devnet.toBase58()).toBe("A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS");
    expect(PROGRAM_ID.equals(devnet)).toBe(true);
    expect(idl.address).toBe(devnet.toBase58());
  });
  it("has a fresh, distinct mainnet id", () => {
    expect(mainnet.equals(devnet)).toBe(false);
    expect(mainnet.toBase58()).not.toBe("11111111111111111111111111111111");
    expect(PublicKey.isOnCurve(mainnet.toBytes())).toBe(true); // a keypair's public key, not a PDA
  });
  it("resolves clusters and refuses unknown ones", () => {
    expect(programIdForCluster("devnet").equals(devnet)).toBe(true);
    expect(programIdForCluster("mainnet-beta").equals(mainnet)).toBe(true);
    expect(() => programIdForCluster("testnet")).toThrow(/testnet/);
    expect(() => programIdForCluster("toString")).toThrow();
  });
  it("derives different PDAs per program, and instructions target the requested program", () => {
    expect(configPda(mainnet).equals(configPda(devnet))).toBe(false);
    const k = () => Keypair.generate().publicKey;
    const admin = k();
    const curve = k();
    const init = initializeIx({
      admin, tokenMint: k(), treasury: k(), keeper: k(), pythFeedIdHex: SOL_USD_FEED_ID, priceSource: { kind: "bondingCurve", curve },
      buybackCapLamportsPerHour: 1n, buybackMaxSlippageBps: 1, initialTokenEmaPriceSol: 0n, programId: mainnet,
    });
    expect(init.programId.equals(mainnet)).toBe(true);
    const keys = init.keys.map((x) => x.pubkey.toBase58());
    expect(keys).toContain(mainnet.toBase58()); // the `program` account, whose IDL entry is pinned to the devnet id
    expect(keys).not.toContain(devnet.toBase58());
    for (const pda of [configPda(mainnet), canvasPda(mainnet), buybackVaultPda(mainnet)]) expect(keys).toContain(pda.toBase58());
    const crank = crankTokenPriceIx({ priceSource: { kind: "bondingCurve", curve }, programId: mainnet });
    expect(crank.programId.equals(mainnet)).toBe(true);
    const set = setPriceSourceIx({ admin, priceSource: { kind: "bondingCurve", curve }, initialEmaPriceSol: 1n, programId: mainnet });
    expect(set.programId.equals(mainnet)).toBe(true);
    expect(set.keys.map((x) => x.pubkey.toBase58())).not.toContain(configPda(devnet).toBase58());
  });
});
