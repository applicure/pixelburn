/**
 * Pyth pull-oracle helpers. Separate entry point (`@mpb/sdk/pyth`).
 *
 * Default buy flow does NOT need this: `buildBuyWithSolIxs` reads Pyth's sponsored SOL/USD price-feed account
 * (fully verified, kept fresh by Pyth). Use this module when you want to post your own fresh update from Hermes.
 *
 * The program requires `VerificationLevel::Full`, i.e. the encoded-VAA flow (2+ transactions). Posting uses the
 * official `@pythnetwork/pyth-solana-receiver` client, an OPTIONAL peer dependency loaded lazily. Its dependency
 * chain (jito-ts -> @solana/web3.js 1.77) needs the pnpm override `"jito-ts>@solana/web3.js": "^1.98.4"` in
 * pnpm-workspace.yaml (pnpm 11 ignores package.json#pnpm); see chain/NOTES.md "Requests".
 *
 * Hermes requires an API key now. Never ship that key to browsers: post updates server-side if at all.
 */
import type { Connection, PublicKey, Signer, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { DEFAULT_HERMES_URL, SOL_USD_FEED_ID } from "./constants.js";
import type { PythPrice } from "./client.js";

/** Minimal wallet shape accepted by the Pyth receiver client. */
export interface PythWallet {
  publicKey: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (tx: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signAllTransactions: (txs: any[]) => Promise<any[]>;
}

interface HermesLatest {
  binary: { encoding: string; data: string[] };
  parsed?: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[];
}

/** Latest SOL/USD from Hermes REST: base64 accumulator payloads (for posting) + the parsed price (for quotes). */
export async function fetchHermesSolUsd(
  hermesUrl = DEFAULT_HERMES_URL,
  fetchImpl: typeof fetch = fetch,
  /** Hermes now answers 401 without `Authorization: Bearer <key>`. */
  apiKey?: string,
): Promise<{ updateData: string[]; price: PythPrice }> {
  const url = `${hermesUrl.replace(/\/$/, "")}/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&encoding=base64&parsed=true`;
  const res = await fetchImpl(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
  if (!res.ok) throw new Error(`Hermes ${res.status}`);
  const body = (await res.json()) as HermesLatest;
  const p = body.parsed?.find((x) => x.id.replace(/^0x/, "") === SOL_USD_FEED_ID);
  if (!p) throw new Error("Hermes response missing SOL/USD");
  return {
    updateData: body.binary.data,
    price: {
      price: BigInt(p.price.price),
      conf: BigInt(p.price.conf),
      expo: p.price.expo,
      publishTime: p.price.publish_time,
      feedId: SOL_USD_FEED_ID,
      verified: false, // off-chain value; only the posted account is verified
    },
  };
}

type ReceiverModule = typeof import("@pythnetwork/pyth-solana-receiver");

/**
 * Loads the receiver client. Its ESM build has an extensionless import (jito-ts) that Node's ESM loader rejects,
 * so on Node we fall back to the CJS build via createRequire. Bundlers take the first branch.
 */
async function loadReceiver(): Promise<ReceiverModule> {
  try {
    return await import("@pythnetwork/pyth-solana-receiver");
  } catch (e) {
    const isNode = typeof process !== "undefined" && !!process.versions?.node;
    if (!isNode) throw e;
    // Non-literal specifier: bundlers leave it alone (this branch only runs on Node).
    const nodeModule = "node:module";
    const { createRequire } = (await import(/* webpackIgnore: true */ /* @vite-ignore */ nodeModule)) as typeof import("node:module");
    return createRequire(import.meta.url)("@pythnetwork/pyth-solana-receiver") as ReceiverModule;
  }
}

async function receiverFor(connection: Connection, wallet: PythWallet) {
  const mod = await loadReceiver();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new mod.PythSolanaReceiver({ connection, wallet: wallet as any });
}

/**
 * Post-price-update instructions (fully verified). Returns the instructions with their ephemeral signers,
 * the PriceUpdateV2 account to pass to `buy_with_*`, and close instructions to reclaim rent afterwards.
 */
export async function buildPostPriceUpdateIxs(p: { connection: Connection; wallet: PythWallet; hermesUrl?: string; hermesApiKey?: string }) {
  const receiver = await receiverFor(p.connection, p.wallet);
  const { updateData } = await fetchHermesSolUsd(p.hermesUrl, fetch, p.hermesApiKey);
  const r = await receiver.buildPostPriceUpdateInstructions(updateData);
  const acct: PublicKey | undefined =
    r.priceFeedIdToPriceUpdateAccount["0x" + SOL_USD_FEED_ID] ?? r.priceFeedIdToPriceUpdateAccount[SOL_USD_FEED_ID];
  if (!acct) throw new Error("Hermes update did not include SOL/USD");
  return { postInstructions: r.postInstructions, priceUpdateAccount: acct, closeInstructions: r.closeInstructions };
}

/**
 * Full flow: post a fresh SOL/USD update, then `makeIxs(priceUpdateAccount)` (e.g. `buyWithSolIx`), then close the
 * update accounts. Returns versioned transactions + ephemeral signers for `signAllTransactions`.
 */
export async function buildTransactionsWithFreshPrice(p: {
  connection: Connection;
  wallet: PythWallet;
  makeIxs: (priceUpdate: PublicKey) => Promise<TransactionInstruction[]> | TransactionInstruction[];
  hermesUrl?: string;
  hermesApiKey?: string;
  closeUpdateAccounts?: boolean;
  computeUnitPriceMicroLamports?: number;
}): Promise<{ tx: VersionedTransaction; signers: Signer[] }[]> {
  const receiver = await receiverFor(p.connection, p.wallet);
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: p.closeUpdateAccounts ?? true });
  await builder.addPostPriceUpdates((await fetchHermesSolUsd(p.hermesUrl, fetch, p.hermesApiKey)).updateData);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (id: string) => PublicKey) => {
    const ixs = await p.makeIxs(getPriceUpdateAccount("0x" + SOL_USD_FEED_ID));
    return ixs.map((instruction) => ({ instruction, signers: [] }));
  });
  return builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: p.computeUnitPriceMicroLamports ?? 50_000 }) as Promise<
    { tx: VersionedTransaction; signers: Signer[] }[]
  >;
}
