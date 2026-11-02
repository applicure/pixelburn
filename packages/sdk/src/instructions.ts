import { BN } from "@anchor-lang/core";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import type { PriceSource } from "./accounts.js";
import { coder, IDL } from "./coder.js";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { assertValidRect, type Rect } from "./geometry.js";
import { adPda, associatedTokenAddress, auctionAdPda, auctionPda, buybackVaultPda, canvasPda, configPda } from "./pda.js";
import { assertU64, hexToBytes } from "./util.js";

const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

type Accounts = Record<string, PublicKey | null | undefined>;

/**
 * Generic IDL-driven builder: account order, signer and writable flags come from the IDL, so they cannot
 * drift from the program. Optional accounts passed as null/undefined are encoded as the program id (Anchor's None).
 */
export function buildIx(
  name: string,
  args: Record<string, unknown>,
  accounts: Accounts,
  programId: PublicKey = PROGRAM_ID,
): TransactionInstruction {
  const def = IDL.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`unknown instruction ${name}`);
  const keys: AccountMeta[] = def.accounts.map((a) => {
    if ("accounts" in a) throw new Error("nested account groups unsupported");
    let key = accounts[a.name];
    if (!key && a.address) key = new PublicKey(a.address);
    if (!key) {
      if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false };
      throw new Error(`${name}: missing account ${a.name}`);
    }
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  return new TransactionInstruction({ programId, keys, data: coder.instruction.encode(name, args) });
}

const u64 = (v: bigint, what: string) => new BN(assertU64(v, what).toString());
const sha = (v: Uint8Array | string): number[] => {
  const b = typeof v === "string" ? hexToBytes(v) : v;
  if (b.length !== 32) throw new RangeError("image_sha256 must be 32 bytes");
  return Array.from(b);
};

function priceSourceArg(ps: PriceSource) {
  return ps.kind === "bondingCurve"
    ? { BondingCurve: { curve: ps.curve } }
    : { Pool: { pool: ps.pool, base_vault: ps.baseVault, quote_vault: ps.quoteVault } };
}

export function priceSourceAccounts(ps: PriceSource): Accounts {
  return ps.kind === "bondingCurve"
    ? { price_source: ps.curve, pool_base_vault: null, pool_quote_vault: null }
    : { price_source: ps.pool, pool_base_vault: ps.baseVault, pool_quote_vault: ps.quoteVault };
}

// ------------------------------------------------------------------ compute budget
export function computeBudgetIxs(opts: { units?: number; microLamports?: number } = {}): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (opts.units) {
    const d = new Uint8Array(5);
    d[0] = 2;
    new DataView(d.buffer).setUint32(1, opts.units, true);
    out.push(new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from(d) }));
  }
  if (opts.microLamports) {
    const d = new Uint8Array(9);
    d[0] = 3;
    new DataView(d.buffer).setBigUint64(1, BigInt(opts.microLamports), true);
    out.push(new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from(d) }));
  }
  return out;
}

// ------------------------------------------------------------------ buying
export interface AdContent {
  title: string;
  link: string;
  imageUri: string;
  /** 32 bytes or 64-char hex */
  imageSha256: Uint8Array | string;
}

export interface BuyIxBase {
  buyer: PublicKey;
  rect: Rect;
  content: AdContent;
  /** Pyth PriceUpdateV2 account (sponsored feed or freshly posted). */
  priceUpdate: PublicKey;
  programId?: PublicKey;
}

function buyArgs(p: BuyIxBase) {
  assertValidRect(p.rect);
  return {
    x: p.rect.x,
    y: p.rect.y,
    w: p.rect.w,
    h: p.rect.h,
    title: p.content.title,
    link: p.content.link,
    image_uri: p.content.imageUri,
    image_sha256: sha(p.content.imageSha256),
  };
}

export function buyWithSolIx(p: BuyIxBase & { treasury: PublicKey; maxLamports: bigint }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "buy_with_sol",
    { ...buyArgs(p), max_lamports: u64(p.maxLamports, "maxLamports") },
    {
      buyer: p.buyer,
      config: configPda(pid),
      canvas: canvasPda(pid),
      ad: adPda(p.rect.x, p.rect.y, pid),
      treasury: p.treasury,
      buyback_vault: buybackVaultPda(pid),
      price_update: p.priceUpdate,
      system_program: SYSTEM_PROGRAM_ID,
    },
    pid,
  );
}

