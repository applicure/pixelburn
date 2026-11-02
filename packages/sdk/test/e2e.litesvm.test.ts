/**
 * SDK <-> program contract test: SDK-built instructions executed against the real compiled program in LiteSVM.
 * Skipped when chain/target/deploy/pixel.so is absent (run `anchor build` in /chain first).
 */
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  adPda,
  buildBuyTx,
  COMPUTE_BUDGET_PROGRAM_ID,
  applyTokenDiscount,
  buybackVaultPda,
  buyWithSolIx,
  buyWithTokenIx,
  canvasPda,
  coder,
  configPda,
  crankTokenPriceIx,
  decodeAd,
  decodeCanvas,
  decodeConfig,
  initializeIx,
  parseEvents,
  PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  quoteLamports,
  quoteTokensExact,
  quoteUsd,
  SOL_USD_FEED_ID,
  spotPriceQ,
  tokenPricingStatus,
  splitSol,
  TOKEN_PROGRAM_ID,
  transferAdIx,
  updateAdIx,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SO = resolve(here, "../../../chain/target/deploy/pixel.so");
const T0 = 1_800_000_000n;
const SOL = { price: 15_000_000_000n, expo: -8 };
const VSOL = 30_000_000_000n;
const VTOK = 1_073_000_000_000_000n;

const accDisc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

function packMint(supply: bigint): Uint8Array {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(supply, 36);
  d[44] = 6;
  d[45] = 1;
  return d;
}
function packTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return d;
}
function packCurve(vsol: bigint, vtok: bigint): Uint8Array {
  const d = Buffer.alloc(151);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(d, 0);
  d.writeBigUInt64LE(vtok, 8);
  d.writeBigUInt64LE(vsol, 16);
  return d;
}

