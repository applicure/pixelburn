/**
 * Read-only checks.
 *   node mainnet-verify.ts deploy   # on-chain program bytes == the recorded .so, trailing bytes zero, authority = launch wallet
 *   node mainnet-verify.ts config   # on-chain Config == the decided parameters
 * Exits 1 on any mismatch.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID, SOL_USD_FEED_ID, buybackVaultPda, canvasPda, fetchCanvas, fetchConfig } from "@mpb/sdk";
import { INIT_PARAMS, connect, die, main, markStep, maxLenFor, parseArgs, parseProgramData, programDataAddress, programId, readState, roles, runMode } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const what = process.argv[2];
  const { connection: c, label } = await connect(mode);
  const pid = programId(mode);
  const r = roles(mode);
  const st = readState(mode);
  console.log(`cluster   ${label}`);
  const fails: string[] = [];
  const eq = (name: string, got: unknown, want: unknown) => {
    const a = String(got), b = String(want);
    if (a === b) console.log(`  ok    ${name} = ${a}`);
    else { console.log(`  FAIL  ${name} = ${a}, expected ${b}`); fails.push(name); }
  };
  if (what === "deploy") {
    if (!st.build) { if (!mode.execute) { console.log("no build recorded yet: nothing to check"); return; } die("no build recorded"); }
    const prog = await c.getAccountInfo(pid);
    if (!prog?.executable) { if (!mode.execute) { console.log("program not deployed yet: nothing to check"); return; } die("program not deployed"); }
    const pd = await c.getAccountInfo(programDataAddress(pid));
    if (!pd) die("program data missing");
    const { authority, elf } = parseProgramData(pd.data);
    const so = readFileSync(st.build.path);
    eq("sha256(on-chain, trimmed to .so length)", createHash("sha256").update(elf.subarray(0, so.length)).digest("hex"), st.build.sha256);
    eq("trailing bytes all zero", elf.subarray(so.length).every((b) => b === 0), true);
    eq("program data capacity", elf.length, maxLenFor(so.length));
    eq("upgrade authority", authority?.toBase58(), r.launch.toBase58());
    if (!fails.length) markStep(mode, "verify-deploy", { sha256: st.build.sha256 });
  } else if (what === "config") {
    const cfg = await fetchConfig(c, pid).catch(() => null);
    if (!cfg) { if (!mode.execute) { console.log("config not initialized yet: nothing to check"); return; } die("config not initialized"); }
    const mint = cfg.tokenMint;
    if (st.mint) eq("token mint = the mint given to init", mint.toBase58(), st.mint);
    const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
    eq("admin", cfg.admin.toBase58(), r.launch.toBase58());
    eq("pending admin", cfg.pendingAdmin.toBase58(), PublicKey.default.toBase58());
    eq("treasury", cfg.treasury.toBase58(), r.treasury.toBase58());
    eq("keeper", cfg.keeper.toBase58(), r.keeper.toBase58());
    eq("mint owner = config token program", (await c.getAccountInfo(mint))?.owner.toBase58(), cfg.tokenProgram.toBase58());
    eq("decimals", cfg.tokenDecimals, 6);
    eq("pyth feed", cfg.pythFeedId, SOL_USD_FEED_ID);
    eq("paused", cfg.paused, false);
    eq("max price age", cfg.maxPriceAgeSecs, INIT_PARAMS.maxPriceAgeSecs);
    eq("token blocks cap per hour", cfg.tokenBlocksCapPerHour, INIT_PARAMS.tokenBlocksCapPerHour);
    eq("buyback cap per hour", cfg.buybackCapLamportsPerHour, INIT_PARAMS.buybackCapLamportsPerHour);
    eq("buyback slippage bps", cfg.buybackMaxSlippageBps, INIT_PARAMS.buybackMaxSlippageBps);
    if (cfg.priceSource.kind === "bondingCurve") {
      eq("price source curve", cfg.priceSource.curve.toBase58(), curve.toBase58());
      console.log(`  --    EMA ${cfg.tokenEmaPriceSol}, seed ${st.seed?.seedQ ?? "n/a"}, warm-up cranks ${cfg.emaWarmupCranks}`);
    } else console.log(`  --    price source is already the pool ${cfg.priceSource.pool.toBase58()}, warm-up cranks ${cfg.emaWarmupCranks}`);
    const canvas = await fetchCanvas(c, pid);
    console.log(`  --    canvas ${canvasPda(pid).toBase58()} sold ${canvas.soldBlocks}; vault ${buybackVaultPda(pid).toBase58()} ${await c.getBalance(buybackVaultPda(pid))} lamports`);
    if (!fails.length) markStep(mode, "verify-config", {});
  } else die("usage: mainnet-verify.ts deploy|config");
  if (fails.length) { console.log(`\nFAILED: ${fails.join(", ")}`); process.exit(1); }
  console.log("\nall checks passed");

});
