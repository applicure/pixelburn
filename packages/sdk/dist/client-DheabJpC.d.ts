import { PublicKey, Connection, TransactionInstruction, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { R as Rect, F as FixedPrice } from './quote-Dr1cW5Ot.js';

type PriceSource = {
    kind: "bondingCurve";
    curve: PublicKey;
} | {
    kind: "pool";
    pool: PublicKey;
    baseVault: PublicKey;
    quoteVault: PublicKey;
};
type PayMode = "sol" | "token" | "auction";
type AdKind = "rect" | "auctionLot";
type AuctionStatus = "active" | "settled";
interface ConfigAccount {
    admin: PublicKey;
    pendingAdmin: PublicKey;
    treasury: PublicKey;
    keeper: PublicKey;
    tokenMint: PublicKey;
    tokenProgram: PublicKey;
    tokenDecimals: number;
    pythFeedId: string;
    priceSource: PriceSource;
    /** lamports per token base unit * 1e18 */
    tokenEmaPriceSol: bigint;
    tokenEmaPrevPriceSol: bigint;
    /** slow (4 h) EMA, same unit */
    tokenSlowEmaPriceSol: bigint;
    tokenSlowEmaPrevPriceSol: bigint;
    tokenSpotPriceSol: bigint;
    emaUpdatedAt: number;
    emaUpdatedSlot: bigint;
    maxPriceAgeSecs: number;
    paused: boolean;
    buybackCapLamportsPerHour: bigint;
    buybackMaxSlippageBps: number;
    /** token bucket: refills at cap/hour, max = cap */
    buybackAllowanceUpdatedAt: number;
    buybackAllowance: bigint;
    buybackOutstandingLamports: bigint;
    buybackWrittenOffLamports: bigint;
    emaWarmupCranks: number;
    emaWarmupStartedAt: number;
    /** unix ts when paused (0 if not paused) */
    pausedAt: number;
    /** token-paid blocks bucket */
    tokenBlocksCapPerHour: number;
    tokenBlocksAllowance: number;
    tokenBlocksAllowanceUpdatedAt: number;
}
interface CanvasAccount {
    bitmap: Uint8Array;
    soldBlocks: number;
    nextAdId: number;
    usdMicroRaised: bigint;
    lamportsRaised: bigint;
    lamportsToTreasury: bigint;
    lamportsToBuyback: bigint;
    tokensBurnedDirect: bigint;
    tokensBurnedBuyback: bigint;
    lamportsSpentBuyback: bigint;
}
interface AdAccount {
    /** Display counter (assignment order); NOT the PDA seed. Use `adAddress(ad)` for the account address. */
    id: number;
    owner: PublicKey;
    kind: AdKind;
    x: number;
    y: number;
    w: number;
    h: number;
    title: string;
    link: string;
    imageUri: string;
    /** hex */
    imageSha256: string;
    payMode: PayMode;
    paidLamports: bigint;
    paidTokens: bigint;
    usdMicro: bigint;
    createdAt: number;
    updatedAt: number;
}
interface AuctionAccount {
    status: AuctionStatus;
    startTs: number;
    endTs: number;
    highestBidder: PublicKey;
    highestBid: bigint;
    bidCount: number;
    lotBlocks: number;
    lotBitmap: Uint8Array;
    adId: number;
}
type Raw = Record<string, any>;
declare const big: (v: BN | number | bigint) => bigint;
/** Anchor enums decode as { VariantName: {...} } (casing depends on coder) — normalise to lowerCamel. */
declare function enumKind(v: Raw): {
    kind: string;
    fields: Raw;
};
declare function decodeConfig(data: Uint8Array): ConfigAccount;
declare function decodeCanvas(data: Uint8Array): CanvasAccount;
declare function decodeAd(data: Uint8Array): AdAccount;
declare function decodeAuction(data: Uint8Array): AuctionAccount;
/** 8-byte account discriminator from the IDL. */
declare function accountDiscriminator(name: "Config" | "Canvas" | "Ad" | "Auction"): Uint8Array;
declare function fetchConfig(connection: Connection, programId?: PublicKey): Promise<ConfigAccount>;
declare function fetchCanvas(connection: Connection, programId?: PublicKey): Promise<CanvasAccount>;
/** Address of an ad: rect ads from their top-left block, the auction lot from ["ad_auction"]. */
declare function adAddress(ad: Pick<AdAccount, "kind" | "x" | "y">, programId?: PublicKey): PublicKey;
declare function fetchAd(connection: Connection, address: PublicKey): Promise<AdAccount | null>;
/** The rect ad whose top-left block is (x, y), if any. */
declare function fetchAdAt(connection: Connection, x: number, y: number, programId?: PublicKey): Promise<AdAccount | null>;
declare function fetchAuction(connection: Connection, programId?: PublicKey): Promise<AuctionAccount | null>;
/** All Ad accounts via getProgramAccounts (discriminator filter), sorted by display id. */
declare function fetchAllAds(connection: Connection, programId?: PublicKey): Promise<(AdAccount & {
    address: PublicKey;
})[]>;

type Accounts = Record<string, PublicKey | null | undefined>;
/**
 * Generic IDL-driven builder: account order, signer and writable flags come from the IDL, so they cannot
 * drift from the program. Optional accounts passed as null/undefined are encoded as the program id (Anchor's None).
 */
declare function buildIx(name: string, args: Record<string, unknown>, accounts: Accounts, programId?: PublicKey): TransactionInstruction;
declare function priceSourceAccounts(ps: PriceSource): Accounts;
declare function computeBudgetIxs(opts?: {
    units?: number;
    microLamports?: number;
}): TransactionInstruction[];
interface AdContent {
    title: string;
    link: string;
    imageUri: string;
    /** 32 bytes or 64-char hex */
    imageSha256: Uint8Array | string;
}
interface BuyIxBase {
    buyer: PublicKey;
    rect: Rect;
    content: AdContent;
    /** Pyth PriceUpdateV2 account (sponsored feed or freshly posted). */
    priceUpdate: PublicKey;
    programId?: PublicKey;
}
declare function buyWithSolIx(p: BuyIxBase & {
    treasury: PublicKey;
    maxLamports: bigint;
}): TransactionInstruction;
declare function buyWithTokenIx(p: BuyIxBase & {
    tokenMint: PublicKey;
    tokenProgram?: PublicKey;
    /** defaults to the buyer's ATA */
    buyerTokenAccount?: PublicKey;
    priceSource: PriceSource;
    maxTokens: bigint;
}): TransactionInstruction;
declare function crankTokenPriceIx(p: {
    priceSource: PriceSource;
    programId?: PublicKey;
}): TransactionInstruction;
declare function releaseBuybackIx(p: {
    keeper: PublicKey;
    lamports: bigint;
    programId?: PublicKey;
}): TransactionInstruction;
declare function recordBuybackBurnIx(p: {
    keeper: PublicKey;
    keeperTokenAccount?: PublicKey;
    tokenMint: PublicKey;
    tokenProgram?: PublicKey;
    lamportsSpent: bigint;
    tokensBurned: bigint;
    programId?: PublicKey;
}): TransactionInstruction;
/** `ad` = the ad account address (`adPda(x, y)`, `auctionAdPda()` or `adAddress(ad)`). */
declare function updateAdIx(p: {
    owner: PublicKey;
    ad: PublicKey;
    content: AdContent;
    programId?: PublicKey;
}): TransactionInstruction;
declare function transferAdIx(p: {
    owner: PublicKey;
    ad: PublicKey;
    newOwner: PublicKey;
    programId?: PublicKey;
}): TransactionInstruction;
declare function startFinalAuctionIx(p: {
    payer: PublicKey;
    programId?: PublicKey;
}): TransactionInstruction;
/** `previousBidder` = current auction.highestBidder (required unless there is no bid yet). */
declare function bidFinalAuctionIx(p: {
    bidder: PublicKey;
    lamports: bigint;
    previousBidder: PublicKey | null;
    programId?: PublicKey;
}): TransactionInstruction;
declare function restartFinalAuctionIx(p?: {
    programId?: PublicKey;
}): TransactionInstruction;
declare function settleFinalAuctionIx(p: {
    payer: PublicKey;
    programId?: PublicKey;
}): TransactionInstruction;
interface InitializeArgs {
    admin: PublicKey;
    tokenMint: PublicKey;
    tokenProgram?: PublicKey;
    treasury: PublicKey;
    keeper: PublicKey;
    pythFeedIdHex: string;
    priceSource: PriceSource;
    maxPriceAgeSecs?: bigint;
    buybackCapLamportsPerHour: bigint;
    buybackMaxSlippageBps: number;
    /** Admin-supplied EMA seed (lamports/base unit * 1e18), e.g. `spotPriceQ` of the live curve. 0 = token pricing off. */
    initialTokenEmaPriceSol: bigint;
    /** token-paid blocks per hour, default 1000, max 5000 */
    tokenBlocksCapPerHour?: number;
    programId?: PublicKey;
}
declare function initializeIx(p: InitializeArgs): TransactionInstruction;
/** Unpausing extends a running auction by the paused duration (the auction PDA is always passed). */
declare function setPausedIx(p: {
    admin: PublicKey;
    paused: boolean;
    programId?: PublicKey;
}): TransactionInstruction;
declare const setTreasuryIx: (p: {
    admin: PublicKey;
    treasury: PublicKey;
    programId?: PublicKey;
}) => TransactionInstruction;
declare const setKeeperIx: (p: {
    admin: PublicKey;
    keeper: PublicKey;
    programId?: PublicKey;
}) => TransactionInstruction;
/** Switch price source and re-seed the EMA (checked against spot at the next crank; warm-up restarts). */
declare const setPriceSourceIx: (p: {
    admin: PublicKey;
    priceSource: PriceSource;
    initialEmaPriceSol: bigint;
    programId?: PublicKey;
}) => TransactionInstruction;
declare const setParamsIx: (p: {
    admin: PublicKey;
    maxPriceAgeSecs: bigint;
    buybackCapLamportsPerHour: bigint;
    buybackMaxSlippageBps: number;
    tokenBlocksCapPerHour: number;
    programId?: PublicKey;
}) => TransactionInstruction;
declare const proposeAdminIx: (p: {
    admin: PublicKey;
    newAdmin: PublicKey;
    programId?: PublicKey;
}) => TransactionInstruction;
declare function acceptAdminIx(p: {
    newAdmin: PublicKey;
    programId?: PublicKey;
}): TransactionInstruction;

/**
 * Compute-unit limits (measured in chain/programs/pixel/tests/all/cu.rs, which asserts the program stays under
 * these numbers) and priority-fee estimation.
 */

/** Static per-instruction CU limits (measured max + headroom). See chain/NOTES.md "Compute units". */
declare const CU_LIMITS: {
    readonly initialize: 60000;
    readonly crankTokenPrice: 20000;
    readonly updateAd: 15000;
    readonly transferAd: 15000;
    readonly releaseBuyback: 20000;
    readonly recordBuybackBurn: 40000;
    readonly startFinalAuction: 80000;
    readonly bidFinalAuction: 20000;
    readonly restartFinalAuction: 15000;
    readonly settleFinalAuction: 70000;
};
/** Buy CU scales with the rect's row count (bitmap check/mark is per row). Measured: 1x1 ≈ 24k (SOL) / 31k (token), 100x99 ≈ 117k. */
declare function buyCuLimit(rect: Pick<Rect, "h">, mode: "sol" | "token"): number;
interface PriorityFeeOpts {
    /** Percentile of recent non-zero fees to use (default 75). */
    percentile?: number;
    /** Floor in micro-lamports per CU (default 1_000). */
    minMicroLamports?: number;
    /** Hard cap in micro-lamports per CU (default 200_000 = 0.2 lamports/CU). */
    maxMicroLamports?: number;
}
/**
 * Priority fee (micro-lamports per CU) from `getRecentPrioritizationFees` for the hot writable accounts,
 * percentile of the last ~150 slots, clamped to [min, max]. Falls back to `min` if the RPC call fails.
 */
declare function estimatePriorityFee(connection: Pick<Connection, "getRecentPrioritizationFees">, writableAccounts: PublicKey[], opts?: PriorityFeeOpts): Promise<number>;
/** Total priority fee in lamports for a CU limit and price. */
declare function priorityFeeLamports(cuLimit: number, microLamportsPerCu: number): bigint;

/** Higher-level helpers that read chain state and assemble ready-to-sign instruction lists. */

interface PythPrice extends FixedPrice {
    conf: bigint;
    publishTime: number;
    feedId: string;
    verified: boolean;
}
/** Decode a Pyth PriceUpdateV2 account (owner must be the Pyth receiver). */
declare function decodePriceUpdateV2(data: Uint8Array, owner?: PublicKey): PythPrice;
declare function fetchSolUsd(connection: Connection, priceUpdate?: PublicKey): Promise<PythPrice>;
/** pump.fun BondingCurve -> reserves (layout per pump IDL; see chain/NOTES.md). Throws on complete / non-SOL curves. */
declare function parseBondingCurve(data: Uint8Array): {
    quoteLamports: bigint;
    baseUnits: bigint;
    complete: boolean;
};
/** PumpSwap Pool account fields the program uses. `virtualQuoteReserves` may be negative (missing => 0). */
declare function parsePumpPool(data: Uint8Array): {
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseVault: PublicKey;
    quoteVault: PublicKey;
    virtualQuoteReserves: bigint;
};
/** Spot priceQ from raw PumpSwap pool + vault token-account data (effective quote = vault + virtual). */
declare function poolSpotPriceQ(poolData: Uint8Array, baseVaultData: Uint8Array, quoteVaultData: Uint8Array): bigint;
/** Reads reserves exactly like the program and returns spot priceQ (lamports/base unit * 1e18). */
declare function readSpotPriceQ(connection: Connection, ps: PriceSource): Promise<bigint>;
interface BuildOpts {
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
interface SolQuote {
    /** Ad account that will be created (["ad", y*100+x]). */
    ad: PublicKey;
    usdMicro: bigint;
    lamports: bigint;
    maxLamports: bigint;
    solUsd: PythPrice;
    computeUnits: number;
}
/** Fetches config/price, quotes, and returns [computeBudget..., buy_with_sol]. Independent of other buyers. */
declare function buildBuyWithSolIxs(connection: Connection, p: {
    buyer: PublicKey;
    rect: Rect;
    content: AdContent;
} & BuildOpts): Promise<{
    instructions: TransactionInstruction[];
    quote: SolQuote;
}>;
interface TokenQuote {
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
declare function plannedEma(config: ConfigAccount, nowSecs: number): {
    emaQ: bigint;
    crank: boolean;
};
/** Thrown by `buildBuyWithTokenIxs` when the program would reject token pricing right now. */
declare class TokenPricingUnavailableError extends Error {
    readonly reason: "notSeeded" | "warmingUp" | "stale" | "deviation" | "capExhausted" | "sourceUnavailable";
    constructor(reason: "notSeeded" | "warmingUp" | "stale" | "deviation" | "capExhausted" | "sourceUnavailable", detail: string);
}
declare function buildBuyWithTokenIxs(connection: Connection, p: {
    buyer: PublicKey;
    rect: Rect;
    content: AdContent;
    buyerTokenAccount?: PublicKey;
} & BuildOpts): Promise<{
    instructions: TransactionInstruction[];
    quote: TokenQuote;
}>;
/**
 * One-call purchase transaction: quote + buy ix + CU limit sized from measured CU + a priority fee estimated from
 * `getRecentPrioritizationFees` on the canvas account (the write-lock every buy shares), capped.
 * Returns an unsigned legacy Transaction with blockhash + fee payer set; the wallet signs and sends it.
 */
declare function buildBuyTx(connection: Connection, p: {
    mode: "sol" | "token";
    buyer: PublicKey;
    rect: Rect;
    content: AdContent;
    buyerTokenAccount?: PublicKey;
    slippageBps?: number;
    priceUpdate?: PublicKey;
    programId?: PublicKey;
} & PriorityFeeOpts): Promise<{
    transaction: Transaction;
    quote: SolQuote | TokenQuote;
    computeUnitLimit: number;
    microLamportsPerCu: number;
    maxPriorityFeeLamports: bigint;
    lastValidBlockHeight: number;
}>;
/** Builds a bid with the correct previous-bidder refund account. `lamports` defaults to the minimum next bid. */
declare function buildBidIxs(connection: Connection, p: {
    bidder: PublicKey;
    lamports?: bigint;
    priorityMicroLamports?: number;
    programId?: PublicKey;
}): Promise<{
    instructions: TransactionInstruction[];
    lamports: bigint;
}>;
declare function buildSettleIxs(p: {
    payer: PublicKey;
    priorityMicroLamports?: number;
    programId?: PublicKey;
}): TransactionInstruction[];

export { priceSourceAccounts as $, type AdAccount as A, type BuildOpts as B, CU_LIMITS as C, crankTokenPriceIx as D, decodeAd as E, decodeAuction as F, decodeCanvas as G, decodeConfig as H, type InitializeArgs as I, decodePriceUpdateV2 as J, enumKind as K, estimatePriorityFee as L, fetchAd as M, fetchAdAt as N, fetchAllAds as O, type PythPrice as P, fetchAuction as Q, fetchCanvas as R, type SolQuote as S, TokenPricingUnavailableError as T, fetchConfig as U, fetchSolUsd as V, initializeIx as W, parseBondingCurve as X, parsePumpPool as Y, plannedEma as Z, poolSpotPriceQ as _, type PayMode as a, priorityFeeLamports as a0, proposeAdminIx as a1, readSpotPriceQ as a2, recordBuybackBurnIx as a3, releaseBuybackIx as a4, restartFinalAuctionIx as a5, setKeeperIx as a6, setParamsIx as a7, setPausedIx as a8, setPriceSourceIx as a9, setTreasuryIx as aa, settleFinalAuctionIx as ab, startFinalAuctionIx as ac, transferAdIx as ad, updateAdIx as ae, type AdContent as b, type AdKind as c, type AuctionAccount as d, type AuctionStatus as e, type BuyIxBase as f, type CanvasAccount as g, type ConfigAccount as h, type PriceSource as i, type PriorityFeeOpts as j, type TokenQuote as k, acceptAdminIx as l, accountDiscriminator as m, adAddress as n, bidFinalAuctionIx as o, big as p, buildBidIxs as q, buildBuyTx as r, buildBuyWithSolIxs as s, buildBuyWithTokenIxs as t, buildIx as u, buildSettleIxs as v, buyCuLimit as w, buyWithSolIx as x, buyWithTokenIx as y, computeBudgetIxs as z };
