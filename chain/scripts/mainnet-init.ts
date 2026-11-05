/**
 * Launch-minute init: mint -> validate -> sample <= 60 s -> initialize -> first crank. SOL purchases open the moment initialize lands, so this is built to
 * land: priority fees that escalate, rebroadcast, and failover across MAINNET_RPC_URL + MAINNET_RPC_URL_2 / _3.
 *
 *   node mainnet-init.ts --mint <address> [--expect-creator <wallet>] [--sample-secs 60] [--no-guard] [--execute --mainnet-i-understand]
 *
 * The curve's creator must be COIN_CREATOR (--expect-creator overrides it): Config.token_mint has no setter, so a copycat mint would mean a new program deployment.
 * If the owner typed the name or symbol differently on pump.fun, pass --expect-name / --expect-symbol with what they typed rather than editing code.
 *
 * Without --execute: validates and samples briefly, then simulates. A re-run after a crash is safe: if Config exists it goes straight to the seed guard.
 * The mint is permanent once initialized, so validation refuses anything that isn't exactly the coin we expect (mainnet-mint.ts).
 * Seed: the median of the samples. A wild first minute doesn't abort: dispersion is reported, and if spot has left the band the seed uses the latest
 * reads, because the mismatch only ever delays token payments. If the curve already completed: seeds 0 and hands over to mainnet-graduation.ts.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { SOL_USD_FEED_ID, buybackVaultPda, canvasPda, configPda, fetchConfig, initializeIx, parseBondingCurve, spotPriceQ } from "@mpb/sdk";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  COIN_CREATOR, EMA_SEED_BAND, INIT_PARAMS, SAMPLE_EVERY_MS, SAMPLE_MAX_SECS, buildTx, connect, die, explorer, failoverConnections, firstAnswer, here, loadKey, main, markStep, maxMinRatio, medianBig, parseArgs, parseProgramData,
  priorityMicroLamports, programDataAddress, programId, readState, redact, roles, runMode, sendRobust, simulate, sleep, strArg, watcherAlive, writeState,
} from "./mainnet-lib.ts";
import { validateMint } from "./mainnet-mint.ts";
import { runSeedGuard } from "./mainnet-guard.ts";

const ms = (t0: number) => `T+${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function sampleSpot(conns: Connection[], curve: PublicKey, secs: number, t0: number) {
  const xs: bigint[] = [];
  const end = Date.now() + secs * 1000;
  let complete = false;
  while (Date.now() < end) {
    const tick = Date.now();
    const a = await firstAnswer(conns, (c) => c.getAccountInfo(curve)).catch((e: Error) => { console.log(`  read failed: ${redact(e.message).slice(0, 120)}`); return null; });
    if (a) {
      const p = parseBondingCurve(a.data);
      if (p.complete) { complete = true; console.log(`  ${ms(t0)} curve completed during sampling`); break; }
      xs.push(spotPriceQ(p.quoteLamports, p.baseUnits));
    }
    await sleep(Math.max(0, SAMPLE_EVERY_MS - (Date.now() - tick)));
  }
  return { xs, complete };
}

main(async () => {
  const t0 = Date.now();
  const args = parseArgs();
  const mode = runMode(args);
  const mintArg = strArg(args, "mint");
  if (!mintArg) die("--mint <address> is required");
  const expectCreator = strArg(args, "expect-creator") ?? (mode.rehearsal ? undefined : COIN_CREATOR);
  let mint: PublicKey;
  try { mint = new PublicKey(mintArg); } catch { die(`not an address: ${mintArg}`); }
  const { connection, label, genesis } = await connect(mode);
  const conns = await failoverConnections(mode, connection, genesis);
  const pid = programId(mode);
  const r = roles(mode);
  console.log(`cluster   ${label}, ${conns.length} endpoint(s)\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN"}\nprogram   ${pid.toBase58()}\nconfig    ${configPda(pid).toBase58()}\ncanvas    ${canvasPda(pid).toBase58()}\nvault     ${buybackVaultPda(pid).toBase58()}`);
  console.log(`params    max_price_age ${INIT_PARAMS.maxPriceAgeSecs}s, token blocks/h ${INIT_PARAMS.tokenBlocksCapPerHour}, buyback cap ${INIT_PARAMS.buybackCapLamportsPerHour} lamports/h, slippage ${INIT_PARAMS.buybackMaxSlippageBps} bps\ntreasury  ${r.treasury.toBase58()}\nkeeper    ${r.keeper.toBase58()}\nadmin     ${r.launch.toBase58()}`);

  const after = async () => {
    if (!mode.execute || args.has("no-guard")) return;
    console.log(`${ms(t0)} SOL purchases are open. Seed guard running; Ctrl-C is safe, mainnet-guard.ts resumes it.`);
    const result = await runSeedGuard(mode, conns);
    console.log(`${ms(t0)} guard: ${result}`);
    if (result === "graduation") {
      if (watcherAlive(mode)) { console.log("the graduation watcher is running and takes it from here"); return; }
      console.log("no graduation watcher is running: starting one in this terminal, with auto-execute");
      const flags = ["--execute", ...(mode.rehearsal ? ["--rehearsal"] : ["--mainnet-i-understand"])];
      spawnSync("node", [resolve(here, "mainnet-graduation.ts"), "watch", "--auto-execute", ...flags], { stdio: "inherit" });
    }
  };

  const existing = await firstAnswer(conns, (c) => fetchConfig(c, pid)).catch(() => null);
  if (existing) {
    if (!existing.tokenMint.equals(mint)) die(`Config already uses mint ${existing.tokenMint.toBase58()}, not ${mint.toBase58()}`);
    console.log("already initialized with this mint");
    if (mode.execute) markStep(mode, "init", { alreadyInitialized: true });
    return after();
  }

  const check = await validateMint(conns, mint, { expectName: strArg(args, "expect-name"), expectSymbol: strArg(args, "expect-symbol"), expectCreator });
  console.log(`${ms(t0)} mint ${mint.toBase58()}\n  name "${check.name}", symbol "${check.symbol}", supply ${check.supply}, token program ${check.tokenProgram?.toBase58()}\n  curve ${check.curve.toBase58()}, complete ${check.complete}\n  creator ${check.creator ?? "?"}\n  pool after graduation ${check.pool.toBase58()}`);
  for (const n of check.notes) console.log(`  note: ${n}`);
  if (!check.ok) { for (const e of check.errors) console.error(`  INVALID: ${e}`); die("mint validation failed: nothing was sent"); }
  console.log(`${ms(t0)} mint is valid`);

  const programData = await firstAnswer(conns, (c) => c.getAccountInfo(programDataAddress(pid)));
  if (!programData) { if (mode.execute) die("program not deployed"); console.log("program not deployed yet: stopping the dry run here"); return; }
  const auth = parseProgramData(programData.data).authority;
  if (!auth?.equals(r.launch)) die(`upgrade authority is ${auth?.toBase58() ?? "none"}, not the launch wallet: initialize would fail`);

  const secs = Math.min(SAMPLE_MAX_SECS, Number(strArg(args, "sample-secs") ?? SAMPLE_MAX_SECS));
  let seed = 0n, medianQ = 0n, ratio = 1, count = 0;
  if (!check.complete) {
    console.log(`${ms(t0)} sampling spot for ${mode.execute ? secs : Math.min(secs, 6)} s`);
    const { xs, complete } = await sampleSpot(conns, check.curve, mode.execute ? secs : Math.min(secs, 6), t0);
    count = xs.length;
    if (complete) check.complete = true;
    else if (!xs.length) die("no spot reads at all: check the RPC endpoints");
    if (xs.length) {
      medianQ = medianBig(xs); ratio = maxMinRatio(xs);
      const tail = medianBig(xs.slice(-3));
      const off = Number(((tail > medianQ ? tail - medianQ : medianQ - tail) * 1_000_000n) / medianQ) / 1_000_000;
      // A median the market has already left would only make the first crank fail; seed where the market is now.
      seed = off > EMA_SEED_BAND * 0.8 ? tail : medianQ;
      console.log(`${ms(t0)} ${xs.length} samples, median ${medianQ}, max/min ${ratio.toFixed(4)}, latest ${tail} (${(off * 100).toFixed(1)}% from the median); seed ${seed}${seed === tail && seed !== medianQ ? " (latest reads: the market left the median)" : ""}`);
    }
  }
  if (check.complete) { seed = 0n; console.log(`${ms(t0)} curve is complete: seeding 0 (token payments off); the graduation flow seeds from the pool. SOL purchases still open now.`); }

  const ix = initializeIx({
    admin: r.launch, tokenMint: mint, tokenProgram: check.tokenProgram!, treasury: r.treasury, keeper: r.keeper, pythFeedIdHex: SOL_USD_FEED_ID, priceSource: { kind: "bondingCurve", curve: check.curve },
    // Devnet's sponsored Pyth account can sit idle for minutes; rehearsal only.
    maxPriceAgeSecs: mode.rehearsal && strArg(args, "max-price-age-secs") ? BigInt(strArg(args, "max-price-age-secs")!) : INIT_PARAMS.maxPriceAgeSecs, buybackCapLamportsPerHour: INIT_PARAMS.buybackCapLamportsPerHour, buybackMaxSlippageBps: INIT_PARAMS.buybackMaxSlippageBps,
    initialTokenEmaPriceSol: seed, tokenBlocksCapPerHour: INIT_PARAMS.tokenBlocksCapPerHour, programId: pid,
  });
  const units = 200_000;
  const { tx } = await firstAnswer(conns, (c) => buildTx(c, r.launch, [ix], { units }));
  const sim = await firstAnswer(conns, (c) => simulate(c, tx));
  console.log(`${ms(t0)} simulate ${sim.ok ? `ok, ${sim.units} CU` : `ERR ${JSON.stringify(sim.err)}`}`);
  if (!sim.ok) { console.log(sim.logs.slice(-6).join("\n")); throw new Error("initialize simulation failed"); }
  if (!mode.execute) { console.log("DRY RUN: nothing sent"); return; }

  const s = readState(mode);
  s.mint = mint.toBase58(); s.curve = check.curve.toBase58();
  s.seed = { seedQ: seed.toString(), medianQ: medianQ.toString(), count, ratio, at: new Date().toISOString() };
  writeState(mode, s);
  const micro = await firstAnswer(conns, (c) => priorityMicroLamports(c, [], 200_000));
  const sig = await sendRobust(conns, r.launch, [ix], [loadKey(mode, "launch")], {
    units, startMicroLamports: micro, done: async () => !!(await firstAnswer(conns, (c) => fetchConfig(c, pid)).catch(() => null)),
  });
  markStep(mode, "init", { sig, seed });
  console.log(`${ms(t0)} INITIALIZED ${sig ? explorer(mode, "tx", sig) : "(landed on an earlier attempt)"}`);
  await after();
});
