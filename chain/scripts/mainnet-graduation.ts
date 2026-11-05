/**
 * Switches pricing from the bonding curve to the canonical PumpSwap pool once pump has migrated the coin (it can happen minutes after launch).
 * The program pauses token payments safely until this runs; SOL payments never stop. We never call migrate on mainnet: pump's bot does it.
 *
 *   status                                      read-only overview
 *   watch                                       NO KEY. Waits for the coin, config, curve complete and the pool; takes the 60 s median; writes
 *                                               the proposal (.mainnet-graduation-proposal.json) and stops. Safe to run anywhere.
 *   execute [--execute --mainnet-i-understand]  on the machine holding the launch key: re-validates the proposal, shows it, simulates, sends.
 *   watch --auto-execute --execute --mainnet-i-understand
 *                                               unattended: same process prepares and sends. Needs the launch key, so ONLY on the owner's machine.
 *   reseed [--execute --mainnet-i-understand]   re-seeds the CURRENT source from a fresh 60 s median, for EmaSeedMismatch or a stale seed.
 *
 * The launch key is also the upgrade authority: it must never be put on a server. See "Graduation" in chain/NOTES.md.
 * The transaction can do one thing: set_price_source to the pool derived from the on-chain mint, with a seed the samples agree on.
 */
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { PUMP_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, associatedTokenAddress, fetchConfig, parseBondingCurve, poolSpotPriceQ, readSpotPriceQ, setPriceSourceIx, type ConfigAccount, type PriceSource } from "@mpb/sdk";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import {
  GRAD_MAX_DISPERSION, GRAD_MEDIAN_WINDOW_SECS, buildTx, connect, die, dispersionFromMedian, explorer, loadKey, main, markStep, medianBig, parseArgs, priorityMicroLamports, programId, proposalPath, readState, redact, roles,
  runMode, sendAndConfirm, simulate, sleep, stringifyBig, strArg, watcherHeartbeatPath, type RunMode,
} from "./mainnet-lib.ts";
import { runSeedGuard } from "./mainnet-guard.ts";

const POLL_MS = 5_000;
const SAMPLE_EVERY_MS = 5_000;
const MAX_PROPOSAL_AGE_MS = 15 * 60_000;
const MAX_DRIFT_AT_EXECUTE = 0.10;

interface Proposal {
  program: string; mint: string; pool: string; baseVault: string; quoteVault: string; seedQ: string; samples: number; dispersion: number; preparedAt: string; ixDataBase64: string;
}

const pidOf = (mode: RunMode) => programId(mode);
const curveOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];

function poolFor(cfg: ConfigAccount): Extract<PriceSource, { kind: "pool" }> {
  const pool = canonicalPumpPoolPda(cfg.tokenMint);
  return { kind: "pool", pool, baseVault: associatedTokenAddress(pool, cfg.tokenMint, cfg.tokenProgram), quoteVault: associatedTokenAddress(pool, WSOL_MINT, TOKEN_PROGRAM_ID) };
}

async function poolReady(c: Connection, ps: Extract<PriceSource, { kind: "pool" }>): Promise<boolean> {
  const [p, b, q] = await c.getMultipleAccountsInfo([ps.pool, ps.baseVault, ps.quoteVault]);
  if (!p || !b || !q) return false;
  try { return poolSpotPriceQ(p.data, b.data, q.data) > 0n; } catch { return false; }
}

async function medianOver(c: Connection, ps: PriceSource, windowSecs: number): Promise<{ median: bigint; n: number; dispersion: number }> {
  const xs: bigint[] = [];
  const end = Date.now() + windowSecs * 1000;
  do {
    try { xs.push(await readSpotPriceQ(c, ps)); } catch (e) { console.log(`  spot read failed: ${redact((e as Error).message)}`); }
    await sleep(Math.min(SAMPLE_EVERY_MS, Math.max(0, end - Date.now())) || 1);
  } while (Date.now() < end);
  if (xs.length < Math.floor(windowSecs / (SAMPLE_EVERY_MS / 1000)) / 2) throw new Error(`only ${xs.length} spot reads in ${windowSecs} s`);
  return { median: medianBig(xs), n: xs.length, dispersion: dispersionFromMedian(xs) };
}

async function notify(text: string) {
  const url = process.env.GRADUATION_WEBHOOK_URL;
  console.log(`\u0007>>> ${text}`);
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) }).catch(() => console.log("webhook failed"));
}

/** The admin key is read only here, only when actually sending, and never in a key-free `watch`. */
async function send(mode: RunMode, c: Connection, ix: TransactionInstruction, label: string): Promise<string | null> {
  const r = roles(mode);
  const { tx, lastValidBlockHeight } = await buildTx(c, r.launch, [ix], { units: 60_000, microLamports: await priorityMicroLamports(c) });
  const sim = await simulate(c, tx);
  console.log(`simulate  ${sim.ok ? `ok, ${sim.units} CU` : `ERR ${JSON.stringify(sim.err)}`}`);
  if (!sim.ok) { console.log(sim.logs.slice(-6).join("\n")); throw new Error(`${label} simulation failed`); }
  if (!mode.execute) { console.log("DRY RUN: nothing sent, the launch key wasn't used"); return null; }
  const admin = loadKey(mode, "launch");
  if (!admin.publicKey.equals(r.launch)) die("launch key file doesn't match the launch role");
  const sig = await sendAndConfirm(c, tx, lastValidBlockHeight, [admin]);
  console.log(`sent ${explorer(mode, "tx", sig)}`);
  return sig;
}

