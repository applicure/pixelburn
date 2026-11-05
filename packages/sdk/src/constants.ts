import { PublicKey } from "@solana/web3.js";
import idl from "./idl/pixel.json" with { type: "json" };

export * from "./params.js";

/**
 * Default program id for helpers that take an optional `programId`: the IDL's address, which is the devnet deployment.
 * Anything that can run on mainnet must pass `programId` explicitly (`programIdForCluster(cluster)`), never rely on this.
 */
export const PROGRAM_ID = new PublicKey(idl.address);

export type SolanaCluster = "devnet" | "mainnet-beta";

/**
 * The deployments, one id per cluster. The two binaries differ only in `declare_id!` (cargo feature `mainnet`), so they share
 * this IDL and every instruction layout. Generated and synced by chain/scripts/mainnet-program-id.ts.
 */
export const PROGRAM_IDS: Readonly<Record<SolanaCluster, PublicKey>> = {
  devnet: new PublicKey("A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS"),
  "mainnet-beta": new PublicKey("C44yH6k1btWPyRhyE3ub855RnCrBFgZqfjB8waFq7yu9"),
};

export function programIdForCluster(cluster: string): PublicKey {
  const id = Object.hasOwn(PROGRAM_IDS, cluster) ? PROGRAM_IDS[cluster as SolanaCluster] : undefined;
  if (!id) throw new Error(`no pixel program on cluster "${cluster}"`);
  return id;
}

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
