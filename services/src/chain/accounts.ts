// On-chain reads, all via @mpb/sdk (account decoders, PDAs, pump curve/pool spot parsing).
// Token prices are "q" fixed-point: LAMPORTS per token base unit * 1e18 (chain PRICE_SCALE).
import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import {
  adPda,
  auctionAdPda,
  auctionPda,
  buybackVaultPda,
  configPda,
  decodeAd,
  decodeAuction,
  decodeConfig,
  readSpotPriceQ,
  tokenPricingStatus,
  type ConfigAccount,
} from "@mpb/sdk";

/** Ad account content as services uses it (base58 owner, hex sha). */
export interface AdAccount {
  id: number;
  owner: string;
  kind: "rect" | "auctionLot";
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  link: string;
  imageUri: string;
  imageSha256: string; // hex
  payMode: "sol" | "token" | "auction";
  paidLamports: bigint;
  paidTokens: bigint;
  usdMicro: bigint;
  createdAt: bigint;
  updatedAt: bigint;
}

/** What we know about an ad from its events: enough to derive the account address. */
export interface AdRef {
  id: number;
  /** Ad account address from the event, when known. */
  address?: string | null;
  x: number;
  y: number;
  payMode: "sol" | "token" | "auction";
}

/** Rect ads live at ["ad", top-left block u16 LE]; the auction lot at ["ad_auction"]. */
export function adAddressFor(ref: AdRef, programId: PublicKey): PublicKey {
  if (ref.address) return new PublicKey(ref.address);
  return ref.payMode === "auction" ? auctionAdPda(programId) : adPda(ref.x, ref.y, programId);
}

export interface OnchainTokenPrice {
  spot: bigint;
  /** fast EMA */
  ema: bigint;
  /** slow (4h) EMA; equals ema when the program has none */
  slow: bigint;
  pricedBy?: "spot" | "ema" | "slowEma";
  blocksAvailable?: number;
  unavailable?: { reason: string; detail: string };
}

/** Everything services reads from chain, behind one interface (fakeable in tests). */
export interface ChainReader {
  fetchAd(ref: AdRef, commitment?: Commitment): Promise<AdAccount | null>;
  fetchTokenSupply(): Promise<bigint | null>;
  /**
   * Spot and EMA as q (lamports per base unit * 1e18); null if unavailable. `unavailable` is set
   * when buy_with_token would currently be rejected (EMA not seeded / warming up / stale / spot deviation).
   */
  fetchTokenPrice(blocks?: number): Promise<OnchainTokenPrice | null>;
  fetchBuybackVaultLamports(): Promise<bigint | null>;
  /** Blocks of the final-auction lot (Auction.lot_bitmap); null if no auction. */
  fetchAuctionLotBlocks?(): Promise<number[] | null>;
  /** Lamports release_buyback would currently allow (token bucket); null if unknown. */
  fetchBuybackReleasable?(): Promise<bigint | null>;
  /** An unreconciled release (Config.buyback_outstanding_lamports) and roughly when it happened. */
  fetchBuybackOutstanding?(): Promise<{ lamports: bigint; sinceSecs: number } | null>;
}

export class RpcChainReader implements ChainReader {
  readonly programId: PublicKey | null;
  constructor(
    readonly conn: Connection,
    programId: string | undefined,
    readonly tokenMint: string | undefined,
  ) {
    this.programId = programId ? new PublicKey(programId) : null;
  }

  async fetchAd(ref: AdRef, commitment: Commitment = "confirmed"): Promise<AdAccount | null> {
    if (!this.programId) return null;
    const info = await this.conn.getAccountInfo(adAddressFor(ref, this.programId), commitment);
    if (!info) return null;
    const a = decodeAd(info.data);
    // A different ad at the same top-left block would be a bug; guard against stale reads.
    if (ref.payMode !== "auction" && a.id !== ref.id) return null;
    return {
      ...a,
      owner: a.owner.toBase58(),
      createdAt: BigInt(a.createdAt),
      updatedAt: BigInt(a.updatedAt),
    };
  }

  async fetchTokenSupply() {
    if (!this.tokenMint) return null;
    const s = await this.conn.getTokenSupply(new PublicKey(this.tokenMint), "confirmed");
    return BigInt(s.value.amount);
  }

  async fetchConfig(): Promise<ConfigAccount | null> {
    if (!this.programId) return null;
    const info = await this.conn.getAccountInfo(configPda(this.programId), "confirmed");
    return info ? decodeConfig(info.data) : null;
  }

  async fetchTokenPrice(blocks?: number): Promise<OnchainTokenPrice | null> {
    const cfg = await this.fetchConfig();
    if (!cfg) return null;
    const ema = cfg.tokenEmaPriceSol;
    const slow = cfg.tokenSlowEmaPriceSol && cfg.tokenSlowEmaPriceSol > 0n ? cfg.tokenSlowEmaPriceSol : ema;
    // Live reserves: curve virtual reserves, or pool vault + virtual_quote_reserves (SDK parsers).
    const spot = await readSpotPriceQ(this.conn, cfg.priceSource);
    // Same gate the program applies in buy_with_token: seeded, warm-up, staleness, one-sided
    // deviation, and (with `blocks`) the hourly token-paid block cap.
    const st = tokenPricingStatus(cfg, spot, Math.floor(Date.now() / 1000), blocks);
    if (!st.ok) return { spot, ema, slow, unavailable: { reason: st.reason, detail: st.detail } };
    return { spot, ema, slow, pricedBy: st.pricedBy, blocksAvailable: st.blocksAvailable };
  }

  async fetchBuybackVaultLamports() {
    if (!this.programId) return null;
    return BigInt(await this.conn.getBalance(buybackVaultPda(this.programId), "confirmed"));
  }

  /** Mirror of the program's bucket: min(cap, allowance + cap * elapsed / 3600), minus anything outstanding. */
  async fetchBuybackReleasable(): Promise<bigint | null> {
    const c = await this.fetchConfig();
    if (!c) return null;
    const cap = c.buybackCapLamportsPerHour;
    const elapsed = BigInt(Math.max(0, Math.floor(Date.now() / 1000) - Number(c.buybackAllowanceUpdatedAt)));
    let allowance = c.buybackAllowance + (cap * elapsed) / 3600n;
    if (allowance > cap) allowance = cap;
    return c.buybackOutstandingLamports > 0n ? 0n : allowance;
  }

  async fetchBuybackOutstanding(): Promise<{ lamports: bigint; sinceSecs: number } | null> {
    const c = await this.fetchConfig();
    if (!c) return null;
    // release_buyback refills/updates the allowance timestamp, so it bounds the release time.
    return { lamports: c.buybackOutstandingLamports, sinceSecs: Math.floor(Date.now() / 1000) - Number(c.buybackAllowanceUpdatedAt) };
  }

  async fetchAuctionLotBlocks(): Promise<number[] | null> {
    if (!this.programId) return null;
    const info = await this.conn.getAccountInfo(auctionPda(this.programId), "confirmed");
    if (!info) return null;
    const a = decodeAuction(info.data);
    const out: number[] = [];
    for (let i = 0; i < 10_000; i++) if ((a.lotBitmap[i >> 3]! >> (i & 7)) & 1) out.push(i);
    return out;
  }
}
