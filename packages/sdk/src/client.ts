/** Higher-level helpers that read chain state and assemble ready-to-sign instruction lists. */
import { PublicKey as PublicKeyCtor, Transaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { big, fetchAuction, fetchConfig, type ConfigAccount, type PriceSource } from "./accounts.js";
import { buyCuLimit, CU_LIMITS, estimatePriorityFee, priorityFeeLamports, type PriorityFeeOpts } from "./compute.js";
import { coder } from "./coder.js";
import {
  EMA_MIN_INTERVAL_SECS,
  MAX_EMA_AGE_SECS,
  PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  SOL_USD_FEED_ID,
  WSOL_MINT,
} from "./constants.js";
import type { Rect } from "./geometry.js";
import {
  bidFinalAuctionIx,
  buyWithSolIx,
  buyWithTokenIx,
  computeBudgetIxs,
  crankTokenPriceIx,
  settleFinalAuctionIx,
  type AdContent,
} from "./instructions.js";
import { adPda, canvasPda, pythPriceFeedAccount } from "./pda.js";
import {
  applyTokenDiscount,
  buyPriceQ,
  lamportsToTokens,
  minNextBid,
  quoteLamports,
  quoteUsd,
  spotPriceQ,
  tokenPricingStatus,
  withSlippage,
  type FixedPrice,
} from "./quote.js";
import { bytesToHex } from "./util.js";

export interface PythPrice extends FixedPrice {
  conf: bigint;
  publishTime: number;
  feedId: string;
  verified: boolean;
}

/** Decode a Pyth PriceUpdateV2 account (owner must be the Pyth receiver). */
export function decodePriceUpdateV2(data: Uint8Array, owner?: PublicKey): PythPrice {
  if (owner && !owner.equals(PYTH_RECEIVER_PROGRAM_ID)) throw new Error("price update not owned by the Pyth receiver");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = coder.types.decode("PriceUpdateV2", Buffer.from(data.subarray(8)));
  const m = r.price_message ?? r.priceMessage;
  const level = r.verification_level ?? r.verificationLevel;
  return {
    price: big(m.price),
    expo: Number(m.exponent),
    conf: big(m.conf),
    publishTime: Number(String(m.publish_time ?? m.publishTime)),
    feedId: bytesToHex(Uint8Array.from(m.feed_id ?? m.feedId)),
    verified: "Full" in level || "full" in level,
  };
}

export async function fetchSolUsd(connection: Connection, priceUpdate: PublicKey = pythPriceFeedAccount()): Promise<PythPrice> {
  const info = await connection.getAccountInfo(priceUpdate);
  if (!info) throw new Error(`price update account ${priceUpdate.toBase58()} not found`);
  const p = decodePriceUpdateV2(info.data, info.owner);
  if (p.feedId !== SOL_USD_FEED_ID) throw new Error("not the SOL/USD feed");
  return p;
}

const u64At = (d: Uint8Array, off: number): bigint => new DataView(d.buffer, d.byteOffset).getBigUint64(off, true);
const i128At = (d: Uint8Array, off: number): bigint => {
  const lo = u64At(d, off);
  const hi = new DataView(d.buffer, d.byteOffset).getBigInt64(off + 8, true);
  return (hi << 64n) + lo;
};

/** The coin trades against a token, not SOL: its reserves aren't lamports, so they must not be read as a SOL price. */
export class NonSolQuoteError extends Error {
  constructor(public readonly quoteMint: PublicKey) {
    super(`price source is quoted in ${quoteMint.toBase58()}, not SOL`);
    this.name = "NonSolQuoteError";
  }
}

/** The quote mint stored on a curve. A short legacy account and the zero key both mean SOL, returned as WSOL. */
export function curveQuoteMint(data: Uint8Array): PublicKey {
  if (data.length < 115 || data.subarray(83, 115).every((b) => b === 0)) return WSOL_MINT;
  return new PublicKeyCtor(data.subarray(83, 115));
}

/** Reserves as stored, in whatever the curve is quoted in. Only the SOL path may turn these into a price: see `parseBondingCurve`. */
export function parseBondingCurveRaw(data: Uint8Array): { quoteMint: PublicKey; quoteReserve: bigint; baseUnits: bigint; complete: boolean } {
  const disc = [23, 183, 248, 55, 96, 216, 172, 96];
  if (data.length < 49 || disc.some((b, i) => data[i] !== b)) throw new Error("not a pump.fun BondingCurve");
  return { quoteMint: curveQuoteMint(data), quoteReserve: u64At(data, 16), baseUnits: u64At(data, 8), complete: data[48] !== 0 };
}

/** pump.fun BondingCurve -> reserves (layout per pump IDL; see chain/NOTES.md). Throws on non-SOL curves (`NonSolQuoteError`). */
export function parseBondingCurve(data: Uint8Array): { quoteLamports: bigint; baseUnits: bigint; complete: boolean } {
  const c = parseBondingCurveRaw(data);
  if (!c.quoteMint.equals(WSOL_MINT)) throw new NonSolQuoteError(c.quoteMint);
  return { quoteLamports: c.quoteReserve, baseUnits: c.baseUnits, complete: c.complete };
}

/** PumpSwap Pool account fields the program uses. `virtualQuoteReserves` may be negative (missing => 0). */
export function parsePumpPool(data: Uint8Array): {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  virtualQuoteReserves: bigint;
} {
  const disc = [241, 154, 109, 4, 17, 177, 109, 188];
  if (data.length < 203 || disc.some((b, i) => data[i] !== b)) throw new Error("not a PumpSwap Pool");
  const pk = (o: number) => new PublicKeyCtor(data.subarray(o, o + 32));
  return {
    baseMint: pk(43),
    quoteMint: pk(75),
    baseVault: pk(139),
    quoteVault: pk(171),
    virtualQuoteReserves: data.length >= 261 ? i128At(data, 245) : 0n,
  };
}

/** Spot priceQ from raw PumpSwap pool + vault token-account data (effective quote = vault + virtual). */
export function poolSpotPriceQ(poolData: Uint8Array, baseVaultData: Uint8Array, quoteVaultData: Uint8Array): bigint {
  const pool = parsePumpPool(poolData);
  if (!pool.quoteMint.equals(WSOL_MINT)) throw new NonSolQuoteError(pool.quoteMint);
  return spotPriceQ(u64At(quoteVaultData, 64) + pool.virtualQuoteReserves, u64At(baseVaultData, 64));
}

/** Reads reserves exactly like the program and returns spot priceQ (lamports/base unit * 1e18). */
export async function readSpotPriceQ(connection: Connection, ps: PriceSource): Promise<bigint> {
  if (ps.kind === "bondingCurve") {
    const a = await connection.getAccountInfo(ps.curve);
    if (!a || !a.owner.equals(PUMP_PROGRAM_ID)) throw new Error("bonding curve missing or wrong owner");
    const c = parseBondingCurve(a.data);
    if (c.complete) throw new Error("bonding curve complete");
    return spotPriceQ(c.quoteLamports, c.baseUnits);
  }
  const [pool, base, quote] = await connection.getMultipleAccountsInfo([ps.pool, ps.baseVault, ps.quoteVault]);
  if (!pool || !base || !quote || !pool.owner.equals(PUMP_AMM_PROGRAM_ID)) throw new Error("pool accounts missing");
  return poolSpotPriceQ(pool.data, base.data, quote.data);
}

/**
 * What the price source is quoted in; null when the account can't be read. Curves are the only source that can be non-SOL today:
 * the deployed program's set_price_source only accepts the canonical WSOL pool.
 */
export async function priceSourceQuoteMint(connection: Connection, ps: PriceSource): Promise<PublicKey | null> {
  const a = await connection.getAccountInfo(ps.kind === "bondingCurve" ? ps.curve : ps.pool);
  if (!a) return null;
  return ps.kind === "bondingCurve" ? parseBondingCurveRaw(a.data).quoteMint : parsePumpPool(a.data).quoteMint;
}

/**
 * The one flag behind "buybacks and token payments come later".
 *  - "later": the deployed program can't price this coin, so the buyback half of each SOL payment only accumulates in the vault, and token
 *    payments are off. True for a coin quoted in anything but SOL, and on mainnet before a coin exists (the launch is PUMP-paired).
 *  - "live": the program prices the coin, whatever warm-up or pause it is in at the moment.
 */
export type BuybackPhase = "live" | "later";
export function buybackPhase(p: { cluster: string; hasConfig: boolean; quoteMint: PublicKey | null }): BuybackPhase {
  if (!p.hasConfig) return p.cluster === "mainnet-beta" ? "later" : "live";
  // An unreadable source says nothing about the coin; "later" is the claim that can't be false.
  if (!p.quoteMint) return p.cluster === "mainnet-beta" ? "later" : "live";
  return p.quoteMint.equals(WSOL_MINT) ? "live" : "later";
}

export interface BuildOpts {
  /** default 100 bps (1%) for SOL, 300 bps for token */
  slippageBps?: number;
  /** default: Pyth sponsored SOL/USD feed account */
  priceUpdate?: PublicKey;
  /** override the CU limit (default: `buyCuLimit`, sized from measured CU) */
  computeUnits?: number;
  /** priority fee in micro-lamports/CU; omitted => no price ix (use `buildBuyTx` for an estimated one) */
  priorityMicroLamports?: number;
  programId?: PublicKey;
}

export interface SolQuote {
  /** Ad account that will be created (["ad", y*100+x]). */
  ad: PublicKey;
  usdMicro: bigint;
  lamports: bigint;
  maxLamports: bigint;
  solUsd: PythPrice;
  computeUnits: number;
}

/** Fetches config/price, quotes, and returns [computeBudget..., buy_with_sol]. Independent of other buyers. */
export async function buildBuyWithSolIxs(
  connection: Connection,
  p: { buyer: PublicKey; rect: Rect; content: AdContent } & BuildOpts,
): Promise<{ instructions: TransactionInstruction[]; quote: SolQuote }> {
  const pid = p.programId ?? PROGRAM_ID;
  const priceUpdate = p.priceUpdate ?? pythPriceFeedAccount();
  const [config, solUsd] = await Promise.all([fetchConfig(connection, pid), fetchSolUsd(connection, priceUpdate)]);
  const usdMicro = quoteUsd(p.rect.w, p.rect.h);
  const lamports = quoteLamports(usdMicro, solUsd);
  const maxLamports = withSlippage(lamports, p.slippageBps ?? 100);
  const ix = buyWithSolIx({
    buyer: p.buyer,
    rect: p.rect,
    content: p.content,
    priceUpdate,
    treasury: config.treasury,
    maxLamports,
    programId: pid,
  });
  const computeUnits = p.computeUnits ?? buyCuLimit(p.rect, "sol");
  return {
    instructions: [...computeBudgetIxs({ units: computeUnits, microLamports: p.priorityMicroLamports }), ix],
    quote: { ad: adPda(p.rect.x, p.rect.y, pid), usdMicro, lamports, maxLamports, solUsd, computeUnits },
  };
}

export interface TokenQuote {
  ad: PublicKey;
  /** discounted USD */
  usdMicro: bigint;
  tokens: bigint;
  maxTokens: bigint;
  spotQ: bigint;
  emaQ: bigint;
  slowEmaQ: bigint;
  solUsd: PythPrice;
  crankPrepended: boolean;
  computeUnits: number;
}

/**
 * The EMA the program will price against. When the stored EMA is near expiry (age > MAX_EMA_AGE - 120s) we prepend
 * a crank; the buy in that same slot still uses the pre-crank EMA (same-slot rule), so the price is unchanged.
 */
export function plannedEma(config: ConfigAccount, nowSecs: number): { emaQ: bigint; crank: boolean } {
  const age = nowSecs - config.emaUpdatedAt;
  const crank = config.tokenEmaPriceSol !== 0n && age > MAX_EMA_AGE_SECS - 120 && age >= EMA_MIN_INTERVAL_SECS;
  return { emaQ: config.tokenEmaPriceSol, crank };
}

/** Thrown by `buildBuyWithTokenIxs` when the program would reject token pricing right now. */
export class TokenPricingUnavailableError extends Error {
  constructor(
    public readonly reason: "notSeeded" | "warmingUp" | "stale" | "deviation" | "capExhausted" | "sourceUnavailable" | "upgradePending",
    detail: string,
  ) {
    super(`token payments unavailable (${reason}): ${detail}`);
    this.name = "TokenPricingUnavailableError";
  }
}

export async function buildBuyWithTokenIxs(
  connection: Connection,
  p: { buyer: PublicKey; rect: Rect; content: AdContent; buyerTokenAccount?: PublicKey } & BuildOpts,
): Promise<{ instructions: TransactionInstruction[]; quote: TokenQuote }> {
  const pid = p.programId ?? PROGRAM_ID;
  const priceUpdate = p.priceUpdate ?? pythPriceFeedAccount();
  const [config, solUsd] = await Promise.all([fetchConfig(connection, pid), fetchSolUsd(connection, priceUpdate)]);
  // Curve complete (graduating to PumpSwap) or pool not readable: the program rejects token buys (CurveComplete /
  // InvalidPriceSource) until the admin switches the source; surface that as a typed reason, never a misprice.
  let spotQ: bigint;
  try {
    spotQ = await readSpotPriceQ(connection, config.priceSource);
  } catch (e) {
    if (e instanceof NonSolQuoteError) throw new TokenPricingUnavailableError("upgradePending", "token payments start after a program upgrade");
    throw new TokenPricingUnavailableError("sourceUnavailable", `token price source unavailable (${(e as Error).message}); likely migrating to PumpSwap`);
  }
  const now = Math.floor(Date.now() / 1000);
  const status = tokenPricingStatus(config, spotQ, now, p.rect.w * p.rect.h);
  // "stale" is fixed by the crank we prepend below; everything else would fail on-chain
  if (!status.ok && status.reason !== "stale") throw new TokenPricingUnavailableError(status.reason, status.detail);
  const { emaQ, crank } = plannedEma(config, now);
  const usdMicro = quoteUsd(p.rect.w, p.rect.h);
  const slowEmaQ = config.tokenSlowEmaPriceSol;
  const tokens = lamportsToTokens(quoteLamports(applyTokenDiscount(usdMicro), solUsd), buyPriceQ(spotQ, emaQ, slowEmaQ));
  const maxTokens = withSlippage(tokens, p.slippageBps ?? 300);
  const computeUnits = p.computeUnits ?? buyCuLimit(p.rect, "token") + (crank ? CU_LIMITS.crankTokenPrice : 0);
  const ixs = computeBudgetIxs({ units: computeUnits, microLamports: p.priorityMicroLamports });
  if (crank) ixs.push(crankTokenPriceIx({ priceSource: config.priceSource, programId: pid }));
  ixs.push(
    buyWithTokenIx({
      buyer: p.buyer,
      rect: p.rect,
      content: p.content,
      priceUpdate,
      tokenMint: config.tokenMint,
      tokenProgram: config.tokenProgram,
      buyerTokenAccount: p.buyerTokenAccount,
      priceSource: config.priceSource,
      maxTokens,
      programId: pid,
    }),
  );
  return {
    instructions: ixs,
    quote: {
      ad: adPda(p.rect.x, p.rect.y, pid),
      usdMicro: applyTokenDiscount(usdMicro),
      tokens,
      maxTokens,
      spotQ,
      emaQ,
      slowEmaQ,
      solUsd,
      crankPrepended: crank,
      computeUnits,
    },
  };
}

/**
 * One-call purchase transaction: quote + buy ix + CU limit sized from measured CU + a priority fee estimated from
 * `getRecentPrioritizationFees` on the canvas account (the write-lock every buy shares), capped.
 * Returns an unsigned legacy Transaction with blockhash + fee payer set; the wallet signs and sends it.
 */
export async function buildBuyTx(
  connection: Connection,
  p: {
    mode: "sol" | "token";
    buyer: PublicKey;
    rect: Rect;
    content: AdContent;
    buyerTokenAccount?: PublicKey;
    slippageBps?: number;
    priceUpdate?: PublicKey;
    programId?: PublicKey;
  } & PriorityFeeOpts,
): Promise<{
  transaction: Transaction;
  quote: SolQuote | TokenQuote;
  computeUnitLimit: number;
  microLamportsPerCu: number;
  maxPriorityFeeLamports: bigint;
  lastValidBlockHeight: number;
}> {
  const pid = p.programId ?? PROGRAM_ID;
  const [microLamports, bh] = await Promise.all([
    estimatePriorityFee(connection, [canvasPda(pid)], p),
    connection.getLatestBlockhash("confirmed"),
  ]);
  const built =
    p.mode === "sol"
      ? await buildBuyWithSolIxs(connection, { ...p, priorityMicroLamports: microLamports })
      : await buildBuyWithTokenIxs(connection, { ...p, priorityMicroLamports: microLamports });
  const transaction = new Transaction({ feePayer: p.buyer, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
  transaction.add(...built.instructions);
  return {
    transaction,
    quote: built.quote,
    computeUnitLimit: built.quote.computeUnits,
    microLamportsPerCu: microLamports,
    maxPriorityFeeLamports: priorityFeeLamports(built.quote.computeUnits, microLamports),
    lastValidBlockHeight: bh.lastValidBlockHeight,
  };
}

/** Builds a bid with the correct previous-bidder refund account. `lamports` defaults to the minimum next bid. */
export async function buildBidIxs(
  connection: Connection,
  p: { bidder: PublicKey; lamports?: bigint; priorityMicroLamports?: number; programId?: PublicKey },
): Promise<{ instructions: TransactionInstruction[]; lamports: bigint }> {
  const auction = await fetchAuction(connection, p.programId);
  if (!auction) throw new Error("auction not started");
  const min = minNextBid(auction.highestBid);
  const lamports = p.lamports ?? min;
  if (lamports < min) throw new Error(`bid below minimum ${min}`);
  return {
    lamports,
    instructions: [
      ...computeBudgetIxs({ units: CU_LIMITS.bidFinalAuction, microLamports: p.priorityMicroLamports }),
      bidFinalAuctionIx({
        bidder: p.bidder,
        lamports,
        previousBidder: auction.highestBid > 0n ? auction.highestBidder : null,
        programId: p.programId,
      }),
    ],
  };
}

export function buildSettleIxs(p: { payer: PublicKey; priorityMicroLamports?: number; programId?: PublicKey }): TransactionInstruction[] {
  return [
    ...computeBudgetIxs({ units: CU_LIMITS.settleFinalAuction, microLamports: p.priorityMicroLamports }),
    settleFinalAuctionIx({ payer: p.payer, programId: p.programId }),
  ];
}