export function buyWithTokenIx(
  p: BuyIxBase & {
    tokenMint: PublicKey;
    tokenProgram?: PublicKey;
    /** defaults to the buyer's ATA */
    buyerTokenAccount?: PublicKey;
    priceSource: PriceSource;
    maxTokens: bigint;
  },
): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  const tokenProgram = p.tokenProgram ?? TOKEN_PROGRAM_ID;
  return buildIx(
    "buy_with_token",
    { ...buyArgs(p), max_tokens: u64(p.maxTokens, "maxTokens") },
    {
      buyer: p.buyer,
      config: configPda(pid),
      canvas: canvasPda(pid),
      ad: adPda(p.rect.x, p.rect.y, pid),
      token_mint: p.tokenMint,
      buyer_token_account: p.buyerTokenAccount ?? associatedTokenAddress(p.buyer, p.tokenMint, tokenProgram),
      price_update: p.priceUpdate,
      ...priceSourceAccounts(p.priceSource),
      token_program: tokenProgram,
      system_program: SYSTEM_PROGRAM_ID,
    },
    pid,
  );
}

export function crankTokenPriceIx(p: { priceSource: PriceSource; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("crank_token_price", {}, { config: configPda(pid), ...priceSourceAccounts(p.priceSource) }, pid);
}

// ------------------------------------------------------------------ buyback (keeper)
export function releaseBuybackIx(p: { keeper: PublicKey; lamports: bigint; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "release_buyback",
    { lamports: u64(p.lamports, "lamports") },
    { keeper: p.keeper, config: configPda(pid), buyback_vault: buybackVaultPda(pid), system_program: SYSTEM_PROGRAM_ID },
    pid,
  );
}

export function recordBuybackBurnIx(p: {
  keeper: PublicKey;
  keeperTokenAccount?: PublicKey;
  tokenMint: PublicKey;
  tokenProgram?: PublicKey;
  /** config.priceSource: the program reads post-trade spot from it (backstop: spot <= fast EMA * 1.12) */
  priceSource: PriceSource;
  lamportsSpent: bigint;
  tokensBurned: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  const tp = p.tokenProgram ?? TOKEN_PROGRAM_ID;
  return buildIx(
    "record_buyback_burn",
    { lamports_spent: u64(p.lamportsSpent, "lamportsSpent"), tokens_burned: u64(p.tokensBurned, "tokensBurned") },
    {
      keeper: p.keeper,
      config: configPda(pid),
      canvas: canvasPda(pid),
      buyback_vault: buybackVaultPda(pid),
      token_mint: p.tokenMint,
      keeper_token_account: p.keeperTokenAccount ?? associatedTokenAddress(p.keeper, p.tokenMint, tp),
      ...priceSourceAccounts(p.priceSource),
      token_program: tp,
      system_program: SYSTEM_PROGRAM_ID,
    },
    pid,
  );
}

// ------------------------------------------------------------------ ads
/** `ad` = the ad account address (`adPda(x, y)`, `auctionAdPda()` or `adAddress(ad)`). */
export function updateAdIx(p: { owner: PublicKey; ad: PublicKey; content: AdContent; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "update_ad",
    { title: p.content.title, link: p.content.link, image_uri: p.content.imageUri, image_sha256: sha(p.content.imageSha256) },
    { owner: p.owner, ad: p.ad },
    pid,
  );
}

export function transferAdIx(p: { owner: PublicKey; ad: PublicKey; newOwner: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("transfer_ad", { new_owner: p.newOwner }, { owner: p.owner, ad: p.ad }, pid);
}

// ------------------------------------------------------------------ final auction
export function startFinalAuctionIx(p: { payer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "start_final_auction",
    {},
    { payer: p.payer, config: configPda(pid), canvas: canvasPda(pid), auction: auctionPda(pid), system_program: SYSTEM_PROGRAM_ID },
    pid,
  );
}

/** `previousBidder` = current auction.highestBidder (required unless there is no bid yet). */
export function bidFinalAuctionIx(p: {
  bidder: PublicKey;
  lamports: bigint;
  previousBidder: PublicKey | null;
  programId?: PublicKey;
}): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "bid_final_auction",
    { lamports: u64(p.lamports, "lamports") },
    {
      bidder: p.bidder,
      config: configPda(pid),
      auction: auctionPda(pid),
      previous_bidder: p.previousBidder,
      system_program: SYSTEM_PROGRAM_ID,
    },
    pid,
  );
}

export function restartFinalAuctionIx(p: { programId?: PublicKey } = {}): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("restart_final_auction", {}, { config: configPda(pid), auction: auctionPda(pid) }, pid);
}

