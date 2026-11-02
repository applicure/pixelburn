/**
 * Devnet verification steps for the pixel program (devnet only; refuses mainnet). Appends every tx to ../devnet-log.json.
 *   node devnet-verify.ts crank [n] [spacingSecs]   keeper cranks (warm-up: 10 x 65 s)
 *   node devnet-verify.ts status                    config / pricing status summary
 *   node devnet-verify.ts sol-buy x y               buyer buys a 1x1 with SOL (buildBuyTx)
 *   node devnet-verify.ts token-buy x y             admin buys a 1x1 with the pump coin
 *   node devnet-verify.ts buyback lamports          keeper: release -> pump buy -> record_buyback_burn
 *   node devnet-verify.ts pause | unpause           admin
 * Env: DEVNET_RPC_URL or SOLANA_RPC_HELIUS_KEY optional (never printed). SOLANA_RPC is ignored (mainnet in root .env).
 * Genesis-hash guard: exits unless the RPC is devnet.
 */
import { Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { devnetConnection } from "./devnet-rpc.ts";
import {
  PROGRAM_ID, associatedTokenAddress, buildBuyTx, configPda, crankTokenPriceIx, fetchConfig, fetchCanvas, readSpotPriceQ,
  tokenPricingStatus, releaseBuybackIx, recordBuybackBurnIx, setPausedIx, parseEvents, buybackVaultPda, auctionPda, canvasPda,
} from "@mpb/sdk";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const keys = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(here, `../keys/${n}.json`), "utf8"))));
const logPath = resolve(here, "../devnet-log.json");
const { connection: c } = await devnetConnection(); // genesis-hash guard: exits unless devnet
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(step: string, sig: string, extra: Record<string, unknown> = {}) {
  const arr = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];
  arr.push({ step, sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`, at: new Date().toISOString(), ...extra });
  writeFileSync(logPath, JSON.stringify(arr, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`${step}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

/** send with self-rebroadcast until confirmed or blockhash expiry (services saw maxRetries drops) */
async function send(tx: Transaction, signers: Keypair[]): Promise<string> {
  const bh = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const raw = tx.serialize();
  const sig = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
  for (;;) {
    const st = await c.getSignatureStatus(sig);
    if (st.value?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.value.err)}`);
    if (st.value?.confirmationStatus === "confirmed" || st.value?.confirmationStatus === "finalized") return sig;
    if ((await c.getBlockHeight()) > bh.lastValidBlockHeight) throw new Error(`tx ${sig} expired`);
    await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(2_000);
  }
}

async function events(sig: string) {
  const t = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  return parseEvents(t?.meta?.logMessages ?? []);
}

const [cmd, a1, a2] = process.argv.slice(2);
const cfg = await fetchConfig(c);
const mint = cfg.tokenMint;

switch (cmd) {
  case "status": {
    const spot = await readSpotPriceQ(c, cfg.priceSource);
    const now = Math.floor(Date.now() / 1000);
    const canvas = await fetchCanvas(c);
    console.log(JSON.stringify({ paused: cfg.paused, warmup: cfg.emaWarmupCranks, ema: cfg.tokenEmaPriceSol, slow: cfg.tokenSlowEmaPriceSol, spot,
      status: tokenPricingStatus(cfg, spot, now, 1), sold: canvas.soldBlocks, vault: await c.getBalance(buybackVaultPda()) }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    break;
  }
  case "crank": {
    const n = Number(a1 ?? 10), gap = Number(a2 ?? 65);
    const keeper = keys("keeper");
    for (let i = 0; i < n; i++) {
      // devnet's on-chain clock can lag wall time by tens of seconds: retry CrankTooSoon (6015) instead of failing
      let sig = "";
      for (let attempt = 0; ; attempt++) {
        try {
          sig = await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }), crankTokenPriceIx({ priceSource: cfg.priceSource })), [keeper]);
          break;
        } catch (e) {
          if (attempt < 12 && String((e as Error).message).includes("0x177f")) { await sleep(10_000); continue; }
          throw e;
        }
      }
      log(`crank ${i + 1}/${n}`, sig);
      if (i < n - 1) await sleep(gap * 1000);
    }
    break;
  }
  case "sol-buy":
  case "token-buy": {
    const who = cmd === "sol-buy" ? keys("buyer") : keys("admin");
    const content = { title: cmd === "sol-buy" ? "Devnet SOL test" : "Devnet token test", link: "https://example.com", imageUri: "ar://devnet-test", imageSha256: new Uint8Array(32) };
    const rect = { x: Number(a1 ?? 0), y: Number(a2 ?? 0), w: 1, h: 1 };
    const supply0 = (await c.getTokenSupply(mint)).value.amount;
    const built = await buildBuyTx(c, {
      mode: cmd === "sol-buy" ? "sol" : "token", buyer: who.publicKey, rect, content,
      buyerTokenAccount: cmd === "token-buy" ? associatedTokenAddress(who.publicKey, mint, cfg.tokenProgram) : undefined,
    });
    const sig = await send(built.transaction, [who]);
    const ev = await events(sig);
    const supply1 = (await c.getTokenSupply(mint)).value.amount;
    log(cmd, sig, { quote: built.quote, cuLimit: built.computeUnitLimit, microLamports: built.microLamportsPerCu, events: ev.map((e) => e.name), supplyBefore: supply0, supplyAfter: supply1 });
    console.log("events", JSON.stringify(ev, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v)));
    console.log(`supply ${supply0} -> ${supply1} (burned ${BigInt(supply0) - BigInt(supply1)})`);
    break;
  }
  case "buyback": {
    const keeper = keys("keeper");
    // release -> pump curve buy -> record_buyback_burn. If a release is already outstanding (the program blocks a new
    // release until it is recorded), reuse it instead of releasing again.
    let lamports = BigInt(a1 ?? "20000000");
    if (cfg.buybackOutstandingLamports > 0n) {
      lamports = cfg.buybackOutstandingLamports;
      console.log(`release already outstanding (${lamports} lamports): completing it`);
    } else {
      const s1 = await send(new Transaction().add(releaseBuybackIx({ keeper: keeper.publicKey, lamports })), [keeper]);
      log("release_buyback", s1, { lamports });
    }
    const ata = associatedTokenAddress(keeper.publicKey, mint, cfg.tokenProgram);
    if (cfg.priceSource.kind === "pool") {
      // Graduated: buy on the canonical PumpSwap pool. buyQuoteInput wraps `quote` lamports into WSOL, swaps, and
      // closes the WSOL account again; lamports_spent = the keeper's measured SOL decrease minus the tx fee.
      const spendQ = new BN(((lamports * 95n) / 100n).toString());
      const state = await new OnlinePumpAmmSdk(c).swapSolanaState(cfg.priceSource.pool, keeper.publicKey);
      const ixs = await PUMP_AMM_SDK.buyQuoteInput(state, spendQ, 1);
      const sol0 = BigInt(await c.getBalance(keeper.publicKey));
      const tok0 = BigInt((await c.getTokenAccountBalance(ata).catch(() => ({ value: { amount: "0" } }))).value.amount);
      const sb = await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs), [keeper]);
      const fee = BigInt((await c.getTransaction(sb, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))?.meta?.fee ?? 0);
      // The keeper's SOL drop also includes one-time account rent (e.g. PumpSwap's user volume accumulator, ~2.9M
      // lamports on the first buy), which is not buyback spend: claim the quote actually swapped, capped at the release.
      const measured = sol0 - BigInt(await c.getBalance(keeper.publicKey)) - fee;
      const quoteIn = BigInt(spendQ.toString());
      const spent = measured < quoteIn ? measured : quoteIn;
      const bought = BigInt((await c.getTokenAccountBalance(ata)).value.amount) - tok0;
      log("pumpswap buy (keeper, canonical pool)", sb, { quoteIn: spendQ.toString(), measuredSolDrop: measured, lamportsSpent: spent, tokensBought: bought });
      const supply0 = (await c.getTokenSupply(mint)).value.amount;
      const s3 = await send(new Transaction().add(recordBuybackBurnIx({ keeper: keeper.publicKey, tokenMint: mint, tokenProgram: cfg.tokenProgram, priceSource: cfg.priceSource,
        keeperTokenAccount: ata, lamportsSpent: spent, tokensBurned: bought })), [keeper]);
      const supply1 = (await c.getTokenSupply(mint)).value.amount;
      log("record_buyback_burn", s3, { lamportsSpent: spent, tokensBurned: bought, supplyBefore: supply0, supplyAfter: supply1, events: (await events(s3)).map((e) => e.name) });
      break;
    }
    // buy on the pump curve with (most of) the released SOL; keep a margin for fees/ATA rent
    const online = new OnlinePumpSdk(c);
    const [global, feeConfig, state] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null), online.fetchBuyState(mint, keeper.publicKey, cfg.tokenProgram)]);
    const spend = new BN(((lamports * 95n) / 100n).toString());
    // mintSupply must be the live supply: with null the SDK assumes the initial 1B and over-quotes (NotEnoughTokensToBuy
    // 6021 on devnet after our burns). Seen in the first launch run.
    const mintSupply = new BN((await c.getTokenSupply(mint)).value.amount);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve: state.bondingCurve, amount: spend, quoteMint: state.quoteMint });
    const before = BigInt((await c.getTokenAccountBalance(ata).catch(() => ({ value: { amount: "0" } }))).value.amount);
    const buyIxs: TransactionInstruction[] = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: keeper.publicKey, amount, solAmount: spend, slippage: 1, tokenProgram: cfg.tokenProgram });
    const s2 = await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...buyIxs), [keeper]);
    const after = BigInt((await c.getTokenAccountBalance(ata)).value.amount);
    const bought = after - before;
    log("pump buy (keeper)", s2, { spentMax: spend.toString(), tokensBought: bought });
    const supply0 = (await c.getTokenSupply(mint)).value.amount;
    const s3 = await send(new Transaction().add(recordBuybackBurnIx({ keeper: keeper.publicKey, tokenMint: mint, tokenProgram: cfg.tokenProgram, priceSource: cfg.priceSource,
      keeperTokenAccount: ata, lamportsSpent: BigInt(spend.toString()), tokensBurned: bought })), [keeper]);
    const supply1 = (await c.getTokenSupply(mint)).value.amount;
    log("record_buyback_burn", s3, { lamportsSpent: spend.toString(), tokensBurned: bought, supplyBefore: supply0, supplyAfter: supply1, events: (await events(s3)).map((e) => e.name) });
    break;
  }
  case "pause":
  case "unpause": {
    const admin = keys("admin");
    const sig = await send(new Transaction().add(setPausedIx({ admin: admin.publicKey, paused: cmd === "pause" })), [admin]);
    log(cmd, sig, { paused: (await fetchConfig(c)).paused });
    break;
  }
  default:
    console.log("usage: crank|status|sol-buy|token-buy|buyback|pause|unpause");
}
void PROGRAM_ID; void configPda; void auctionPda; void canvasPda;
