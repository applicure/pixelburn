import type { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@anchor-lang/core";
import type BN from "bn.js";
import { coder, IDL } from "./coder.js";
import { PROGRAM_ID } from "./constants.js";
import { adPda, auctionAdPda, auctionPda, canvasPda, configPda } from "./pda.js";
import { bytesToHex } from "./util.js";

export type PriceSource =
  | { kind: "bondingCurve"; curve: PublicKey }
  | { kind: "pool"; pool: PublicKey; baseVault: PublicKey; quoteVault: PublicKey };

export type PayMode = "sol" | "token" | "auction";
export type AdKind = "rect" | "auctionLot";
export type AuctionStatus = "active" | "settled";

export interface ConfigAccount {
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

export interface CanvasAccount {
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

export interface AdAccount {
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

export interface AuctionAccount {
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

// ------------------------------------------------------------------ helpers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export const big = (v: BN | number | bigint): bigint => (typeof v === "bigint" ? v : BigInt(v.toString()));
const num = (v: BN | number): number => (typeof v === "number" ? v : Number(v.toString()));
const bytes = (v: number[] | Uint8Array): Uint8Array => Uint8Array.from(v);

/** Anchor enums decode as { VariantName: {...} } (casing depends on coder) — normalise to lowerCamel. */
export function enumKind(v: Raw): { kind: string; fields: Raw } {
  const k = Object.keys(v)[0];
  if (!k) throw new Error("empty enum");
  return { kind: k.charAt(0).toLowerCase() + k.slice(1), fields: v[k] ?? {} };
}

function pick(raw: Raw, snake: string): any {
  if (snake in raw) return raw[snake];
  const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return raw[camel];
}

// ------------------------------------------------------------------ decoders
export function decodeConfig(data: Uint8Array): ConfigAccount {
  const r: Raw = coder.accounts.decode("Config", Buffer.from(data));
  const ps = enumKind(pick(r, "price_source"));
  const priceSource: PriceSource =
    ps.kind === "bondingCurve"
      ? { kind: "bondingCurve", curve: ps.fields.curve }
      : {
          kind: "pool",
          pool: ps.fields.pool,
          baseVault: pick(ps.fields, "base_vault"),
          quoteVault: pick(ps.fields, "quote_vault"),
        };
  return {
    admin: r.admin,
    pendingAdmin: pick(r, "pending_admin"),
    treasury: r.treasury,
    keeper: r.keeper,
    tokenMint: pick(r, "token_mint"),
    tokenProgram: pick(r, "token_program"),
    tokenDecimals: pick(r, "token_decimals"),
    pythFeedId: bytesToHex(bytes(pick(r, "pyth_feed_id"))),
    priceSource,
    tokenEmaPriceSol: big(pick(r, "token_ema_price_sol")),
    tokenEmaPrevPriceSol: big(pick(r, "token_ema_prev_price_sol")),
    tokenSlowEmaPriceSol: big(pick(r, "token_slow_ema_price_sol")),
    tokenSlowEmaPrevPriceSol: big(pick(r, "token_slow_ema_prev_price_sol")),
    tokenSpotPriceSol: big(pick(r, "token_spot_price_sol")),
    emaUpdatedAt: num(pick(r, "ema_updated_at")),
    emaUpdatedSlot: big(pick(r, "ema_updated_slot")),
    maxPriceAgeSecs: num(pick(r, "max_price_age_secs")),
    paused: r.paused,
    buybackCapLamportsPerHour: big(pick(r, "buyback_cap_lamports_per_hour")),
    buybackMaxSlippageBps: pick(r, "buyback_max_slippage_bps"),
    buybackAllowanceUpdatedAt: num(pick(r, "buyback_allowance_updated_at")),
    buybackAllowance: big(pick(r, "buyback_allowance")),
    buybackOutstandingLamports: big(pick(r, "buyback_outstanding_lamports")),
    buybackWrittenOffLamports: big(pick(r, "buyback_written_off_lamports")),
    emaWarmupCranks: pick(r, "ema_warmup_cranks"),
    emaWarmupStartedAt: num(pick(r, "ema_warmup_started_at")),
    pausedAt: num(pick(r, "paused_at")),
    tokenBlocksCapPerHour: pick(r, "token_blocks_cap_per_hour"),
    tokenBlocksAllowance: pick(r, "token_blocks_allowance"),
    tokenBlocksAllowanceUpdatedAt: num(pick(r, "token_blocks_allowance_updated_at")),
  };
}

export function decodeCanvas(data: Uint8Array): CanvasAccount {
  const r: Raw = coder.accounts.decode("Canvas", Buffer.from(data));
  return {
    bitmap: bytes(r.bitmap),
    soldBlocks: pick(r, "sold_blocks"),
    nextAdId: pick(r, "next_ad_id"),
    usdMicroRaised: big(pick(r, "usd_micro_raised")),
    lamportsRaised: big(pick(r, "lamports_raised")),
    lamportsToTreasury: big(pick(r, "lamports_to_treasury")),
    lamportsToBuyback: big(pick(r, "lamports_to_buyback")),
    tokensBurnedDirect: big(pick(r, "tokens_burned_direct")),
    tokensBurnedBuyback: big(pick(r, "tokens_burned_buyback")),
    lamportsSpentBuyback: big(pick(r, "lamports_spent_buyback")),
  };
}

export function decodeAd(data: Uint8Array): AdAccount {
  const r: Raw = coder.accounts.decode("Ad", Buffer.from(data));
  return {
    id: r.id,
    owner: r.owner,
    kind: enumKind(r.kind).kind as AdKind,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    title: r.title,
    link: r.link,
    imageUri: pick(r, "image_uri"),
    imageSha256: bytesToHex(bytes(pick(r, "image_sha256"))),
    payMode: enumKind(pick(r, "pay_mode")).kind as PayMode,
    paidLamports: big(pick(r, "paid_lamports")),
    paidTokens: big(pick(r, "paid_tokens")),
    usdMicro: big(pick(r, "usd_micro")),
    createdAt: num(pick(r, "created_at")),
    updatedAt: num(pick(r, "updated_at")),
  };
}

export function decodeAuction(data: Uint8Array): AuctionAccount {
  const r: Raw = coder.accounts.decode("Auction", Buffer.from(data));
  return {
    status: enumKind(r.status).kind as AuctionStatus,
    startTs: num(pick(r, "start_ts")),
    endTs: num(pick(r, "end_ts")),
    highestBidder: pick(r, "highest_bidder"),
    highestBid: big(pick(r, "highest_bid")),
    bidCount: pick(r, "bid_count"),
    lotBlocks: pick(r, "lot_blocks"),
    lotBitmap: bytes(pick(r, "lot_bitmap")),
    adId: pick(r, "ad_id"),
  };
}

/** 8-byte account discriminator from the IDL. */
export function accountDiscriminator(name: "Config" | "Canvas" | "Ad" | "Auction"): Uint8Array {
  const acc = IDL.accounts?.find((a) => a.name === name);
  if (!acc) throw new Error(`no account ${name} in IDL`);
  return Uint8Array.from(acc.discriminator);
}

// ------------------------------------------------------------------ fetchers
export async function fetchConfig(connection: Connection, programId: PublicKey = PROGRAM_ID): Promise<ConfigAccount> {
  const info = await connection.getAccountInfo(configPda(programId));
  if (!info) throw new Error("config account not found (program not initialised?)");
  return decodeConfig(info.data);
}

export async function fetchCanvas(connection: Connection, programId: PublicKey = PROGRAM_ID): Promise<CanvasAccount> {
  const info = await connection.getAccountInfo(canvasPda(programId));
  if (!info) throw new Error("canvas account not found (program not initialised?)");
  return decodeCanvas(info.data);
}

/** Address of an ad: rect ads from their top-left block, the auction lot from ["ad_auction"]. */
export function adAddress(ad: Pick<AdAccount, "kind" | "x" | "y">, programId: PublicKey = PROGRAM_ID): PublicKey {
  return ad.kind === "auctionLot" ? auctionAdPda(programId) : adPda(ad.x, ad.y, programId);
}

export async function fetchAd(connection: Connection, address: PublicKey): Promise<AdAccount | null> {
  const info = await connection.getAccountInfo(address);
  return info ? decodeAd(info.data) : null;
}

/** The rect ad whose top-left block is (x, y), if any. */
export async function fetchAdAt(connection: Connection, x: number, y: number, programId: PublicKey = PROGRAM_ID): Promise<AdAccount | null> {
  return fetchAd(connection, adPda(x, y, programId));
}

export async function fetchAuction(connection: Connection, programId: PublicKey = PROGRAM_ID): Promise<AuctionAccount | null> {
  const info = await connection.getAccountInfo(auctionPda(programId));
  return info ? decodeAuction(info.data) : null;
}

/** All Ad accounts via getProgramAccounts (discriminator filter), sorted by display id. */
export async function fetchAllAds(
  connection: Connection,
  programId: PublicKey = PROGRAM_ID,
): Promise<(AdAccount & { address: PublicKey })[]> {
  const res = await connection.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(accountDiscriminator("Ad")) } }],
  });
  return res.map((r) => ({ ...decodeAd(r.account.data), address: r.pubkey })).sort((a, b) => a.id - b.id);
}