export function settleFinalAuctionIx(p: { payer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "settle_final_auction",
    {},
    {
      payer: p.payer,
      config: configPda(pid),
      canvas: canvasPda(pid),
      auction: auctionPda(pid),
      ad: auctionAdPda(pid),
      buyback_vault: buybackVaultPda(pid),
      system_program: SYSTEM_PROGRAM_ID,
    },
    pid,
  );
}

// ------------------------------------------------------------------ admin
export interface InitializeArgs {
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

export function initializeIx(p: InitializeArgs): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  const programData = PublicKey.findProgramAddressSync([pid.toBytes()], BPF_UPGRADEABLE_LOADER)[0];
  return buildIx(
    "initialize",
    {
      params: {
        treasury: p.treasury,
        keeper: p.keeper,
        pyth_feed_id: Array.from(hexToBytes(p.pythFeedIdHex)),
        price_source: priceSourceArg(p.priceSource),
        max_price_age_secs: u64(p.maxPriceAgeSecs ?? 60n, "maxPriceAgeSecs"),
        buyback_cap_lamports_per_hour: u64(p.buybackCapLamportsPerHour, "buybackCap"),
        buyback_max_slippage_bps: p.buybackMaxSlippageBps,
        initial_token_ema_price_sol: new BN(p.initialTokenEmaPriceSol.toString()),
        token_blocks_cap_per_hour: p.tokenBlocksCapPerHour ?? 1_000,
      },
    },
    {
      admin: p.admin,
      config: configPda(pid),
      canvas: canvasPda(pid),
      buyback_vault: buybackVaultPda(pid),
      token_mint: p.tokenMint,
      token_program: p.tokenProgram ?? TOKEN_PROGRAM_ID,
      program: pid,
      program_data: programData,
      system_program: SYSTEM_PROGRAM_ID,
    },
    pid,
  );
}

function adminIx(name: string, args: Record<string, unknown>, admin: PublicKey, programId?: PublicKey) {
  const pid = programId ?? PROGRAM_ID;
  return buildIx(name, args, { admin, config: configPda(pid) }, pid);
}

/** Unpausing extends a running auction by the paused duration (the auction PDA is always passed). */
export function setPausedIx(p: { admin: PublicKey; paused: boolean; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("set_paused", { paused: p.paused }, { admin: p.admin, config: configPda(pid), auction: auctionPda(pid) }, pid);
}
export const setTreasuryIx = (p: { admin: PublicKey; treasury: PublicKey; programId?: PublicKey }) =>
  adminIx("set_treasury", { treasury: p.treasury }, p.admin, p.programId);
export const setKeeperIx = (p: { admin: PublicKey; keeper: PublicKey; programId?: PublicKey }) =>
  adminIx("set_keeper", { keeper: p.keeper }, p.admin, p.programId);
/** Switch price source and re-seed the EMA (checked against spot at the next crank; warm-up restarts). */
export const setPriceSourceIx = (p: { admin: PublicKey; priceSource: PriceSource; initialEmaPriceSol: bigint; programId?: PublicKey }) =>
  adminIx(
    "set_price_source",
    { price_source: priceSourceArg(p.priceSource), initial_ema_price_sol: new BN(p.initialEmaPriceSol.toString()) },
    p.admin,
    p.programId,
  );
export const setParamsIx = (p: {
  admin: PublicKey;
  maxPriceAgeSecs: bigint;
  buybackCapLamportsPerHour: bigint;
  buybackMaxSlippageBps: number;
  tokenBlocksCapPerHour: number;
  programId?: PublicKey;
}) =>
  adminIx(
    "set_params",
    {
      max_price_age_secs: u64(p.maxPriceAgeSecs, "maxPriceAgeSecs"),
      buyback_cap_lamports_per_hour: u64(p.buybackCapLamportsPerHour, "cap"),
      buyback_max_slippage_bps: p.buybackMaxSlippageBps,
      token_blocks_cap_per_hour: p.tokenBlocksCapPerHour,
    },
    p.admin,
    p.programId,
  );
export const proposeAdminIx = (p: { admin: PublicKey; newAdmin: PublicKey; programId?: PublicKey }) =>
  adminIx("propose_admin", { new_admin: p.newAdmin }, p.admin, p.programId);
export function acceptAdminIx(p: { newAdmin: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("accept_admin", {}, { new_admin: p.newAdmin, config: configPda(pid) }, pid);
}
