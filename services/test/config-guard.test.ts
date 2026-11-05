import { PROGRAM_IDS } from "@mpb/sdk";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const devnet = PROGRAM_IDS.devnet.toBase58();
const mainnet = PROGRAM_IDS["mainnet-beta"].toBase58();

describe("cluster consistency guard", () => {
  it("accepts each deployment's own env", () => {
    expect(loadConfig({ SOLANA_CLUSTER: "devnet", PROGRAM_ID: devnet }).PROGRAM_ID).toBe(devnet);
    expect(loadConfig({ SOLANA_CLUSTER: "mainnet-beta", PROGRAM_ID: mainnet, IRYS_KEY: "k", IRYS_NETWORK: "mainnet" }).PROGRAM_ID).toBe(mainnet);
    expect(loadConfig({ SOLANA_CLUSTER: "devnet", IRYS_KEY: "k" }).IRYS_NETWORK).toBe("devnet");
  });
  it("refuses a program id from the other cluster", () => {
    expect(() => loadConfig({ SOLANA_CLUSTER: "mainnet-beta", PROGRAM_ID: devnet })).toThrow(/devnet program/);
    expect(() => loadConfig({ SOLANA_CLUSTER: "devnet", PROGRAM_ID: mainnet })).toThrow(/mainnet-beta program/);
  });
  it("refuses any other program id on mainnet", () => {
    expect(() => loadConfig({ SOLANA_CLUSTER: "mainnet-beta", PROGRAM_ID: "11111111111111111111111111111111" })).toThrow(/not the mainnet program/);
  });
  it("refuses an Irys network that doesn't match the cluster, including the devnet default on mainnet", () => {
    expect(() => loadConfig({ SOLANA_CLUSTER: "mainnet-beta", IRYS_KEY: "k" })).toThrow(/IRYS_NETWORK=mainnet/);
    expect(() => loadConfig({ SOLANA_CLUSTER: "devnet", IRYS_KEY: "k", IRYS_NETWORK: "mainnet" })).toThrow(/IRYS_NETWORK=devnet/);
  });
});
