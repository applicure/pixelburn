/**
 * Seed-band guard. The first crank after a (re)seed fails EmaSeedMismatch if spot moved more than 25% from the seed, and it can't be tried until 30 s
 * after the seed. Launch-minute prices can do that. This loop holds the admin key on the owner's machine (never on a server) and, until a first crank
 * lands: cranks itself at the earliest moment (the crank is permissionless; the launch wallet only pays the fee), and on EmaSeedMismatch re-seeds through
 * the existing set_price_source with the current spot, which restarts the 30 s clock. No program change. Token payments and buybacks stay gated by the
 * on-chain warm-up throughout. SOL payments don't read any of this.
 * A PUMP-quoted coin can't be cranked or seeded until the program upgrade: the guard reports "parked" and stops, and sends nothing.
 *
 *   node mainnet-guard.ts [--execute --mainnet-i-understand] [--max-reseeds 40]     dry run reports what it would do once
 */
import { type Connection, type Keypair, type PublicKey } from "@solana/web3.js";
import { WSOL_MINT, crankTokenPriceIx, fetchConfig, parseBondingCurve, priceSourceQuoteMint, readSpotPriceQ, setPriceSourceIx, type PriceSource } from "@mpb/sdk";
import { fileURLToPath } from "node:url";
import { EMA_MIN_INTERVAL_SECS, EMA_WARMUP_CRANKS, EMA_WARMUP_SECS, buildTx, connect, failoverConnections, firstAnswer, loadKey, main, markStep, medianBig, parseArgs, priorityMicroLamports, programId, redact, roles, runMode, sendRobust, sleep, strArg, type RunMode } from "./mainnet-lib.ts";

const SPOT_READS = 3;

export type GuardResult = "cranked" | "graduation" | "dry-run" | "gave-up" | "parked";

/** What the first crank would do right now: a simulation, so it costs nothing. */
async function crankOutcome(conns: Connection[], payer: PublicKey, ps: PriceSource, pid: PublicKey): Promise<"ok" | "too-soon" | "seed-mismatch" | "curve-complete" | string> {
  return firstAnswer(conns, async (c) => {
    const { tx } = await buildTx(c, payer, [crankTokenPriceIx({ priceSource: ps, programId: pid })], { units: 40_000 });
    const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (!sim.value.err) return "ok";
    const logs = (sim.value.logs ?? []).join("\n");
    if (logs.includes("CrankTooSoon")) return "too-soon";
    if (logs.includes("EmaSeedMismatch")) return "seed-mismatch";
    if (logs.includes("CurveComplete")) return "curve-complete";
    return JSON.stringify(sim.value.err);
  });
}

