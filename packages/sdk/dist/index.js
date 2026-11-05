import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PYTH_PUSH_ORACLE_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  pixel_default
} from "./chunk-IN65ZUDS.js";
import {
  applyTokenDiscount,
  assertU64,
  assertValidRect,
  base64ToBytes,
  blockCoords,
  blockIndex,
  buyPriceQ,
  bytesToBase64,
  bytesToHex,
  ceilDiv,
  countSet,
  emaUpdate,
  emptyBitmap,
  estimateBurnForSolPurchase,
  fixedToNumber,
  freeBlocks,
  hexToBytes,
  isBlockSet,
  isRectFree,
  isValidRect,
  lamportsToTokens,
  markRect,
  minNextBid,
  quoteLamports,
  quoteTokens,
  quoteTokensExact,
  quoteUsd,
  rectBlockCount,
  rectBlocks,
  slowEmaUpdate,
  splitSol,
  spotPriceQ,
  tokenBlocksAvailable,
  tokenPricingStatus,
  tokenUsdFromPriceQ,
  validateAdContent,
  withSlippage,
  withinBand
} from "./chunk-OIVDMFST.js";
import {
  AD_AUCTION_SEED,
  AD_SEED,
  AUCTION_DURATION_SECS,
  AUCTION_EXTENSION_SECS,
  AUCTION_MIN_INCREMENT_BPS,
  AUCTION_MIN_INCREMENT_LAMPORTS,
  AUCTION_MIN_OPENING_BID_LAMPORTS,
  AUCTION_SEED,
  AUCTION_THRESHOLD_BLOCKS,
  BITMAP_BYTES,
  BLOCK_PX,
  BPS_DENOMINATOR,
  BUYBACK_MAX_POST_SPOT_BPS,
  BUYBACK_VAULT_SEED,
  BUYBACK_WINDOW_SECS,
  CANVAS_PX,
  CANVAS_SEED,
  CONFIG_SEED,
  DEFAULT_HERMES_URL,
  DEFAULT_MAX_PRICE_AGE_SECS,
  DEFAULT_TOKEN_BLOCKS_CAP_PER_HOUR,
  EMA_ALPHA_BPS,
  EMA_MAX_DEVIATION_BPS,
  EMA_MIN_INTERVAL_SECS,
  EMA_SEED_BAND_BPS,
  EMA_SPOT_CLAMP_BPS,
  EMA_WARMUP_CRANKS,
  EMA_WARMUP_SECS,
  EMA_WINDOW_SECS,
  GRID,
  LAMPORTS_PER_SOL_BI,
  MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR,
  MAX_CONF_BPS,
  MAX_EMA_AGE_SECS,
  MAX_EMA_STEP_BPS,
  MAX_IMAGE_URI_LEN,
  MAX_LINK_LEN,
  MAX_TITLE_LEN,
  MAX_TOKEN_BLOCKS_CAP_PER_HOUR,
  PRICE_PER_BLOCK_USD_MICRO,
  PRICE_SCALE,
  PROJECT_NAME,
  SLOW_EMA_WINDOW_SECS,
  SOL_USD_FEED_ID,
  TOKEN_DISCOUNT_BPS,
  TOKEN_SYMBOL,
  TOTAL_BLOCKS,
  TREASURY_BPS,
  USD_MICRO
} from "./chunk-GMGWLDHJ.js";