class Env {
  svm = new LiteSVM();
  admin = Keypair.generate();
  treasury = Keypair.generate().publicKey;
  mint = Keypair.generate().publicKey;
  curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), this.mint.toBuffer()], PUMP_PROGRAM_ID)[0];
  priceUpdate = Keypair.generate().publicKey;

  constructor() {
    this.svm.addProgram(PROGRAM_ID, readFileSync(SO));
    this.svm.airdrop(this.admin.publicKey, 100_000_000_000n);
    this.svm.airdrop(this.treasury, 1_000_000_000n);
    const pd = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
    const acc = this.svm.getAccount(pd)!;
    const data = Uint8Array.from(acc.data);
    data[12] = 1;
    data.set(this.admin.publicKey.toBytes(), 13);
    this.svm.setAccount(pd, { ...acc, data });
    this.setTime(T0, 1_000n);
    this.raw(this.mint, packMint(1_000_000_000_000_000n), TOKEN_PROGRAM_ID);
    this.raw(this.curve, packCurve(VSOL, VTOK), PUMP_PROGRAM_ID);
    this.setPrice(T0);
  }
  raw(addr: PublicKey, data: Uint8Array, owner: PublicKey) {
    this.svm.setAccount(addr, { lamports: 10_000_000, data, owner, executable: false });
  }
  setTime(ts: bigint, slot: bigint) {
    const c = this.svm.getClock();
    c.unixTimestamp = ts;
    c.slot = slot;
    this.svm.setClock(c);
  }
  warp(secs: number) {
    const c = this.svm.getClock();
    this.setTime(c.unixTimestamp + BigInt(secs), c.slot + BigInt(secs * 3));
    this.setPrice(c.unixTimestamp + BigInt(secs));
  }
  setPrice(publishTime: bigint) {
    const body = coder.types.encode("PriceUpdateV2", {
      write_authority: PublicKey.default,
      verification_level: { Full: {} },
      price_message: {
        feed_id: Array.from(Buffer.from(SOL_USD_FEED_ID, "hex")),
        price: new BN(SOL.price.toString()),
        conf: new BN(1_000_000),
        exponent: SOL.expo,
        publish_time: new BN(publishTime.toString()),
        prev_publish_time: new BN((publishTime - 1n).toString()),
        ema_price: new BN(SOL.price.toString()),
        ema_conf: new BN(1_000_000),
      },
      posted_slot: new BN(1),
    });
    this.raw(this.priceUpdate, Buffer.concat([accDisc("PriceUpdateV2"), body]), PYTH_RECEIVER_PROGRAM_ID);
  }
  send(ixs: TransactionInstruction[], signers: Keypair[]): TransactionMetadata {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0]!.publicKey;
    tx.sign(...signers);
    const r = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    if (r instanceof FailedTransactionMetadata) throw new Error(`tx failed: ${r.err().toString()}\n${r.meta().logs().join("\n")}`);
    return r;
  }
  data(k: PublicKey): Uint8Array {
    return Uint8Array.from(this.svm.getAccount(k)!.data);
  }
  /** Minimal Connection backed by LiteSVM state (only the methods the SDK's builders use). */
  connection(fees: number[] = []): Connection {
    const svm = this.svm;
    const get = (k: PublicKey) => {
      const a = svm.getAccount(k);
      return a ? { ...a, data: Buffer.from(a.data) } : null;
    };
    return {
      getAccountInfo: async (k: PublicKey) => get(k),
      getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(get),
      getRecentPrioritizationFees: async () => fees.map((f, i) => ({ slot: i, prioritizationFee: f })),
      getLatestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000 }),
    } as unknown as Connection;
  }
  sendTx(tx: Transaction, signers: Keypair[]): TransactionMetadata {
    tx.sign(...signers);
    const r = this.svm.sendTransaction(tx);
    if (r instanceof FailedTransactionMetadata) throw new Error(`tx failed: ${r.err().toString()}\n${r.meta().logs().join("\n")}`);
    return r;
  }
  init(priceSource: { kind: "bondingCurve"; curve: PublicKey }) {
    this.send(
      [
        initializeIx({
          admin: this.admin.publicKey,
          tokenMint: this.mint,
          treasury: this.treasury,
          keeper: this.admin.publicKey,
          pythFeedIdHex: SOL_USD_FEED_ID,
          priceSource,
          buybackCapLamportsPerHour: 5_000_000_000n,
          buybackMaxSlippageBps: 1500,
          initialTokenEmaPriceSol: spotPriceQ(VSOL, VTOK),
        }),
      ],
      [this.admin],
    );
  }
}

