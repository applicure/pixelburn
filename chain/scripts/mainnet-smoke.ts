/**
 * Launch-day smoke tests: separate, explicit, each one optional, all from the launch wallet. They take a real block and spend real SOL.
 *
 *   node mainnet-smoke.ts status
 *   node mainnet-smoke.ts sol --x <0-99> --y <0-99> --image-uri <uri> --image-sha256 <hex> [--title t] [--link url]   one 1x1 paid in SOL (about $100)
 *   node mainnet-smoke.ts buy-tokens --sol <amount>                                                                   market-buys $PXL for the launch wallet
 *   node mainnet-smoke.ts token --x <0-99> --y <0-99> --image-uri <uri> --image-sha256 <hex> [--title t] [--link url] one 1x1 paid in $PXL; needs buy-tokens first
 *   add --execute --mainnet-i-understand to send; the dry run builds and simulates.
 *
 * Upload the image first (POST /api/uploads w=1 h=1): that returns --image-uri and --image-sha256.
 * buy-tokens moves the price: about +6.7% for 1 SOL on a fresh curve. Token payments pause above the fast EMA x 1.15, so size it small.
 */
import { type TransactionInstruction } from "@solana/web3.js";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { associatedTokenAddress, buildBuyTx, fetchCanvas, fetchConfig, readSpotPriceQ, tokenPricingStatus } from "@mpb/sdk";
import BN from "bn.js";
import { buildTx, connect, die, explorer, loadKey, main, parseArgs, programId, roles, runMode, sendAndConfirm, simulate, solToLamports, stringifyBig, strArg, toVersioned } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const cmd = process.argv[2] ?? "status";
  const { connection: c, label } = await connect(mode);
  const pid = programId(mode);
  const r = roles(mode);
  console.log(`cluster   ${label}\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN"}\nwallet    ${r.launch.toBase58()} (launch)`);
  const cfg = await fetchConfig(c, pid).catch(() => null);
  if (!cfg) { console.log("config not initialized yet: nothing to test"); return; }
  const mint = cfg.tokenMint;
  const ata = associatedTokenAddress(r.launch, mint, cfg.tokenProgram);
  const tokens = BigInt((await c.getTokenAccountBalance(ata).catch(() => ({ value: { amount: "0" } }))).value.amount);
  const spot = await readSpotPriceQ(c, cfg.priceSource).catch(() => null);
  const status = spot ? tokenPricingStatus(cfg, spot, Math.floor(Date.now() / 1000), 1) : null;

  if (cmd === "status") {
    console.log(stringifyBig({ sold: (await fetchCanvas(c, pid)).soldBlocks, source: cfg.priceSource.kind, warmupCranks: cfg.emaWarmupCranks, ema: cfg.tokenEmaPriceSol, spot, tokenPricing: status, launchWalletTokens: tokens }));
    return;
  }

  if (cmd === "buy-tokens") {
    const v = strArg(args, "sol");
    if (!v) die("--sol <amount> is required");
    const lamports = solToLamports(v);
    let ixs: TransactionInstruction[];
    if (cfg.priceSource.kind === "pool") {
      const state = await new OnlinePumpAmmSdk(c).swapSolanaState(cfg.priceSource.pool, r.launch);
      ixs = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(lamports.toString()), 3);
    } else {
      const online = new OnlinePumpSdk(c);
      const [global, feeConfig, state] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null), online.fetchBuyState(mint, r.launch, cfg.tokenProgram)]);
      const mintSupply = new BN((await c.getTokenSupply(mint)).value.amount); // the live supply: null over-quotes after burns (devnet, 6021)
      const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve: state.bondingCurve, amount: new BN(lamports.toString()), quoteMint: state.quoteMint });
      ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve, associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: r.launch, amount, solAmount: new BN(lamports.toString()), slippage: 3, tokenProgram: cfg.tokenProgram });
    }
    const { tx, lastValidBlockHeight } = await buildTx(c, r.launch, ixs, { units: 300_000 });
    const sim = await simulate(c, tx);
    console.log(`buy       ${v} SOL of ${mint.toBase58()}\nsimulate  ${sim.ok ? `ok, ${sim.units} CU` : `ERR ${JSON.stringify(sim.err)}`}`);
    if (!sim.ok) { console.log(sim.logs.slice(-5).join("\n")); throw new Error("simulation failed"); }
    if (!mode.execute) { console.log("DRY RUN: nothing sent"); return; }
    const sig = await sendAndConfirm(c, tx, lastValidBlockHeight, [loadKey(mode, "launch")]);
    console.log(`bought ${explorer(mode, "tx", sig)}\nlaunch wallet now holds ${(await c.getTokenAccountBalance(ata)).value.amount} base units`);
    return;
  }

  if (cmd !== "sol" && cmd !== "token") die(`unknown command ${cmd}`);
  const [xs, ys, imageUri, imageSha256] = [strArg(args, "x"), strArg(args, "y"), strArg(args, "image-uri"), strArg(args, "image-sha256")];
  if (!xs || !ys || !imageUri || !imageSha256) die("--x --y --image-uri --image-sha256 are required: this takes a real block on the real canvas");
  if (cmd === "token") {
    console.log(`tokens    launch wallet holds ${tokens} base units; pricing ${JSON.stringify(status, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (tokens === 0n) die("the launch wallet holds no tokens. Run buy-tokens first, or skip this test");
  }
  const built = await buildBuyTx(c, {
    mode: cmd, buyer: r.launch, rect: { x: Number(xs), y: Number(ys), w: 1, h: 1 }, programId: pid, buyerTokenAccount: cmd === "token" ? ata : undefined,
    content: { title: strArg(args, "title") ?? "Pixel Frame", link: strArg(args, "link") ?? "https://pixelframe.tech", imageUri, imageSha256 },
  });
  console.log(`quote     ${stringifyBig(built.quote).replace(/\s+/g, " ")}`);
  const vtx = toVersioned(built.transaction);
  const sim = await c.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
  console.log(`simulate  ${sim.value.err ? `ERR ${JSON.stringify(sim.value.err)}` : `ok, ${sim.value.unitsConsumed} CU`}`);
  if (sim.value.err) { console.log((sim.value.logs ?? []).slice(-5).join("\n")); throw new Error("simulation failed"); }
  if (!mode.execute) { console.log("DRY RUN: nothing sent"); return; }
  const sig = await sendAndConfirm(c, vtx, built.lastValidBlockHeight, [loadKey(mode, "launch")]);
  console.log(`bought ${explorer(mode, "tx", sig)}`);
});