// src/pda.ts
import { PublicKey } from "@solana/web3.js";
var enc = new TextEncoder();
function configPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc.encode(CONFIG_SEED)], programId)[0];
}
function canvasPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc.encode(CANVAS_SEED)], programId)[0];
}
function buybackVaultPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc.encode(BUYBACK_VAULT_SEED)], programId)[0];
}
function auctionPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc.encode(AUCTION_SEED)], programId)[0];
}
function adPdaForBlock(blockIndex2, programId = PROGRAM_ID) {
  if (!Number.isInteger(blockIndex2) || blockIndex2 < 0 || blockIndex2 >= 1e4) throw new RangeError(`bad block index ${blockIndex2}`);
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, blockIndex2, true);
  return PublicKey.findProgramAddressSync([enc.encode(AD_SEED), b], programId)[0];
}
function adPda(x, y, programId = PROGRAM_ID) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 99 || y > 99) throw new RangeError(`bad block (${x},${y})`);
  return adPdaForBlock(y * 100 + x, programId);
}
function auctionAdPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc.encode(AD_AUCTION_SEED)], programId)[0];
}
function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}
function pythPriceFeedAccount(feedIdHex = SOL_USD_FEED_ID, shardId = 0, pushOracleProgramId = PYTH_PUSH_ORACLE_PROGRAM_ID) {
  const shard = new Uint8Array(2);
  new DataView(shard.buffer).setUint16(0, shardId, true);
  return PublicKey.findProgramAddressSync([shard, hexToBytes(feedIdHex)], pushOracleProgramId)[0];
}

// src/accounts.ts
import { utils } from "@anchor-lang/core";

// src/coder.ts
import { BorshCoder } from "@anchor-lang/core";
var IDL = pixel_default;
var coder = new BorshCoder(IDL);

// src/accounts.ts
var big = (v) => typeof v === "bigint" ? v : BigInt(v.toString());
var num = (v) => typeof v === "number" ? v : Number(v.toString());
var bytes = (v) => Uint8Array.from(v);
function enumKind(v) {
  const k = Object.keys(v)[0];
  if (!k) throw new Error("empty enum");
  return { kind: k.charAt(0).toLowerCase() + k.slice(1), fields: v[k] ?? {} };
}
function pick(raw, snake) {
  if (snake in raw) return raw[snake];
  const camel = snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return raw[camel];
}
function decodeConfig(data) {
  const r = coder.accounts.decode("Config", Buffer.from(data));
  const ps = enumKind(pick(r, "price_source"));
  const priceSource = ps.kind === "bondingCurve" ? { kind: "bondingCurve", curve: ps.fields.curve } : {
    kind: "pool",
    pool: ps.fields.pool,
    baseVault: pick(ps.fields, "base_vault"),
    quoteVault: pick(ps.fields, "quote_vault")
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
    tokenBlocksAllowanceUpdatedAt: num(pick(r, "token_blocks_allowance_updated_at"))
  };
}
function decodeCanvas(data) {
  const r = coder.accounts.decode("Canvas", Buffer.from(data));
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
    lamportsSpentBuyback: big(pick(r, "lamports_spent_buyback"))
  };
}
function decodeAd(data) {
  const r = coder.accounts.decode("Ad", Buffer.from(data));
  return {
    id: r.id,
    owner: r.owner,
    kind: enumKind(r.kind).kind,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    title: r.title,
    link: r.link,
    imageUri: pick(r, "image_uri"),
    imageSha256: bytesToHex(bytes(pick(r, "image_sha256"))),
    payMode: enumKind(pick(r, "pay_mode")).kind,
    paidLamports: big(pick(r, "paid_lamports")),
    paidTokens: big(pick(r, "paid_tokens")),
    usdMicro: big(pick(r, "usd_micro")),
    createdAt: num(pick(r, "created_at")),
    updatedAt: num(pick(r, "updated_at"))
  };
}
function decodeAuction(data) {
  const r = coder.accounts.decode("Auction", Buffer.from(data));
  return {
    status: enumKind(r.status).kind,
    startTs: num(pick(r, "start_ts")),
    endTs: num(pick(r, "end_ts")),
    highestBidder: pick(r, "highest_bidder"),
    highestBid: big(pick(r, "highest_bid")),
    bidCount: pick(r, "bid_count"),
    lotBlocks: pick(r, "lot_blocks"),
    lotBitmap: bytes(pick(r, "lot_bitmap")),
    adId: pick(r, "ad_id")
  };
}
function accountDiscriminator(name) {
  const acc = IDL.accounts?.find((a) => a.name === name);
  if (!acc) throw new Error(`no account ${name} in IDL`);
  return Uint8Array.from(acc.discriminator);
}
async function fetchConfig(connection, programId = PROGRAM_ID) {
  const info = await connection.getAccountInfo(configPda(programId));
  if (!info) throw new Error("config account not found (program not initialised?)");
  return decodeConfig(info.data);
}
async function fetchCanvas(connection, programId = PROGRAM_ID) {
  const info = await connection.getAccountInfo(canvasPda(programId));
  if (!info) throw new Error("canvas account not found (program not initialised?)");
  return decodeCanvas(info.data);
}
function adAddress(ad, programId = PROGRAM_ID) {
  return ad.kind === "auctionLot" ? auctionAdPda(programId) : adPda(ad.x, ad.y, programId);
}
async function fetchAd(connection, address) {
  const info = await connection.getAccountInfo(address);
  return info ? decodeAd(info.data) : null;
}
async function fetchAdAt(connection, x, y, programId = PROGRAM_ID) {
  return fetchAd(connection, adPda(x, y, programId));
}
async function fetchAuction(connection, programId = PROGRAM_ID) {
  const info = await connection.getAccountInfo(auctionPda(programId));
  return info ? decodeAuction(info.data) : null;
}
async function fetchAllAds(connection, programId = PROGRAM_ID) {
  const res = await connection.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(accountDiscriminator("Ad")) } }]
  });
  return res.map((r) => ({ ...decodeAd(r.account.data), address: r.pubkey })).sort((a, b) => a.id - b.id);
}

