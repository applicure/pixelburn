import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  adAddress,
  adPda,
  adPdaForBlock,
  auctionAdPda,
  bidFinalAuctionIx,
  buyWithSolIx,
  buyWithTokenIx,
  canvasPda,
  coder,
  configPda,
  decodeAd,
  decodeCanvas,
  decodeConfig,
  decodeEventData,
  IDL,
  parseEvents,
  PROGRAM_ID,
  pythPriceFeedAccount,
  SOL_USD_FEED_ID,
  TOKEN_2022_PROGRAM_ID,
} from "../src/index.js";

const content = { title: "Hi", link: "https://x.io", imageUri: "ar://abc", imageSha256: new Uint8Array(32).fill(7) };

describe("PDAs", () => {
  it("are deterministic and match seeds", () => {
    expect(configPda().equals(PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0])).toBe(true);
    const b = Buffer.alloc(2);
    b.writeUInt16LE(2 * 100 + 58);
    expect(adPda(58, 2).equals(PublicKey.findProgramAddressSync([Buffer.from("ad"), b], PROGRAM_ID)[0])).toBe(true);
    expect(adPdaForBlock(258).equals(adPda(58, 2))).toBe(true);
    expect(auctionAdPda().equals(PublicKey.findProgramAddressSync([Buffer.from("ad_auction")], PROGRAM_ID)[0])).toBe(true);
    expect(adAddress({ kind: "rect", x: 58, y: 2 }).equals(adPda(58, 2))).toBe(true);
    expect(adAddress({ kind: "auctionLot", x: 0, y: 0 }).equals(auctionAdPda())).toBe(true);
    expect(() => adPda(-1, 0)).toThrow();
    expect(() => adPda(100, 0)).toThrow();
    // known mainnet sponsored SOL/USD feed account (shard 0)
    expect(pythPriceFeedAccount().toBase58()).toBe("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
  });
});

