/**
 * Devnet/localnet helpers for rehearsing the launch: everything the owner's pump.fun launch and the market would do. Never runs on mainnet: it requires
 * --rehearsal, and mainnet-lib refuses the mainnet genesis hash in that mode. Keys live in chain/.rehearsal/keys.
 *
 *   MPB_REHEARSAL_RPC_URL=... node rehearse-launch.ts fund --from <path> --sol <n> --rehearsal   move devnet SOL to the rehearsal launch wallet
 *   node rehearse-launch.ts coin --buy-sol <n> --rehearsal      fresh pump coin (create_v2), prints MINT=
 *   node rehearse-launch.ts trade --mint <m> --sol <n> [--times k] [--gap-ms g] --rehearsal     market buys, to move the curve
 *   node rehearse-launch.ts buyout --mint <m> --rehearsal       buys the rest of the curve, so it completes
 *   node rehearse-launch.ts sol-buy --x <n> --y <n> --rehearsal 1x1 SOL purchase, timed
 *   node rehearse-launch.ts close --rehearsal                   closes the rehearsal program, refunding its rent
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda, getBuySolAmountFromTokenAmount, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { WSOL_MINT, buildBuyTx, parseBondingCurve } from "@mpb/sdk";
import BN from "bn.js";
import { existsSync, readFileSync } from "node:fs";
import { buildTx, connect, die, ensureKey, keypath, loadKey, main, parseArgs, programId, roles, runMode, sendAndConfirm, sleep, sol, solToLamports, solanaCli, strArg } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  if (!args.has("rehearsal")) die("this script only runs with --rehearsal");
  const mode = runMode(args);
  const { connection: c, url, label } = await connect(mode);
  const cmd = process.argv[2];
  console.log(`cluster   ${label}`);
  const trader = () => { ensureKey(mode, "trader"); return loadKey(mode, "trader"); };
  const launch = () => { ensureKey(mode, "launch"); return loadKey(mode, "launch"); };

  if (cmd === "fund") {
    const from = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(strArg(args, "from")!, "utf8"))));
    const to = strArg(args, "to") === "trader" ? trader().publicKey : launch().publicKey;
    const { tx, lastValidBlockHeight } = await buildTx(c, from.publicKey, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: solToLamports(strArg(args, "sol")!) })], { units: 2_000 });
    console.log(`sent ${await sendAndConfirm(c, tx, lastValidBlockHeight, [from])}\n${to.toBase58()} now has ${sol(await c.getBalance(to))} SOL`);
    return;
  }
  if (cmd === "coin") {
    const t = trader();
    const mint = Keypair.generate();
    const name = strArg(args, "name") ?? "Pixel Frame Rehearsal", symbol = strArg(args, "symbol") ?? "PXREH";
    const uri = "https://example.com/rehearsal.json";
    const online = new OnlinePumpSdk(c);
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null)]);
    const budget = new BN(solToLamports(strArg(args, "buy-sol") ?? "0").toString());
    const ixs = budget.isZero()
      ? [await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name, symbol, uri, creator: t.publicKey, user: t.publicKey, mayhemMode: false })]
      : await PUMP_SDK.createV2AndBuyInstructions({ global, mint: mint.publicKey, name, symbol, uri, creator: t.publicKey, user: t.publicKey, solAmount: budget, mayhemMode: false,
          amount: getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: budget, quoteMint: WSOL_MINT }) });
    const { tx, lastValidBlockHeight } = await buildTx(c, t.publicKey, ixs, { units: 400_000 });
    await sendAndConfirm(c, tx, lastValidBlockHeight, [t, mint]);
    console.log(`MINT=${mint.publicKey.toBase58()}\nCURVE=${bondingCurvePda(mint.publicKey).toBase58()}`);
    return;
  }
  if (cmd === "trade" || cmd === "buyout") {
    const t = trader();
    const mint = new PublicKey(strArg(args, "mint")!);
    const online = new OnlinePumpSdk(c);
    const times = Number(strArg(args, "times") ?? 1), gap = Number(strArg(args, "gap-ms") ?? 0);
    for (let i = 0; i < times; i++) {
      const tokenProgram = (await c.getAccountInfo(mint))!.owner;
      const [global, feeConfig, st] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null), online.fetchBuyState(mint, t.publicKey, tokenProgram)]);
      const mintSupply = new BN((await c.getTokenSupply(mint)).value.amount);
      let amount: BN, solAmount: BN;
      if (cmd === "buyout") {
        const curveAcc = (await c.getAccountInfo(bondingCurvePda(mint)))!;
        amount = new BN(curveAcc.data.readBigUInt64LE(24).toString());
        solAmount = getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve: st.bondingCurve, amount, quoteMint: st.quoteMint }).muln(102).divn(100);
      } else {
        solAmount = new BN(solToLamports(strArg(args, "sol")!).toString());
        amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve: st.bondingCurve, amount: solAmount, quoteMint: st.quoteMint });
      }
      const ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: t.publicKey, amount, solAmount, slippage: 5, tokenProgram });
      const { tx, lastValidBlockHeight } = await buildTx(c, t.publicKey, ixs, { units: 300_000 });
      const sig = await sendAndConfirm(c, tx, lastValidBlockHeight, [t]);
      const p = parseBondingCurve((await c.getAccountInfo(bondingCurvePda(mint)))!.data);
      console.log(`${new Date().toISOString()} ${cmd} ${sol(BigInt(solAmount.toString()))} SOL ${sig.slice(0, 12)} complete=${p.complete} virtual sol ${sol(p.quoteLamports)}`);
      if (gap) await sleep(gap);
    }
    return;
  }
  if (cmd === "sol-buy") {
    const t0 = Date.now();
    const t = trader();
    const built = await buildBuyTx(c, { mode: "sol", buyer: t.publicKey, rect: { x: Number(strArg(args, "x")), y: Number(strArg(args, "y")), w: 1, h: 1 }, programId: programId(mode),
      content: { title: "Rehearsal", link: "https://pixelframe.tech", imageUri: "ar://rehearsal", imageSha256: new Uint8Array(32) } });
    const sig = await sendAndConfirm(c, built.transaction, built.lastValidBlockHeight, [t]);
    console.log(`SOL buy ok in ${Date.now() - t0} ms: ${sig}`);
    return;
  }
  if (cmd === "close") {
    const launchPath = keypath(mode, "launch");
    if (existsSync(launchPath)) solanaCli(url, ["program", "close", programId(mode).toBase58(), "--recipient", roles(mode).launch.toBase58(), "--authority", launchPath, "--keypair", launchPath, "--bypass-warning"]);
    return;
  }
  die(`unknown command ${cmd}`);
});
