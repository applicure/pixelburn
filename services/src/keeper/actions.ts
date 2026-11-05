// Keeper chain actions behind an interface. The concrete instruction builders must
// come from @mpb/sdk (ix layouts are owned by the chain workstream). Until the SDK
// exports them, `SdkKeeperActions` reports "unavailable" and the keeper only logs plans.
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { configPda, crankTokenPriceIx, decodeConfig, recordBuybackBurnIx, releaseBuybackIx } from "@mpb/sdk";
import type { Logger } from "../lib/log.js";

export interface KeeperActions {
  /** `crank_token_price()` ixs, or null when builders are unavailable. */
  crankTokenPriceIxs(keeper: PublicKey): Promise<TransactionInstruction[] | null>;
  /** `release_buyback(lamports)`: vault -> keeper, rate-limited on-chain. */
  releaseBuybackIxs(keeper: PublicKey, lamports: bigint): Promise<TransactionInstruction[] | null>;
  /**
   * `record_buyback_burn(lamports_spent, tokens_burned)`: the program burns `tokens` from the
   * keeper's token account, checks them against min_buyback_tokens and returns unspent SOL.
   */
  recordBuybackBurnIxs(keeper: PublicKey, lamportsSpent: bigint, tokensBurned: bigint): Promise<TransactionInstruction[] | null>;
}

/** Instruction builders from @mpb/sdk. Reads Config for the price source / mint / token program. */
export class SdkKeeperActions implements KeeperActions {
  constructor(
    private readonly conn: Connection,
    private readonly programId: PublicKey,
  ) {}

  private async config() {
    const info = await this.conn.getAccountInfo(configPda(this.programId), "confirmed");
    if (!info) throw new Error("pixel config account not found (program not initialised?)");
    return decodeConfig(info.data);
  }

  /** null before the program is initialised: a keeper started ahead of launch waits for Config instead of failing. */
  async crankTokenPriceIxs(): Promise<TransactionInstruction[] | null> {
    const info = await this.conn.getAccountInfo(configPda(this.programId), "confirmed");
    if (!info) return null;
    return [crankTokenPriceIx({ priceSource: decodeConfig(info.data).priceSource, programId: this.programId })];
  }

  async releaseBuybackIxs(keeper: PublicKey, lamports: bigint): Promise<TransactionInstruction[]> {
    return [releaseBuybackIx({ keeper, lamports, programId: this.programId })];
  }

  async recordBuybackBurnIxs(keeper: PublicKey, lamportsSpent: bigint, tokensBurned: bigint): Promise<TransactionInstruction[]> {
    const cfg = await this.config();
    return [
      recordBuybackBurnIx({
        keeper, tokenMint: cfg.tokenMint, tokenProgram: cfg.tokenProgram, priceSource: cfg.priceSource, lamportsSpent, tokensBurned, programId: this.programId,
      }),
    ];
  }
}

/** Used when PROGRAM_ID is unset: the keeper idles and logs. */
export class NoProgramActions implements KeeperActions {
  async crankTokenPriceIxs() {
    return null;
  }
  async releaseBuybackIxs() {
    return null;
  }
  async recordBuybackBurnIxs() {
    return null;
  }
}

export function loadKeypair(secret: string | undefined): Keypair | null {
  if (!secret) return null;
  const s = secret.trim();
  if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
  return Keypair.fromSecretKey(bs58.decode(s));
}

// Jito tip accounts (mainnet). One is picked at random per bundle.
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

export interface SendOptions {
  live: boolean;
  jito?: { enabled: boolean; url: string; tipLamports: number };
  priorityMicroLamports?: number;
  /** setComputeUnitLimit; omit for txs with external ixs of unknown cost (Jupiter). */
  computeUnitLimit?: number;
  /** Dry-run only: simulate the built tx and log the result (still never sends). */
  simulateInDryRun?: boolean;
}

/**
 * The ONLY place the keeper submits transactions. Refuses unless opts.live is true
 * (KEEPER_LIVE=1), so dry-run can never send by accident.
 */
export interface SendResult {
  /** Confirmed signature (live only); null for dry-run or any failure. */
  sig: string | null;
  ok: boolean;
  dryRun: boolean;
  /** Program custom error code (e.g. 6035) when the failure came from an instruction. */
  errorCode?: number;
  error?: string;
}

const customCode = (err: unknown): number | undefined => {
  const m = /"Custom":(\d+)/.exec(JSON.stringify(err ?? ""));
  return m ? Number(m[1]) : undefined;
};

/**
 * Build, simulate and (live only) send + confirm. NEVER throws: every failure comes back as
 * `{ ok: false, sig: null, errorCode?, error }`, and `sig` is only set for a CONFIRMED tx.
 * The only place the keeper submits transactions; refuses unless opts.live (KEEPER_LIVE=1).
 */
