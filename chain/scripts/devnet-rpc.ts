/**
 * The ONLY way chain scripts get an RPC connection. Devnet only, enforced two ways:
 *  1. URL source: DEVNET_RPC_URL, else Helius devnet (SOLANA_RPC_HELIUS_KEY), else clusterApiUrl("devnet").
 *     SOLANA_RPC is deliberately NOT read: in the root .env it is the mainnet endpoint.
 *  2. Hard guard: the cluster's genesis hash must be devnet's, otherwise the process exits 1 before anything is sent.
 * Never prints URLs or keys.
 */
import { Connection, clusterApiUrl } from "@solana/web3.js";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function devnetRpcUrl(): { url: string; label: string } {
  if (process.env.DEVNET_RPC_URL) return { url: process.env.DEVNET_RPC_URL, label: "DEVNET_RPC_URL (redacted)" };
  if (process.env.SOLANA_RPC_HELIUS_KEY)
    return { url: `https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC_HELIUS_KEY}`, label: "Helius devnet (key redacted)" };
  return { url: clusterApiUrl("devnet"), label: "public devnet" };
}

export function redact(text: string): string {
  let out = text;
  for (const secret of [process.env.DEVNET_RPC_URL, process.env.SOLANA_RPC_HELIUS_KEY, process.env.SOLANA_RPC]) {
    if (secret) out = out.split(secret).join("<redacted>");
  }
  return out.replace(/api-key=[^&\s"']+/gi, "api-key=<redacted>");
}

/** Connects and verifies the genesis hash; exits(1) on anything that is not devnet. */
export async function devnetConnection(commitment: "confirmed" | "finalized" = "confirmed"): Promise<{ connection: Connection; label: string }> {
  const { url, label } = devnetRpcUrl();
  const connection = new Connection(url, commitment);
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (e) {
    console.error(`cannot verify cluster (${label}): ${redact(String((e as Error).message ?? e))}`);
    process.exit(1);
  }
  if (genesis !== DEVNET_GENESIS_HASH) {
    console.error(`REFUSING: ${label} is not devnet (genesis ${genesis}, expected ${DEVNET_GENESIS_HASH})`);
    process.exit(1);
  }
  return { connection, label };
}