describe("instruction builders", () => {
  it("buy_with_sol: discriminator, args, IDL account order", () => {
    const buyer = Keypair.generate().publicKey;
    const treasury = Keypair.generate().publicKey;
    const pu = pythPriceFeedAccount();
    const ix = buyWithSolIx({ buyer, rect: { x: 1, y: 2, w: 3, h: 4 }, content, priceUpdate: pu, treasury, maxLamports: 123n });
    const def = IDL.instructions.find((i) => i.name === "buy_with_sol")!;
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(def.discriminator);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [buyer, configPda(), canvasPda(), adPda(1, 2), treasury, ix.keys[5]!.pubkey, pu, PublicKey.default].map((k) => k.toBase58()),
    );
    expect(ix.keys[0]!.isSigner && ix.keys[0]!.isWritable).toBe(true);
    expect(ix.keys[4]!.isWritable).toBe(true);
    const decoded = coder.instruction.decode(Buffer.from(ix.data))!;
    expect(decoded.name).toBe("buy_with_sol");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = decoded.data as any;
    expect([d.x, d.y, d.w, d.h, d.title, d.max_lamports.toString()]).toEqual([1, 2, 3, 4, "Hi", "123"]);
    expect(() => buyWithSolIx({ buyer, rect: { x: 99, y: 0, w: 2, h: 1 }, content, priceUpdate: pu, treasury, maxLamports: 1n })).toThrow();
    expect(() => buyWithSolIx({ buyer, rect: { x: 0, y: 0, w: 1, h: 1 }, content, priceUpdate: pu, treasury, maxLamports: -1n })).toThrow();
  });

  it("buy_with_token: optional pool vaults become program id for curve source", () => {
    const buyer = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const curve = Keypair.generate().publicKey;
    const ix = buyWithTokenIx({
      buyer, rect: { x: 0, y: 0, w: 1, h: 1 }, content, priceUpdate: pythPriceFeedAccount(),
      tokenMint: mint, tokenProgram: TOKEN_2022_PROGRAM_ID, priceSource: { kind: "bondingCurve", curve }, maxTokens: 5n,
    });
    expect(ix.keys[7]!.pubkey.equals(curve)).toBe(true);
    expect(ix.keys[8]!.pubkey.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys[9]!.pubkey.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys[10]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("bid: first bid has no previous bidder", () => {
    const bidder = Keypair.generate().publicKey;
    const ix = bidFinalAuctionIx({ bidder, lamports: 1n, previousBidder: null });
    expect(ix.keys[3]!.pubkey.equals(PROGRAM_ID)).toBe(true);
  });
});

describe("decoders and events", () => {
  it("roundtrip accounts", async () => {
    const owner = Keypair.generate().publicKey;
    const adData = await coder.accounts.encode("Ad", {
      id: 3, owner, kind: { AuctionLot: {} }, x: 0, y: 0, w: 0, h: 0, title: "t", link: "https://l", image_uri: "ar://i",
      image_sha256: Array(32).fill(1), pay_mode: { Auction: {} }, paid_lamports: new BN("18446744073709551615"),
      paid_tokens: new BN(0), usd_micro: new BN(0), created_at: new BN(5), updated_at: new BN(6), bump: 255,
    });
    const ad = decodeAd(adData);
    expect(ad.kind).toBe("auctionLot");
    expect(ad.payMode).toBe("auction");
    expect(ad.paidLamports).toBe((1n << 64n) - 1n);
    expect(ad.imageSha256).toBe("01".repeat(32));

    // Anchor's TS encoder uses a 1000-byte scratch buffer, so build the 1321-byte Canvas by hand.
    const canvasData = Buffer.alloc(1321);
    Buffer.from(IDL.accounts!.find((a) => a.name === "Canvas")!.discriminator).copy(canvasData, 0);
    canvasData[8 + 1249] = 128;
    canvasData.writeUInt16LE(1, 8 + 1250);
    canvasData.writeUInt32LE(1, 8 + 1252);
    for (let i = 0; i < 7; i++) canvasData.writeBigUInt64LE(BigInt(i + 1), 8 + 1256 + 8 * i);
    const c = decodeCanvas(canvasData);
    expect(c.bitmap[1249]).toBe(128);
    expect(c.lamportsSpentBuyback).toBe(7n);
    expect(c.usdMicroRaised).toBe(1n);
    expect(c.soldBlocks).toBe(1);

    const k = () => Keypair.generate().publicKey;
    const pool = k();
    const cfgData = await coder.accounts.encode("Config", {
      admin: k(), pending_admin: PublicKey.default, treasury: k(), keeper: k(), token_mint: k(), token_program: k(), token_decimals: 6,
      pyth_feed_id: Array.from(Buffer.from(SOL_USD_FEED_ID, "hex")),
      price_source: { Pool: { pool, base_vault: k(), quote_vault: k() } },
      token_ema_price_sol: new BN("340282366920938463463374607431768211455"), token_ema_prev_price_sol: new BN(0),
      token_slow_ema_price_sol: new BN(3), token_slow_ema_prev_price_sol: new BN(0), token_spot_price_sol: new BN(1),
      ema_updated_at: new BN(10), ema_updated_slot: new BN(11), max_price_age_secs: new BN(60), paused: false,
      buyback_cap_lamports_per_hour: new BN(1), buyback_max_slippage_bps: 1500, buyback_allowance_updated_at: new BN(0),
      buyback_allowance: new BN(0), buyback_outstanding_lamports: new BN(0), buyback_written_off_lamports: new BN(9), bump: 1,
      canvas_bump: 2, buyback_vault_bump: 3, ema_warmup_cranks: 7, ema_warmup_started_at: new BN(5), paused_at: new BN(0), token_blocks_cap_per_hour: 1000, token_blocks_allowance: 999,
      token_blocks_allowance_updated_at: new BN(7), _reserved: Array(32).fill(0),
    });
    const cfg = decodeConfig(cfgData);
    expect(cfg.priceSource.kind).toBe("pool");
    expect(cfg.priceSource.kind === "pool" && cfg.priceSource.pool.equals(pool)).toBe(true);
    expect(cfg.tokenEmaPriceSol).toBe((1n << 128n) - 1n);
    expect(cfg.pythFeedId).toBe(SOL_USD_FEED_ID);
    expect(cfg.buybackWrittenOffLamports).toBe(9n);
    expect(cfg.emaWarmupCranks).toBe(7);
    expect(cfg.tokenSlowEmaPriceSol).toBe(3n);
    expect(cfg.tokenBlocksAllowance).toBe(999);
  });

  it("parses events from logs and ignores other programs", () => {
    const ev = IDL.events!.find((e) => e.name === "AdPurchased")!;
    const owner = Keypair.generate().publicKey;
    const body = coder.types.encode("AdPurchased", {
      ad_id: 9, ad: adPda(1, 2), owner, x: 1, y: 2, w: 3, h: 4, pay_mode: { Token: {} }, lamports: new BN(0),
      tokens_burned: new BN("85840000000003"), usd_micro: new BN(360_000_000), ts: new BN(1_800_000_000),
    });
    const b64 = Buffer.concat([Buffer.from(ev.discriminator), body]).toString("base64");
    const other = Keypair.generate().publicKey.toBase58();
    const logs = [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      `Program log: Instruction: BuyWithToken`,
      `Program data: ${b64}`,
      `Program ${PROGRAM_ID.toBase58()} consumed 1000 of 200000 compute units`,
      `Program ${PROGRAM_ID.toBase58()} success`,
      `Program ${other} invoke [1]`,
      `Program data: ${b64}`,
      `Program ${other} success`,
    ];
    const out = parseEvents(logs);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("AdPurchased");
    if (out[0]!.name === "AdPurchased") {
      expect(out[0]!.data.adId).toBe(9);
      expect(out[0]!.data.ad.equals(adPda(1, 2))).toBe(true);
      expect(out[0]!.data.payMode).toBe("token");
      expect(out[0]!.data.tokensBurned).toBe(85_840_000_000_003n);
      expect(out[0]!.data.owner.equals(owner)).toBe(true);
    }
    expect(decodeEventData(b64)?.name).toBe("AdPurchased");
  });
});