// src/events.ts
import { EventParser } from "@anchor-lang/core";
var g = (r, snake) => {
  if (snake in r) return r[snake];
  return r[snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())];
};
var n = (v) => Number(String(v));
function normalizeEvent(name, r) {
  switch (name) {
    case "AdPurchased":
      return {
        name,
        data: {
          adId: n(g(r, "ad_id")),
          ad: r.ad,
          owner: r.owner,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          payMode: enumKind(g(r, "pay_mode")).kind,
          lamports: big(r.lamports),
          tokensBurned: big(g(r, "tokens_burned")),
          usdMicro: big(g(r, "usd_micro")),
          ts: n(r.ts)
        }
      };
    case "AdUpdated":
      return { name, data: { adId: n(g(r, "ad_id")), ad: r.ad, ts: n(r.ts) } };
    case "AdTransferred":
      return { name, data: { adId: n(g(r, "ad_id")), ad: r.ad, from: r.from, to: r.to, ts: n(r.ts) } };
    case "TokenPriceUpdated":
      return { name, data: { spot: big(r.spot), ema: big(r.ema), slowEma: big(g(r, "slow_ema")), ts: n(r.ts) } };
    case "BuybackReleased":
      return { name, data: { keeper: r.keeper, lamports: big(r.lamports), ts: n(r.ts) } };
    case "BuybackBurned":
      return { name, data: { lamportsIn: big(g(r, "lamports_in")), tokensBurned: big(g(r, "tokens_burned")), ts: n(r.ts) } };
    case "BuybackWrittenOff":
      return { name, data: { keeper: r.keeper, lamports: big(r.lamports), ts: n(r.ts) } };
    case "AuctionStarted":
      return { name, data: { lotBlocks: n(g(r, "lot_blocks")), startTs: n(g(r, "start_ts")), endTs: n(g(r, "end_ts")) } };
    case "AuctionBid":
      return { name, data: { bidder: r.bidder, lamports: big(r.lamports), endTs: n(g(r, "end_ts")), ts: n(r.ts) } };
    case "AuctionSettled":
      return { name, data: { winner: r.winner, lamports: big(r.lamports), adId: n(g(r, "ad_id")), ad: r.ad } };
    case "AuctionResumed":
      return { name, data: { endTs: n(g(r, "end_ts")), pausedSecs: n(g(r, "paused_secs")) } };
    case "AuctionRestarted":
      return { name, data: { endTs: n(g(r, "end_ts")) } };
    default:
      return null;
  }
}
function parseEvents(logs, programId = PROGRAM_ID) {
  const parser = new EventParser(programId, coder);
  const out = [];
  for (const ev of parser.parseLogs([...logs])) {
    const e = normalizeEvent(ev.name, ev.data);
    if (e) out.push(e);
  }
  return out;
}
function decodeEventData(base64) {
  const ev = coder.events.decode(base64);
  return ev ? normalizeEvent(ev.name, ev.data) : null;
}