export async function sendIxsResult(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  opts: SendOptions,
  log: Logger,
  label: string,
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<SendResult> {
  try {
    if (!opts.live) {
      // Dry-run: build + SIMULATE the exact tx (never sent) so a dry run proves the tx would land.
      if (opts.simulateInDryRun) {
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [
          ...(opts.computeUnitLimit ? [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit })] : []),
          ...ixs,
        ] }).compileToV0Message(lookupTables);
        const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
        const tail = sim.value.logs?.filter((l) => /Program log: (Instruction|AnchorError)|failed|success/.test(l)).slice(-6).join(" | ");
        log.info(`[dry-run] ${label}: simulation ${sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "OK"} (${sim.value.unitsConsumed ?? "?"} CU) ${tail ?? ""}`);
        if (sim.value.err) return { sig: null, ok: false, dryRun: true, errorCode: customCode(sim.value.err), error: JSON.stringify(sim.value.err) };
      } else {
        log.info(`[dry-run] would send ${label} (${ixs.length} ixs)`);
      }
      return { sig: null, ok: true, dryRun: true };
    }
    const all: TransactionInstruction[] = [
      ...(opts.computeUnitLimit ? [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit })] : []),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports ?? 10_000 }),
      ...ixs,
    ];
    if (opts.jito?.enabled) {
      const tip = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
      all.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(tip), lamports: opts.jito.tipLamports }));
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) {
      return {
        sig: null, ok: false, dryRun: false, errorCode: customCode(sim.value.err),
        error: `${label} simulation failed: ${JSON.stringify(sim.value.err)} ${sim.value.logs?.slice(-5).join(" | ")}`,
      };
    }
    const raw = tx.serialize();
    const sig = bs58.encode(tx.signatures[0]!);
    if (opts.jito?.enabled) {
      const res = await fetch(opts.jito.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[bs58.encode(raw)]] }),
      });
      const body = (await res.json()) as { result?: string; error?: unknown };
      if (!res.ok || body.error) return { sig: null, ok: false, dryRun: false, error: `jito sendBundle failed: ${JSON.stringify(body.error ?? res.status)}` };
      log.info(`${label}: jito bundle ${body.result}`);
    } else {
      // Re-broadcast ourselves until confirmed or the blockhash expires (RPC-side maxRetries can
      // silently drop a tx, observed on a fresh local validator). Same signature => idempotent.
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    }
    log.debug(`${label}: sent ${sig}`);
    let done = false;
    const rebroadcast = (async () => {
      while (!done && !opts.jito?.enabled) {
        await new Promise((r) => setTimeout(r, 2_000));
        if (!done) await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      }
    })();
    try {
      // Both paths (RPC and Jito) only count as success once the signature is confirmed.
      const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) {
        return { sig: null, ok: false, dryRun: false, errorCode: customCode(conf.value.err), error: `${label} failed on-chain: ${JSON.stringify(conf.value.err)}` };
      }
    } finally {
      done = true;
      await rebroadcast;
    }
    return { sig, ok: true, dryRun: false };
  } catch (e) {
    return { sig: null, ok: false, dryRun: !opts.live, error: `${label}: ${(e as Error).message}` };
  }
}

/** Convenience: confirmed signature, or null (dry-run or failure; failures are logged). Never throws. */
export async function sendIxs(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  opts: SendOptions,
  log: Logger,
  label: string,
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<string | null> {
  const r = await sendIxsResult(conn, payer, ixs, opts, log, label, lookupTables);
  if (!r.ok && !r.dryRun) log.warn(r.error ?? `${label} failed`);
  return r.sig;
}

// ---- Jupiter (fallback swap path / pricing for min-out) ----

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

export async function jupiterQuote(apiUrl: string, outputMint: string, lamports: bigint, slippageBps: number): Promise<JupiterQuote> {
  const u = new URL(`${apiUrl.replace(/\/$/, "")}/quote`);
  u.searchParams.set("inputMint", WSOL_MINT);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", lamports.toString());
  u.searchParams.set("slippageBps", String(slippageBps));
  u.searchParams.set("restrictIntermediateTokens", "true");
  const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`jupiter quote HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as JupiterQuote;
}

interface JupIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

const toIx = (j: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(j.programId),
    keys: j.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(j.data, "base64"),
  });

/**
 * Jupiter swap as raw instructions (not a pre-built tx) so the keeper can wrap it
 * atomically between release_buyback and record_buyback_burn in ONE transaction.
 */
export async function jupiterSwapInstructions(
  conn: Connection,
  apiUrl: string,
  quote: JupiterQuote,
  user: PublicKey,
): Promise<{ ixs: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[] }> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`jupiter swap-instructions HTTP ${res.status}`);
  const body = (await res.json()) as {
    setupInstructions?: JupIx[];
    swapInstruction: JupIx;
    cleanupInstruction?: JupIx | null;
    addressLookupTableAddresses?: string[];
  };
  const ixs = [...(body.setupInstructions ?? []).map(toIx), toIx(body.swapInstruction), ...(body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : [])];
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const addr of body.addressLookupTableAddresses ?? []) {
    const t = (await conn.getAddressLookupTable(new PublicKey(addr))).value;
    if (t) lookupTables.push(t);
  }
  return { ixs, lookupTables };
}
