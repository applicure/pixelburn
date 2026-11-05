/**
 * Chain boundary. Everything that builds or sends a transaction goes through here.
 *
 * The interface mirrors SPEC "SDK @mpb/sdk": instruction builders return web3.js v1
 * TransactionInstruction[] (including Pyth price-update post ixs via Hermes).
 *
 * Mock mode (no NEXT_PUBLIC_API_URL) simulates the flow locally; otherwise `sdkChain`
 * builds the real instructions with @mpb/sdk, wraps them in a v0 transaction and
 * asks the connected wallet to sign and send.
 */
import type { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { normTokenStatus, tokenStatusCopy, type TokenStatus } from "./tokenStatus";
import { CLUSTER, USE_MOCK } from "./config";
import type { PayMode, Rect } from "./types";

export interface BuyParams {
  owner: PublicKey | string;
  rect: Rect;
  title: string;
  link: string;
  imageUri: string;
  imageSha256: string; // hex, 32 bytes
  payMode: PayMode;
  /** slippage guards from the quote: max_lamports for SOL, max_tokens for $PXL */
  maxLamports?: bigint;
  maxTokens?: bigint;
  /** preview URL so the mock can draw the user's image immediately */
  previewUrl?: string;
}

export interface BuyResult {
  signature: string;
  /** Read back from the confirmed Ad account (its id is a counter, not derivable from the position). null if that read failed. */
  adId: number | null;
  adAddress?: string;
  /** What the transaction burned, when `exact`. Otherwise the quote: the program prices the burn at execution. */
  tokensBurned: bigint;
  lamports: bigint;
  /** True when the figures come from the chain rather than the quote. */
  exact: boolean;
}

export type BuyStep = "building" | "signing" | "confirming" | "done";

export interface WalletSigner {
  publicKey: PublicKey | null;
  sendTransaction?: (tx: Transaction | VersionedTransaction, connection: Connection) => Promise<string>;
}

export interface ChainClient {
  readonly mode: "sdk" | "mock";
  buy(p: BuyParams, wallet: WalletSigner, connection: Connection | null, onStep?: (s: BuyStep) => void): Promise<BuyResult>;
  bid(lamports: bigint, wallet: WalletSigner, connection: Connection | null): Promise<{ signature: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mockChain: ChainClient = {
  mode: "mock",
  async buy(p, _wallet, _connection, onStep) {
    onStep?.("building");
    await sleep(700);
    onStep?.("signing");
    await sleep(1100);
    onStep?.("confirming");
    await sleep(1300);
    const w = (await import("./mock")).mockWorld();
    const q = w.quote(p.rect.w, p.rect.h, p.payMode);
    const lamports = p.payMode === "sol" ? BigInt(q.lamports ?? "0") : 0n;
    const tokens = p.payMode === "token" ? BigInt(q.tokens ?? "0") : 0n;
    const ad = w.commitUserPurchase({
      owner: typeof p.owner === "string" ? p.owner : p.owner.toBase58(),
      rect: p.rect,
      title: p.title,
      link: p.link,
      imageUrl: p.previewUrl ?? p.imageUri,
      payMode: p.payMode,
      lamports,
      tokens,
    });
    onStep?.("done");
    // In SOL mode the burn happens later via buyback; report the expected share at today's price.
    const tokensBurned = p.payMode === "token" ? tokens : w.tokensFor(lamports / 2n);
    return { signature: `mock${ad.id}${Date.now().toString(36)}`, adId: ad.id, tokensBurned, lamports, exact: true };
  },
  async bid() {
    await sleep(1200);
    return { signature: `mockbid${Date.now().toString(36)}` };
  },
};

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown before anything is signed when the program would reject a token payment. */
export class TokenPaymentUnavailable extends Error {
  constructor(public status: TokenStatus) {
    super(tokenStatusCopy(status, 0, null)?.body ?? "Token payments are unavailable right now.");
  }
}

/**
 * Simulate first (never ask a wallet to sign something that will fail), then sign + send,
 * then confirm by polling getSignatureStatuses. The /api/rpc proxy is HTTP-only, so the
 * websocket-based confirmTransaction is avoided on purpose.
 */
async function simulateSendConfirm(
  tx: Transaction | VersionedTransaction,
  lastValidBlockHeight: number,
  wallet: WalletSigner,
  connection: Connection,
  onStep?: (s: BuyStep) => void,
) {
  const { VersionedTransaction: VT } = await import("@solana/web3.js");
  const vtx = tx instanceof VT ? tx : new VT((tx as Transaction).compileMessage());
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).join("\n");
    const code = /custom program error: (0x[0-9a-f]+)/i.exec(logs)?.[1];
    const anchorMsg = /Error Message: ([^\n.]+)/.exec(logs)?.[1];
    throw new Error(
      `This purchase would fail on-chain${anchorMsg ? `: ${anchorMsg}` : code ? ` (error ${code})` : ""}. Nothing was signed or charged.`,
    );
  }
  onStep?.("signing");
  const signature = await wallet.sendTransaction!(tx, connection);
  onStep?.("confirming");
  for (let i = 0; ; i++) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st?.err) throw new Error("The transaction failed on-chain. Only the network fee was spent; try again.");
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;
    if (i % 5 === 4 && (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight)
      throw new Error("The transaction expired before it landed. Nothing was charged; try again.");
    await sleepMs(1200);
  }
}