// src/instructions.ts
import { BN } from "@anchor-lang/core";
import { PublicKey as PublicKey2, TransactionInstruction } from "@solana/web3.js";
var BPF_UPGRADEABLE_LOADER = new PublicKey2("BPFLoaderUpgradeab1e11111111111111111111111");
function buildIx(name, args, accounts, programId = PROGRAM_ID) {
  const def = IDL.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`unknown instruction ${name}`);
  const keys = def.accounts.map((a) => {
    if ("accounts" in a) throw new Error("nested account groups unsupported");
    let key = accounts[a.name];
    if (!key && a.address) key = new PublicKey2(a.address);
    if (!key) {
      if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false };
      throw new Error(`${name}: missing account ${a.name}`);
    }
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  return new TransactionInstruction({ programId, keys, data: coder.instruction.encode(name, args) });
}
var u64 = (v, what) => new BN(assertU64(v, what).toString());
var sha = (v) => {
  const b = typeof v === "string" ? hexToBytes(v) : v;
  if (b.length !== 32) throw new RangeError("image_sha256 must be 32 bytes");
  return Array.from(b);
};
function priceSourceArg(ps) {
  return ps.kind === "bondingCurve" ? { BondingCurve: { curve: ps.curve } } : { Pool: { pool: ps.pool, base_vault: ps.baseVault, quote_vault: ps.quoteVault } };
}
function priceSourceAccounts(ps) {
  return ps.kind === "bondingCurve" ? { price_source: ps.curve, pool_base_vault: null, pool_quote_vault: null } : { price_source: ps.pool, pool_base_vault: ps.baseVault, pool_quote_vault: ps.quoteVault };
}
function computeBudgetIxs(opts = {}) {
  const out = [];
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
function buyArgs(p) {
  assertValidRect(p.rect);
  return {
    x: p.rect.x,
    y: p.rect.y,
    w: p.rect.w,
    h: p.rect.h,
    title: p.content.title,
    link: p.content.link,
    image_uri: p.content.imageUri,
    image_sha256: sha(p.content.imageSha256)
  };
}
function buyWithSolIx(p) {
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
      system_program: SYSTEM_PROGRAM_ID
    },
    pid
  );
}
function buyWithTokenIx(p) {
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
      system_program: SYSTEM_PROGRAM_ID
    },
    pid
  );
}
function crankTokenPriceIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("crank_token_price", {}, { config: configPda(pid), ...priceSourceAccounts(p.priceSource) }, pid);
}
function releaseBuybackIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "release_buyback",
    { lamports: u64(p.lamports, "lamports") },
    { keeper: p.keeper, config: configPda(pid), buyback_vault: buybackVaultPda(pid), system_program: SYSTEM_PROGRAM_ID },
    pid
  );
}
function recordBuybackBurnIx(p) {
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
      system_program: SYSTEM_PROGRAM_ID
    },
    pid
  );
}
function updateAdIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "update_ad",
    { title: p.content.title, link: p.content.link, image_uri: p.content.imageUri, image_sha256: sha(p.content.imageSha256) },
    { owner: p.owner, ad: p.ad },
    pid
  );
}
function transferAdIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("transfer_ad", { new_owner: p.newOwner }, { owner: p.owner, ad: p.ad }, pid);
}
function startFinalAuctionIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "start_final_auction",
    {},
    { payer: p.payer, config: configPda(pid), canvas: canvasPda(pid), auction: auctionPda(pid), system_program: SYSTEM_PROGRAM_ID },
    pid
  );
}
function bidFinalAuctionIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx(
    "bid_final_auction",
    { lamports: u64(p.lamports, "lamports") },
    {
      bidder: p.bidder,
      config: configPda(pid),
      auction: auctionPda(pid),
      previous_bidder: p.previousBidder,
      system_program: SYSTEM_PROGRAM_ID
    },
    pid
  );
}
function restartFinalAuctionIx(p = {}) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("restart_final_auction", {}, { config: configPda(pid), auction: auctionPda(pid) }, pid);
}
function settleFinalAuctionIx(p) {
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
      system_program: SYSTEM_PROGRAM_ID
    },
    pid
  );
}
function initializeIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  const programData = PublicKey2.findProgramAddressSync([pid.toBytes()], BPF_UPGRADEABLE_LOADER)[0];
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
        token_blocks_cap_per_hour: p.tokenBlocksCapPerHour ?? 1e3
      }
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
      system_program: SYSTEM_PROGRAM_ID
    },
    pid
  );
}
function adminIx(name, args, admin, programId) {
  const pid = programId ?? PROGRAM_ID;
  return buildIx(name, args, { admin, config: configPda(pid) }, pid);
}
function setPausedIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("set_paused", { paused: p.paused }, { admin: p.admin, config: configPda(pid), auction: auctionPda(pid) }, pid);
}
var setTreasuryIx = (p) => adminIx("set_treasury", { treasury: p.treasury }, p.admin, p.programId);
var setKeeperIx = (p) => adminIx("set_keeper", { keeper: p.keeper }, p.admin, p.programId);
var setPriceSourceIx = (p) => adminIx(
  "set_price_source",
  { price_source: priceSourceArg(p.priceSource), initial_ema_price_sol: new BN(p.initialEmaPriceSol.toString()) },
  p.admin,
  p.programId
);
var setParamsIx = (p) => adminIx(
  "set_params",
  {
    max_price_age_secs: u64(p.maxPriceAgeSecs, "maxPriceAgeSecs"),
    buyback_cap_lamports_per_hour: u64(p.buybackCapLamportsPerHour, "cap"),
    buyback_max_slippage_bps: p.buybackMaxSlippageBps,
    token_blocks_cap_per_hour: p.tokenBlocksCapPerHour
  },
  p.admin,
  p.programId
);
var proposeAdminIx = (p) => adminIx("propose_admin", { new_admin: p.newAdmin }, p.admin, p.programId);
function acceptAdminIx(p) {
  const pid = p.programId ?? PROGRAM_ID;
  return buildIx("accept_admin", {}, { new_admin: p.newAdmin, config: configPda(pid) }, pid);
}