describe.skipIf(!existsSync(SO))("SDK instructions against the compiled program (LiteSVM)", () => {
  it("initialize, crank, buy with SOL and token, update + transfer, events", () => {
    const env = new Env();
    const admin = env.admin;
    const priceSource = { kind: "bondingCurve" as const, curve: env.curve };
    env.send(
      [
        initializeIx({
          admin: admin.publicKey,
          tokenMint: env.mint,
          treasury: env.treasury,
          keeper: admin.publicKey,
          pythFeedIdHex: SOL_USD_FEED_ID,
          priceSource,
          buybackCapLamportsPerHour: 5_000_000_000n,
          buybackMaxSlippageBps: 1500,
          initialTokenEmaPriceSol: spotPriceQ(VSOL, VTOK),
        }),
      ],
      [admin],
    );
    const cfg = decodeConfig(env.data(configPda()));
    expect(cfg.admin.equals(admin.publicKey)).toBe(true);
    expect(cfg.priceSource.kind).toBe("bondingCurve");
    expect(cfg.tokenDecimals).toBe(6);

    // EMA was seeded by the admin; token pricing needs a warm-up of 10 cranks spanning >= 600 s
    env.warp(30);
    const crank = env.send([crankTokenPriceIx({ priceSource })], [admin]);
    expect(parseEvents(crank.logs()).map((e) => e.name)).toEqual(["TokenPriceUpdated"]);
    expect(tokenPricingStatus(decodeConfig(env.data(configPda())), spotPriceQ(VSOL, VTOK), Number(env.svm.getClock().unixTimestamp))).toMatchObject({ ok: false, reason: "warmingUp" });
    for (let i = 0; i < 9; i++) {
      env.warp(67);
      env.send([crankTokenPriceIx({ priceSource })], [admin]);
    }
    expect(tokenPricingStatus(decodeConfig(env.data(configPda())), spotPriceQ(VSOL, VTOK), Number(env.svm.getClock().unixTimestamp))).toMatchObject({ ok: true, pricedBy: "spot", blocksAvailable: 1_000 });
    env.warp(2);

    // ---- SOL buy, exact max (SDK quote must equal on-chain charge)
    const buyer = Keypair.generate();
    env.svm.airdrop(buyer.publicKey, 100_000_000_000n);
    const content = { title: "SDK", link: "https://sdk.io", imageUri: "ar://img", imageSha256: "ab".repeat(32) };
    const usd = quoteUsd(2, 2);
    const lamports = quoteLamports(usd, SOL);
    const t0 = env.svm.getBalance(env.treasury)!;
    const v0 = env.svm.getBalance(buybackVaultPda())!;
    const m1 = env.send(
      [buyWithSolIx({ buyer: buyer.publicKey, rect: { x: 0, y: 0, w: 2, h: 2 }, content, priceUpdate: env.priceUpdate, treasury: env.treasury, maxLamports: lamports })],
      [buyer],
    );
    const split = splitSol(lamports);
    expect(env.svm.getBalance(env.treasury)! - t0).toBe(split.treasury);
    expect(env.svm.getBalance(buybackVaultPda())! - v0).toBe(split.buyback);
    const ev1 = parseEvents(m1.logs());
    expect(ev1).toHaveLength(1);
    expect(ev1[0]!.name === "AdPurchased" && ev1[0]!.data.lamports).toBe(lamports);
    const ad0 = decodeAd(env.data(adPda(0, 0)));
    expect([ad0.x, ad0.y, ad0.w, ad0.h, ad0.payMode, ad0.imageSha256]).toEqual([0, 0, 2, 2, "sol", "ab".repeat(32)]);

    // ---- token buy, exact max
    const ta = Keypair.generate().publicKey;
    env.raw(ta, packTokenAccount(env.mint, buyer.publicKey, 500_000_000_000_000n), TOKEN_PROGRAM_ID);
    const q = spotPriceQ(VSOL, VTOK);
    const tokens = quoteTokensExact(quoteUsd(1, 3), SOL, q, q);
    const tooTight = () =>
      env.send(
        [buyWithTokenIx({ buyer: buyer.publicKey, buyerTokenAccount: ta, rect: { x: 97, y: 97, w: 3, h: 1 }, content, priceUpdate: env.priceUpdate, tokenMint: env.mint, priceSource, maxTokens: tokens - 1n })],
        [buyer],
      );
    expect(tooTight).toThrow(/Custom\(6008\)|6008/);
    const m2 = env.send(
      [buyWithTokenIx({ buyer: buyer.publicKey, buyerTokenAccount: ta, rect: { x: 97, y: 97, w: 3, h: 1 }, content, priceUpdate: env.priceUpdate, tokenMint: env.mint, priceSource, maxTokens: tokens })],
      [buyer],
    );
    const ev2 = parseEvents(m2.logs())[0]!;
    expect(ev2.name).toBe("AdPurchased");
    if (ev2.name === "AdPurchased") {
      expect(ev2.data.tokensBurned).toBe(tokens);
      expect(ev2.data.usdMicro).toBe(applyTokenDiscount(quoteUsd(1, 3)));
    }
    const canvas = decodeCanvas(env.data(canvasPda()));
    expect(canvas.soldBlocks).toBe(7);
    expect(canvas.nextAdId).toBe(2);
    expect(canvas.tokensBurnedDirect).toBe(tokens);
    expect(canvas.lamportsToTreasury + canvas.lamportsToBuyback).toBe(canvas.lamportsRaised);

    // ---- update + transfer
    const newOwner = Keypair.generate().publicKey;
    const m3 = env.send(
      [
        updateAdIx({ owner: buyer.publicKey, ad: adPda(0, 0), content: { ...content, link: "https://new.io" } }),
        transferAdIx({ owner: buyer.publicKey, ad: adPda(0, 0), newOwner }),
      ],
      [buyer],
    );
    expect(parseEvents(m3.logs()).map((e) => e.name)).toEqual(["AdUpdated", "AdTransferred"]);
    const ad0b = decodeAd(env.data(adPda(0, 0)));
    expect(ad0b.link).toBe("https://new.io");
    expect(ad0b.owner.equals(newOwner)).toBe(true);
  });

  it("buildBuyTx: two buyers build against the same state, both land; CU limit + capped priority fee", async () => {
    const env = new Env();
    env.init({ kind: "bondingCurve", curve: env.curve });
    // Recent fees incl. an outlier above the cap: 75th percentile of non-zero values, then clamped to max.
    const conn = env.connection([0, 2_000, 4_000, 9_000_000]);
    // The SDK's real-clock age check isn't involved for SOL; the program checks the LiteSVM clock.
    const content = { title: "A", link: "https://a.io", imageUri: "ar://a", imageSha256: new Uint8Array(32) };
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    env.svm.airdrop(alice.publicKey, 100_000_000_000n);
    env.svm.airdrop(bob.publicKey, 100_000_000_000n);
    const [ta, tb] = await Promise.all([
      buildBuyTx(conn, { mode: "sol", buyer: alice.publicKey, rect: { x: 10, y: 10, w: 4, h: 4 }, content, priceUpdate: env.priceUpdate, maxMicroLamports: 50_000 }),
      buildBuyTx(conn, { mode: "sol", buyer: bob.publicKey, rect: { x: 14, y: 10, w: 2, h: 1 }, content, priceUpdate: env.priceUpdate, maxMicroLamports: 50_000 }),
    ]);
    expect(ta.microLamportsPerCu).toBe(50_000); // 9_000_000 outlier capped
    expect(ta.computeUnitLimit).toBe(50_000 + 1_200 * 4);
    const cb = ta.transaction.instructions.filter((i) => i.programId.equals(COMPUTE_BUDGET_PROGRAM_ID));
    expect(cb.map((i) => i.data[0])).toEqual([2, 3]);
    expect(ta.maxPriorityFeeLamports).toBe(BigInt(Math.ceil((54_800 * 50_000) / 1e6)));
    const ma = env.sendTx(ta.transaction, [alice]);
    const mb = env.sendTx(tb.transaction, [bob]);
    expect(BigInt(ma.computeUnitsConsumed())).toBeLessThan(BigInt(ta.computeUnitLimit));
    const ea = parseEvents(ma.logs())[0]!;
    const eb = parseEvents(mb.logs())[0]!;
    expect(ea.name === "AdPurchased" && ea.data.ad.equals(ta.quote.ad)).toBe(true);
    expect(eb.name === "AdPurchased" && eb.data.ad.equals(adPda(14, 10))).toBe(true);
    expect(decodeAd(env.data(adPda(14, 10))).owner.equals(bob.publicKey)).toBe(true);
    expect(decodeCanvas(env.data(canvasPda())).soldBlocks).toBe(18);
    // no fees available => floor
    const t3 = await buildBuyTx(env.connection([]), { mode: "sol", buyer: bob.publicKey, rect: { x: 0, y: 0, w: 1, h: 1 }, content, priceUpdate: env.priceUpdate });
    expect(t3.microLamportsPerCu).toBe(1_000);
  });
});
