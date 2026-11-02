/**
 * Devnet only: buy the pixel token (PXTEST) on its canonical PumpSwap pool with a test wallet (e.g. for the web
 * wallet test's $PIXEL leg). DRY RUN by default: prints quote, estimated price impact and what it does to
 * token-payment pricing, then simulates. Sends only with --execute.
 *
 *   BUY_SOL=0.05 BUYER_KEYPAIR=../keys/buyer.json node pumpswap-buy-devnet.ts            # dry run
 *   BUY_SOL=0.05 BUYER_KEYPAIR=../keys/buyer.json node pumpswap-buy-devnet.ts --execute  # send
 *
 * Genesis-hash guarded (devnet-rpc.ts); never prints keys or RPC URLs. Pool/mint come from the on-chain pixel config.
 */
import { ComputeBudgetProgram, Keypair, Transaction } from "@solana/web3.js";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { associatedTokenAddress, fetchConfig, parsePumpPool, poolSpotPriceQ, tokenPricingStatus } from "@mpb/sdk";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { devnetConnection, redact } from "./devnet-rpc.ts";

const EXECUTE = process.argv.includes("--execute");
try {
  const { connection: c, label } = await devnetConnection();
  const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(process.env.BUYER_KEYPAIR ?? "../keys/buyer.json"), "utf8"))));
  const lamports = BigInt(Math.round(Number(process.env.BUY_SOL ?? "0.05") * 1e9));
  const cfg = await fetchConfig(c);
  if (cfg.priceSource.kind !== "pool") throw new Error("pixel config is not on a PumpSwap pool (still on the curve?)");
  const { pool, baseVault, quoteVault } = cfg.priceSource;
  const [p, b, q] = await c.getMultipleAccountsInfo([pool, baseVault, quoteVault]);
  const pp = parsePumpPool(p!.data);
  const effQuote = q!.data.readBigUInt64LE(64) + pp.virtualQuoteReserves;
  const spot = poolSpotPriceQ(p!.data, b!.data, q!.data);
  // constant product: post-trade spot ≈ spot * (1 + dq/Q)^2 (ignoring fees)
  const f = 1 + Number(lamports) / Number(effQuote);
  const spotAfter = BigInt(Math.round(Number(spot) * f * f));
  const now = Math.floor(Date.now() / 1000);
  const before = tokenPricingStatus(cfg, spot, now, 1), after = tokenPricingStatus(cfg, spotAfter, now, 1);
  console.log(`rpc        ${label}`);
  console.log(`buyer      ${buyer.publicKey.toBase58()}  balance ${(await c.getBalance(buyer.publicKey)) / 1e9} SOL`);
  console.log(`pool       ${pool.toBase58()} (effective quote ${Number(effQuote) / 1e9} SOL)`);
  console.log(`buy        ${Number(lamports) / 1e9} SOL -> est. price impact +${((f * f - 1) * 100).toFixed(1)}%`);
  console.log(`spot/ema   now ${(Number(spot) / Number(cfg.tokenEmaPriceSol)).toFixed(3)} -> after ~${(Number(spotAfter) / Number(cfg.tokenEmaPriceSol)).toFixed(3)} (token payments pause above 1.150)`);
  console.log(`token pay  now ${before.ok ? "ok" : before.reason} -> after ~${after.ok ? "ok" : after.reason}`);
  const state = await new OnlinePumpAmmSdk(c).swapSolanaState(pool, buyer.publicKey);
  const ixs = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(lamports.toString()), 1);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs);
  tx.feePayer = buyer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(buyer);
  if (!EXECUTE) {
    const sim = await c.simulateTransaction(tx);
    console.log(`[dry run] simulate ${sim.value.err ? `ERR ${JSON.stringify(sim.value.err)}` : "OK"} (CU ${sim.value.unitsConsumed}); pass --execute to send`);
  } else {
    const ata = associatedTokenAddress(buyer.publicKey, cfg.tokenMint, cfg.tokenProgram);
    const t0 = BigInt((await c.getTokenAccountBalance(ata).catch(() => ({ value: { amount: "0" } }))).value.amount);
    const sig = await c.sendRawTransaction(tx.serialize());
    await c.confirmTransaction(sig, "confirmed");
    const t1 = BigInt((await c.getTokenAccountBalance(ata)).value.amount);
    console.log(`sent       https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    console.log(`received   ${t1 - t0} base units (${Number(t1 - t0) / 10 ** cfg.tokenDecimals} PXTEST) into ${ata.toBase58()}`);
  }
} catch (e) {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