// src/client.ts
import { PublicKey as PublicKeyCtor, Transaction } from "@solana/web3.js";

// src/compute.ts
var CU_LIMITS = {
  initialize: 6e4,
  crankTokenPrice: 2e4,
  updateAd: 15e3,
  transferAd: 15e3,
  releaseBuyback: 2e4,
  recordBuybackBurn: 4e4,
  startFinalAuction: 8e4,
  bidFinalAuction: 2e4,
  restartFinalAuction: 15e3,
  settleFinalAuction: 7e4
};
function buyCuLimit(rect, mode) {
  return (mode === "sol" ? 5e4 : 65e3) + 1200 * rect.h;
}
async function estimatePriorityFee(connection, writableAccounts, opts = {}) {
  const min = opts.minMicroLamports ?? 1e3;
  const max = opts.maxMicroLamports ?? 2e5;
  const pct = Math.min(100, Math.max(0, opts.percentile ?? 75));
  let fees = [];
  try {
    const res = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts });
    fees = res.map((r) => r.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
  } catch {
    return min;
  }
  if (fees.length === 0) return min;
  const idx = Math.min(fees.length - 1, Math.ceil(pct / 100 * fees.length) - 1);
  const v = fees[Math.max(0, idx)];
  return Math.min(max, Math.max(min, Math.round(v)));
}
function priorityFeeLamports(cuLimit, microLamportsPerCu) {
  return (BigInt(cuLimit) * BigInt(microLamportsPerCu) + 999999n) / 1000000n;
}