function buildProposal(mode: RunMode, cfg: ConfigAccount, ps: Extract<PriceSource, { kind: "pool" }>, seed: bigint, n: number, dispersion: number): Proposal {
  const ix = setPriceSourceIx({ admin: roles(mode).launch, priceSource: ps, initialEmaPriceSol: seed, programId: pidOf(mode) });
  return {
    program: pidOf(mode).toBase58(), mint: cfg.tokenMint.toBase58(), pool: ps.pool.toBase58(), baseVault: ps.baseVault.toBase58(), quoteVault: ps.quoteVault.toBase58(),
    seedQ: seed.toString(), samples: n, dispersion, preparedAt: new Date().toISOString(), ixDataBase64: Buffer.from(ix.data).toString("base64"),
  };
}

/** Everything is re-derived from chain state; the file is only trusted for the seed, and that is checked against the live spot. */
async function executeProposal(mode: RunMode, c: Connection, p: Proposal): Promise<boolean> {
  const pid = pidOf(mode);
  if (p.program !== pid.toBase58()) die("proposal is for another program");
  const age = Date.now() - new Date(p.preparedAt).getTime();
  if (age > MAX_PROPOSAL_AGE_MS) die(`proposal is ${Math.round(age / 60000)} min old: prepare a new one`);
  const cfg = await fetchConfig(c, pid);
  if (!cfg.admin.equals(roles(mode).launch)) die("config.admin is not the launch wallet");
  if (cfg.priceSource.kind === "pool") { console.log("already on the pool: nothing to do"); return true; }
  if (cfg.tokenMint.toBase58() !== p.mint) die("proposal mint differs from config");
  const ps = poolFor(cfg);
  if (ps.pool.toBase58() !== p.pool || ps.baseVault.toBase58() !== p.baseVault || ps.quoteVault.toBase58() !== p.quoteVault) die("proposal pool isn't the canonical one");
  const curveAcc = await c.getAccountInfo(curveOf(cfg.tokenMint));
  if (curveAcc && !parseBondingCurve(curveAcc.data).complete) die("curve is not complete");
  if (!(await poolReady(c, ps))) die("pool isn't readable");
  const seed = BigInt(p.seedQ);
  const spot = await readSpotPriceQ(c, ps);
  const drift = Number(((spot > seed ? spot - seed : seed - spot) * 1_000_000n) / seed) / 1_000_000;
  console.log(`proposal  set_price_source -> Pool\n  pool       ${p.pool}\n  base vault ${p.baseVault}\n  quote vault ${p.quoteVault}\n  seed       ${p.seedQ} (median of ${p.samples}, dispersion ${(p.dispersion * 100).toFixed(2)}%)\n  live spot  ${spot}, ${(drift * 100).toFixed(2)}% from the seed\n  prepared   ${p.preparedAt}`);
  if (drift > MAX_DRIFT_AT_EXECUTE) { console.log(`spot moved ${(drift * 100).toFixed(2)}% since the proposal: not sending, prepare a new one`); return false; }
  const ix = setPriceSourceIx({ admin: roles(mode).launch, priceSource: ps, initialEmaPriceSol: seed, programId: pid });
  if (Buffer.from(ix.data).toString("base64") !== p.ixDataBase64) die("rebuilt instruction differs from the proposal");
  const sig = await send(mode, c, ix, "set_price_source");
  if (sig) {
    markStep(mode, "graduation", { sig, seed, pool: p.pool });
    await notify(`Pixel Frame: price source switched to the pool (${sig}). Warm-up restarts: about 10 min after the first crank, which needs spot within 25% of the seed.`);
    // pump's boost wave can move the pool past the band; re-seed until the first crank lands.
    await runSeedGuard(mode, [c], { log: (m) => console.log(m) });
  }
  return true;
}

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const cmd = process.argv[2] ?? "status";
  const { connection: c, label } = await connect(mode);
  const pid = pidOf(mode);
  console.log(`cluster   ${label}\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN / read-only"}\ncommand   ${cmd}`);

  if (cmd === "status") {
    const st = readState(mode);
    const cfg = await fetchConfig(c, pid).catch(() => null);
    if (!st.mint && !cfg) { console.log("no coin and no config yet"); return; }
    const mint = cfg?.tokenMint ?? new PublicKey(st.mint!);
    const curveAcc = await c.getAccountInfo(curveOf(mint));
    const pool = canonicalPumpPoolPda(mint);
    console.log(stringifyBig({
      mint, curve: curveOf(mint), curveComplete: curveAcc ? parseBondingCurve(curveAcc.data).complete : null, pool, poolExists: !!(await c.getAccountInfo(pool)),
      configSource: cfg?.priceSource.kind ?? "no config yet", emaQ: cfg?.tokenEmaPriceSol, warmupCranks: cfg?.emaWarmupCranks, watcherAlive: existsSync(watcherHeartbeatPath(mode)),
    }));
    return;
  }

  if (cmd === "execute") {
    const path = strArg(args, "proposal") ?? proposalPath(mode);
    if (!existsSync(path)) die(`no proposal at ${path}: run watch first`);
    const done = await executeProposal(mode, c, JSON.parse(readFileSync(path, "utf8")) as Proposal);
    process.exit(done ? 0 : 3);
  }

  if (cmd === "reseed") {
    const cfg = await fetchConfig(c, pid);
    console.log(`re-seeding the current source (${cfg.priceSource.kind}), current EMA ${cfg.tokenEmaPriceSol}`);
    const m = await medianOver(c, cfg.priceSource, GRAD_MEDIAN_WINDOW_SECS);
    console.log(`median ${m.median} of ${m.n}, dispersion ${(m.dispersion * 100).toFixed(2)}%`);
    if (m.dispersion > GRAD_MAX_DISPERSION) { console.error(`ABORT: dispersion above ${GRAD_MAX_DISPERSION * 100}%: re-run when the market settles`); process.exit(2); }
    const sig = await send(mode, c, setPriceSourceIx({ admin: roles(mode).launch, priceSource: cfg.priceSource, initialEmaPriceSol: m.median, programId: pid }), "reseed");
    if (sig) markStep(mode, "reseed", { sig, seed: m.median });
    return;
  }

  if (cmd !== "watch") die(`unknown command ${cmd}`);
  const auto = args.has("auto-execute");
  if (auto && !mode.execute) die("--auto-execute needs --execute (and --mainnet-i-understand on mainnet)");
  if (!auto && mode.execute) die("plain watch never sends. Use execute, or watch --auto-execute");
  if (auto) { loadKey(mode, "launch"); console.log("AUTO: the switch is sent without review once a clean median exists"); } else console.log("REVIEW: no key is read; the proposal is written for mainnet-graduation.ts execute");

  const beat = () => { const p = watcherHeartbeatPath(mode); writeFileSync(p, ""); utimesSync(p, new Date(), new Date()); };
  let phase = "";
  const say = (s: string) => { if (s !== phase) console.log(`${new Date().toISOString()} ${(phase = s)}`); };
  const once = args.has("once");
  for (;;) {
    beat();
    try {
      const st = readState(mode);
      const cfg = await fetchConfig(c, pid).catch(() => null);
      const mintStr = cfg?.tokenMint.toBase58() ?? st.mint;
      if (!mintStr) { say("waiting for the coin"); if (once) return; await sleep(POLL_MS); continue; }
      const mint = new PublicKey(mintStr);
      const curveAcc = await c.getAccountInfo(curveOf(mint));
      const complete = curveAcc ? parseBondingCurve(curveAcc.data).complete : false;
      if (!complete) { say(`watching curve ${curveOf(mint).toBase58()}`); if (once) return; await sleep(POLL_MS); continue; }
      say("curve COMPLETE");
      if (!cfg) { say("curve complete, waiting for initialize"); if (once) return; await sleep(POLL_MS); continue; }
      if (cfg.priceSource.kind === "pool") { console.log("config is already on the pool: done"); return; }
      const ps = poolFor(cfg);
      if (!(await poolReady(c, ps))) { say(`curve complete, waiting for pump's migration to ${ps.pool.toBase58()}`); if (once) return; await sleep(POLL_MS); continue; }
      await notify("Pixel Frame: curve complete and pool live. Token payments are paused until the switch; taking the 60 s median.");
      const stop = setInterval(beat, 20_000);
      const windowSecs = mode.rehearsal && strArg(args, "window-secs") ? Number(strArg(args, "window-secs")) : GRAD_MEDIAN_WINDOW_SECS;
      const m = await medianOver(c, ps, windowSecs).finally(() => clearInterval(stop));
      console.log(`median ${m.median} of ${m.n}, dispersion ${(m.dispersion * 100).toFixed(2)}%`);
      if (m.dispersion > GRAD_MAX_DISPERSION) {
        // Expected during pump's boost wave. Nothing was sent; token payments stay safely paused.
        console.log(`dispersion above ${GRAD_MAX_DISPERSION * 100}%: no proposal this round, sampling again in 30 s`);
        if (once) process.exit(2);
        await sleep(30_000);
        continue;
      }
      const proposal = buildProposal(mode, cfg, ps, m.median, m.n, m.dispersion);
      writeFileSync(proposalPath(mode), JSON.stringify(proposal, null, 2));
      console.log(`proposal written: ${proposalPath(mode)}`);
      if (!auto) {
        await notify(`Pixel Frame: graduation proposal ready, seed ${m.median}. Review and run: node mainnet-graduation.ts execute --execute --mainnet-i-understand (expires in 15 min; watch again if it does).`);
        return;
      }
      if (await executeProposal(mode, c, proposal)) return;
      console.log("sampling again");
    } catch (e) {
      console.log(`watch error, retrying: ${redact((e as Error).message)}`);
    }
    await sleep(POLL_MS);
  }
});