/** Real chain client backed by @mpb/sdk (loaded on demand so the mock path never pays for Anchor). */
const sdkChain: ChainClient = {
  mode: "sdk",
  async buy(p, wallet, connection, onStep) {
    if (!connection || !wallet.publicKey || !wallet.sendTransaction) throw new Error("Connect a wallet to buy blocks.");
    onStep?.("building");
    const sdk = await import("@mpb/sdk");
    const content = { title: p.title, link: p.link, imageUri: p.imageUri, imageSha256: p.imageSha256 };
    const problem = sdk.validateAdContent(content);
    if (problem) throw new Error(`Can't buy yet: ${problem}.`);
    let built: Awaited<ReturnType<typeof sdk.buildBuyTx>>;
    try {
      built = await sdk.buildBuyTx(connection, { mode: p.payMode, buyer: wallet.publicKey, rect: p.rect, content, slippageBps: 150, programId: sdk.programIdForCluster(CLUSTER) });
    } catch (e) {
      if (e instanceof sdk.TokenPricingUnavailableError) throw new TokenPaymentUnavailable(normTokenStatus(e.reason));
      throw e;
    }
    const q = built.quote;
    if ("lamports" in q && p.maxLamports && q.lamports > p.maxLamports)
      throw new Error("The SOL price moved past your quote. Review the new price and buy again.");
    if ("tokens" in q && p.maxTokens && q.tokens > p.maxTokens)
      throw new Error("The token price moved past your quote. Review the new amount and buy again.");
    const signature = await simulateSendConfirm(built.transaction, built.lastValidBlockHeight, wallet, connection, onStep);
    onStep?.("done");
    // The purchase is final here, so this read must never fail it. The share panel copes with a null id.
    let onchain: Awaited<ReturnType<typeof sdk.fetchAd>> = null;
    for (let i = 0; i < 3 && !onchain; i++) {
      try {
        onchain = await sdk.fetchAd(connection, q.ad);
      } catch {
        /* retry */
      }
      if (!onchain && i < 2) await sleepMs(1000);
    }
    return {
      signature,
      adId: onchain ? onchain.id : null,
      adAddress: q.ad.toBase58(),
      tokensBurned: onchain ? onchain.paidTokens : "tokens" in q ? q.tokens : 0n,
      lamports: onchain ? onchain.paidLamports : "lamports" in q ? q.lamports : 0n,
      exact: !!onchain,
    };
  },
  async bid(lamports, wallet, connection) {
    if (!connection || !wallet.publicKey || !wallet.sendTransaction) throw new Error("Connect a wallet to bid.");
    const sdk = await import("@mpb/sdk");
    const { TransactionMessage, VersionedTransaction: VT } = await import("@solana/web3.js");
    const built = await sdk.buildBidIxs(connection, { bidder: wallet.publicKey, lamports, programId: sdk.programIdForCluster(CLUSTER) });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new VT(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: built.instructions }).compileToV0Message());
    return { signature: await simulateSendConfirm(tx, lastValidBlockHeight, wallet, connection) };
  },
};

export const chain: ChainClient = USE_MOCK ? mockChain : sdkChain;