// src/client.ts
function decodePriceUpdateV2(data, owner) {
  if (owner && !owner.equals(PYTH_RECEIVER_PROGRAM_ID)) throw new Error("price update not owned by the Pyth receiver");
  const r = coder.types.decode("PriceUpdateV2", Buffer.from(data.subarray(8)));
  const m = r.price_message ?? r.priceMessage;
  const level = r.verification_level ?? r.verificationLevel;
  return {
    price: big(m.price),
    expo: Number(m.exponent),
    conf: big(m.conf),
    publishTime: Number(String(m.publish_time ?? m.publishTime)),
    feedId: bytesToHex(Uint8Array.from(m.feed_id ?? m.feedId)),
    verified: "Full" in level || "full" in level
  };
}
async function fetchSolUsd(connection, priceUpdate = pythPriceFeedAccount()) {
  const info = await connection.getAccountInfo(priceUpdate);
  if (!info) throw new Error(`price update account ${priceUpdate.toBase58()} not found`);
  const p = decodePriceUpdateV2(info.data, info.owner);
  if (p.feedId !== SOL_USD_FEED_ID) throw new Error("not the SOL/USD feed");
  return p;
}
var u64At = (d, off) => new DataView(d.buffer, d.byteOffset).getBigUint64(off, true);
var i128At = (d, off) => {
  const lo = u64At(d, off);
  const hi = new DataView(d.buffer, d.byteOffset).getBigInt64(off + 8, true);
  return (hi << 64n) + lo;
};
function parseBondingCurve(data) {
  const disc = [23, 183, 248, 55, 96, 216, 172, 96];
  if (data.length < 49 || disc.some((b, i) => data[i] !== b)) throw new Error("not a pump.fun BondingCurve");
  if (data.length >= 115 && data.subarray(83, 115).some((b) => b !== 0)) {
    const wsol = WSOL_MINT.toBytes();
    if (!data.subarray(83, 115).every((b, i) => b === wsol[i])) throw new Error("curve is not SOL-quoted");
  }
  return { quoteLamports: u64At(data, 16), baseUnits: u64At(data, 8), complete: data[48] !== 0 };
}
function parsePumpPool(data) {
  const disc = [241, 154, 109, 4, 17, 177, 109, 188];
  if (data.length < 203 || disc.some((b, i) => data[i] !== b)) throw new Error("not a PumpSwap Pool");
  const pk = (o) => new PublicKeyCtor(data.subarray(o, o + 32));
  return {
    baseMint: pk(43),
    quoteMint: pk(75),
    baseVault: pk(139),
    quoteVault: pk(171),
    virtualQuoteReserves: data.length >= 261 ? i128At(data, 245) : 0n
  };
}
function poolSpotPriceQ(poolData, baseVaultData, quoteVaultData) {
  const pool = parsePumpPool(poolData);
  return spotPriceQ(u64At(quoteVaultData, 64) + pool.virtualQuoteReserves, u64At(baseVaultData, 64));
}
async function readSpotPriceQ(connection, ps) {
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
async function buildBuyWithSolIxs(connection, p) {
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
    programId: pid
  });
  const computeUnits = p.computeUnits ?? buyCuLimit(p.rect, "sol");
  return {
    instructions: [...computeBudgetIxs({ units: computeUnits, microLamports: p.priorityMicroLamports }), ix],
    quote: { ad: adPda(p.rect.x, p.rect.y, pid), usdMicro, lamports, maxLamports, solUsd, computeUnits }
  };
}
function plannedEma(config, nowSecs) {
  const age = nowSecs - config.emaUpdatedAt;
  const crank = config.tokenEmaPriceSol !== 0n && age > MAX_EMA_AGE_SECS - 120 && age >= EMA_MIN_INTERVAL_SECS;
  return { emaQ: config.tokenEmaPriceSol, crank };
}
var TokenPricingUnavailableError = class extends Error {
  constructor(reason, detail) {
    super(`token payments unavailable (${reason}): ${detail}`);
    this.reason = reason;
    this.name = "TokenPricingUnavailableError";
  }
  reason;
};
async function buildBuyWithTokenIxs(connection, p) {
  const pid = p.programId ?? PROGRAM_ID;
  const priceUpdate = p.priceUpdate ?? pythPriceFeedAccount();
  const [config, solUsd] = await Promise.all([fetchConfig(connection, pid), fetchSolUsd(connection, priceUpdate)]);
  let spotQ;
  try {
    spotQ = await readSpotPriceQ(connection, config.priceSource);
  } catch (e) {
    throw new TokenPricingUnavailableError("sourceUnavailable", `token price source unavailable (${e.message}); likely migrating to PumpSwap`);
  }
  const now = Math.floor(Date.now() / 1e3);
  const status = tokenPricingStatus(config, spotQ, now, p.rect.w * p.rect.h);
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
      programId: pid
    })
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
      computeUnits
    }
  };
}
async function buildBuyTx(connection, p) {
  const pid = p.programId ?? PROGRAM_ID;
  const [microLamports, bh] = await Promise.all([
    estimatePriorityFee(connection, [canvasPda(pid)], p),
    connection.getLatestBlockhash("confirmed")
  ]);
  const built = p.mode === "sol" ? await buildBuyWithSolIxs(connection, { ...p, priorityMicroLamports: microLamports }) : await buildBuyWithTokenIxs(connection, { ...p, priorityMicroLamports: microLamports });
  const transaction = new Transaction({ feePayer: p.buyer, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
  transaction.add(...built.instructions);
  return {
    transaction,
    quote: built.quote,
    computeUnitLimit: built.quote.computeUnits,
    microLamportsPerCu: microLamports,
    maxPriorityFeeLamports: priorityFeeLamports(built.quote.computeUnits, microLamports),
    lastValidBlockHeight: bh.lastValidBlockHeight
  };
}
async function buildBidIxs(connection, p) {
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
        programId: p.programId
      })
    ]
  };
}
function buildSettleIxs(p) {
  return [
    ...computeBudgetIxs({ units: CU_LIMITS.settleFinalAuction, microLamports: p.priorityMicroLamports }),
    settleFinalAuctionIx({ payer: p.payer, programId: p.programId })
  ];
}
export {
  AD_AUCTION_SEED,
  AD_SEED,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AUCTION_DURATION_SECS,
  AUCTION_EXTENSION_SECS,
  AUCTION_MIN_INCREMENT_BPS,
  AUCTION_MIN_INCREMENT_LAMPORTS,
  AUCTION_MIN_OPENING_BID_LAMPORTS,
  AUCTION_SEED,
  AUCTION_THRESHOLD_BLOCKS,
  BITMAP_BYTES,
  BLOCK_PX,
  BPS_DENOMINATOR,
  BUYBACK_MAX_POST_SPOT_BPS,
  BUYBACK_VAULT_SEED,
  BUYBACK_WINDOW_SECS,
  CANVAS_PX,
  CANVAS_SEED,
  COMPUTE_BUDGET_PROGRAM_ID,
  CONFIG_SEED,
  CU_LIMITS,
  DEFAULT_HERMES_URL,
  DEFAULT_MAX_PRICE_AGE_SECS,
  DEFAULT_TOKEN_BLOCKS_CAP_PER_HOUR,
  EMA_ALPHA_BPS,
  EMA_MAX_DEVIATION_BPS,
  EMA_MIN_INTERVAL_SECS,
  EMA_SEED_BAND_BPS,
  EMA_SPOT_CLAMP_BPS,
  EMA_WARMUP_CRANKS,
  EMA_WARMUP_SECS,
  EMA_WINDOW_SECS,
  GRID,
  IDL,
  LAMPORTS_PER_SOL_BI,
  MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR,
  MAX_CONF_BPS,
  MAX_EMA_AGE_SECS,
  MAX_EMA_STEP_BPS,
  MAX_IMAGE_URI_LEN,
  MAX_LINK_LEN,
  MAX_TITLE_LEN,
  MAX_TOKEN_BLOCKS_CAP_PER_HOUR,
  PRICE_PER_BLOCK_USD_MICRO,
  PRICE_SCALE,
  PROGRAM_ID,
  PROJECT_NAME,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PYTH_PUSH_ORACLE_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  SLOW_EMA_WINDOW_SECS,
  SOL_USD_FEED_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_DISCOUNT_BPS,
  TOKEN_PROGRAM_ID,
  TOKEN_SYMBOL,
  TOTAL_BLOCKS,
  TREASURY_BPS,
  TokenPricingUnavailableError,
  USD_MICRO,
  WSOL_MINT,
  acceptAdminIx,
  accountDiscriminator,
  adAddress,
  adPda,
  adPdaForBlock,
  applyTokenDiscount,
  assertValidRect,
  associatedTokenAddress,
  auctionAdPda,
  auctionPda,
  base64ToBytes,
  bidFinalAuctionIx,
  big,
  blockCoords,
  blockIndex,
  buildBidIxs,
  buildBuyTx,
  buildBuyWithSolIxs,
  buildBuyWithTokenIxs,
  buildIx,
  buildSettleIxs,
  buyCuLimit,
  buyPriceQ,
  buyWithSolIx,
  buyWithTokenIx,
  buybackVaultPda,
  bytesToBase64,
  bytesToHex,
  canvasPda,
  ceilDiv,
  coder,
  computeBudgetIxs,
  configPda,
  countSet,
  crankTokenPriceIx,
  decodeAd,
  decodeAuction,
  decodeCanvas,
  decodeConfig,
  decodeEventData,
  decodePriceUpdateV2,
  emaUpdate,
  emptyBitmap,
  enumKind,
  estimateBurnForSolPurchase,
  estimatePriorityFee,
  fetchAd,
  fetchAdAt,
  fetchAllAds,
  fetchAuction,
  fetchCanvas,
  fetchConfig,
  fetchSolUsd,
  fixedToNumber,
  freeBlocks,
  hexToBytes,
  initializeIx,
  isBlockSet,
  isRectFree,
  isValidRect,
  lamportsToTokens,
  markRect,
  minNextBid,
  normalizeEvent,
  parseBondingCurve,
  parseEvents,
  parsePumpPool,
  plannedEma,
  poolSpotPriceQ,
  priceSourceAccounts,
  priorityFeeLamports,
  proposeAdminIx,
  pythPriceFeedAccount,
  quoteLamports,
  quoteTokens,
  quoteTokensExact,
  quoteUsd,
  readSpotPriceQ,
  recordBuybackBurnIx,
  rectBlockCount,
  rectBlocks,
  releaseBuybackIx,
  restartFinalAuctionIx,
  setKeeperIx,
  setParamsIx,
  setPausedIx,
  setPriceSourceIx,
  setTreasuryIx,
  settleFinalAuctionIx,
  slowEmaUpdate,
  splitSol,
  spotPriceQ,
  startFinalAuctionIx,
  tokenBlocksAvailable,
  tokenPricingStatus,
  tokenUsdFromPriceQ,
  transferAdIx,
  updateAdIx,
  validateAdContent,
  withSlippage,
  withinBand
};
//# sourceMappingURL=index.js.map