export async function runSeedGuard(mode: RunMode, conns: Connection[], o: { maxReseeds?: number; log?: (m: string) => void; admin?: Keypair } = {}): Promise<GuardResult> {
  const log = o.log ?? ((m: string) => console.log(m));
  const pid = programId(mode);
  const launch = roles(mode).launch;
  const maxReseeds = o.maxReseeds ?? 40;
  let reseeds = 0;
  let lastReport = "";
  const say = (m: string) => { if (m !== lastReport) log(`${new Date().toISOString()} guard: ${(lastReport = m)}`); };
  for (;;) {
    try {
      const cfg = await firstAnswer(conns, (c) => fetchConfig(c, pid));
      const quote = await firstAnswer(conns, (c) => priceSourceQuoteMint(c, cfg.priceSource));
      if (quote && !quote.equals(WSOL_MINT)) { log(`guard: parked, the coin is quoted in ${quote.toBase58()}. Nothing to crank or re-seed until the program upgrade. SOL payments are unaffected.`); return "parked"; }
      if (cfg.emaWarmupCranks > 0) {
        log(`guard: first crank landed. ${cfg.emaWarmupCranks}/${EMA_WARMUP_CRANKS} cranks; token payments open ~${EMA_WARMUP_SECS} s after the first crank (at ${new Date((cfg.emaWarmupStartedAt + EMA_WARMUP_SECS) * 1000).toISOString()} at the earliest). ${reseeds} re-seed(s).`);
        return "cranked";
      }
      if (cfg.tokenEmaPriceSol === 0n) { say("EMA is unseeded (curve completed before init): the graduation flow seeds from the pool"); return "graduation"; }
      if (cfg.priceSource.kind === "bondingCurve") {
        const curveAcc = await firstAnswer(conns, (c) => c.getAccountInfo((cfg.priceSource as { curve: PublicKey }).curve));
        if (curveAcc && parseBondingCurve(curveAcc.data).complete) { say("curve completed: the graduation flow takes over"); return "graduation"; }
      }
      const age = Math.floor(Date.now() / 1000) - cfg.emaUpdatedAt;
      if (age < EMA_MIN_INTERVAL_SECS - 1) { say(`waiting for the 30 s minimum since the seed`); await sleep(Math.min(5_000, (EMA_MIN_INTERVAL_SECS - age) * 1000)); continue; }
      const outcome = await crankOutcome(conns, launch, cfg.priceSource, pid);
      if (outcome === "too-soon") { await sleep(1_500); continue; }
      if (outcome === "curve-complete") { say("curve completed: the graduation flow takes over"); return "graduation"; }
      if (!mode.execute) { log(`guard: first crank would be: ${outcome}. DRY RUN: nothing sent.`); return "dry-run"; }
      const micro = await firstAnswer(conns, (c) => priorityMicroLamports(c, [], 100_000));
      const admin = o.admin ?? loadKey(mode, "launch");
      if (outcome === "ok") {
        say("crank simulates: sending the first crank");
        await sendRobust(conns, launch, [crankTokenPriceIx({ priceSource: cfg.priceSource, programId: pid })], [admin], {
          units: 40_000, startMicroLamports: micro, attempts: 2, log,
          done: async () => (await firstAnswer(conns, (c) => fetchConfig(c, pid))).emaWarmupCranks > 0,
        }).catch((e: Error) => log(`guard: crank attempt failed (normal if the keeper cranked first): ${redact(e.message).slice(0, 160)}`));
        continue;
      }
      if (outcome === "seed-mismatch") {
        if (reseeds >= maxReseeds) { log(`guard: gave up after ${reseeds} re-seeds. Token payments stay off, SOL payments are unaffected. Re-run when the market settles.`); return "gave-up"; }
        const xs: bigint[] = [];
        for (let i = 0; i < SPOT_READS; i++) { xs.push(await firstAnswer(conns, (c) => readSpotPriceQ(c, cfg.priceSource))); if (i < SPOT_READS - 1) await sleep(1_500); }
        const seed = medianBig(xs);
        // The keeper might have got its crank in meanwhile; a re-seed would throw that away.
        if ((await firstAnswer(conns, (c) => fetchConfig(c, pid))).emaWarmupCranks > 0) continue;
        reseeds++;
        log(`${new Date().toISOString()} guard: EmaSeedMismatch: spot ${seed} vs seed ${cfg.tokenEmaPriceSol} (x${(Number((seed * 1000n) / cfg.tokenEmaPriceSol) / 1000).toFixed(3)}). Re-seed ${reseeds}.`);
        const sig = await sendRobust(conns, launch, [setPriceSourceIx({ admin: launch, priceSource: cfg.priceSource, initialEmaPriceSol: seed, programId: pid })], [admin], { units: 30_000, startMicroLamports: micro, log });
        markStep(mode, "reseed", { sig, seed, count: reseeds });
        continue;
      }
      log(`guard: unexpected crank result ${outcome}; retrying`);
      await sleep(3_000);
    } catch (e) {
      log(`guard: ${redact((e as Error).message).slice(0, 200)}; retrying`);
      await sleep(2_000);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(async () => {
    const args = parseArgs();
    const mode = runMode(args);
    const { connection, label, genesis } = await connect(mode);
    console.log(`cluster   ${label}\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN"}`);
    const conns = await failoverConnections(mode, connection, genesis);
    const n = strArg(args, "max-reseeds");
    const cfg = await fetchConfig(connection, programId(mode)).catch(() => null);
    if (!cfg) { console.log("config not initialized yet: nothing to guard"); return; }
    console.log(`result: ${await runSeedGuard(mode, conns, { maxReseeds: n ? Number(n) : undefined })}`);
  });
}
