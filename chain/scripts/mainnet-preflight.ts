/**
 * Read-only go/no-go. Sends nothing, and this script has no execute mode.
 *   MAINNET_RPC_URL=... node mainnet-preflight.ts
 * Exits 1 if anything is wrong, including when the launch wallet can't pay the real budget (rent from the current .so + 25%).
 */
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { PROGRAM_IDS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, fetchSolUsd, pythPriceFeedAccount } from "@mpb/sdk";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEVNET_PROGRAM_ID, LAUNCH_BUDGET_LAMPORTS, MAINNET_ROLES, TOKEN_INITIAL_SUPPLY, chainDir, connect, declaredMainnetId, ensureKey, hasCommand, launchBudget, loadKey, main,
  parseArgs, programDataAddress, parseProgramData, programId, readState, repoDir, roles, runMode, sol,
} from "./mainnet-lib.ts";

const problems: string[] = [];
const warnings: string[] = [];
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`  FAIL  ${m}`); };
const warn = (m: string) => { warnings.push(m); console.log(`  warn  ${m}`); };
const docker = () => { try { execSync("docker info", { stdio: "ignore", timeout: 15_000 }); return true; } catch { return false; } };

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  if (args.has("execute")) console.log("note: preflight has no execute mode; it only reads");
  const { connection: c, label } = await connect(mode);
  console.log(`cluster   ${label}\n`);

  console.log("tools");
  for (const t of ["solana", "cargo"]) (hasCommand(t) ? ok : bad)(t);
  const hasVerify = hasCommand("solana-verify");
  const hasDocker = docker();
  hasVerify ? ok("solana-verify") : warn("solana-verify is not installed");
  hasDocker ? ok("docker daemon reachable") : warn("Docker daemon NOT reachable: a reproducible build is impossible until it runs (start it, or mainnet-build needs --allow-unverifiable-build)");

  console.log("\nprogram id");
  const prog = ensureKey(mode, "program");
  const declared = declaredMainnetId();
  const pid = programId(mode);
  declared === prog.pubkey.toBase58() ? ok(`program.json matches the source: ${declared}`) : bad(`program.json is ${prog.pubkey.toBase58()} but the source declares ${declared} (mainnet-program-id.ts --sync)`);
  PROGRAM_IDS["mainnet-beta"].equals(pid) ? ok("SDK cluster map matches") : bad("SDK cluster map differs (mainnet-program-id.ts --sync, then rebuild the SDK)");
  if (declared === DEVNET_PROGRAM_ID) bad("mainnet id equals the devnet id");

  console.log("\nkeys (public keys only)");
  const r = roles(mode);
  for (const name of ["launch", "keeper"] as const) {
    const k = loadKey(mode, name).publicKey;
    k.equals(r[name]) ? ok(`${name} ${k.toBase58()}`) : bad(`${name} key file is ${k.toBase58()}, decided ${r[name].toBase58()}`);
  }
  console.log(`  --    treasury ${r.treasury.toBase58()} (no key read or needed)`);
  if (!mode.rehearsal && MAINNET_ROLES.launch !== r.launch.toBase58()) bad("launch role mismatch");

  console.log("\nsource");
  const dirty = execSync("git status --porcelain -- chain/programs chain/Cargo.lock chain/Cargo.toml chain/Anchor.toml chain/rust-toolchain.toml", { cwd: repoDir, encoding: "utf8" }).trim();
  dirty ? warn("program sources have uncommitted changes: the verified build needs a clean commit") : ok("program sources committed");
  const commit = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
  const pushed = execSync("git branch -r --contains HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
  pushed ? ok(`HEAD ${commit.slice(0, 10)} is on a remote`) : warn(`HEAD ${commit.slice(0, 10)} is not pushed: verify-from-repo clones the public repo, so push before building`);
  const lib = readFileSync(resolve(chainDir, "programs/pixel/src/lib.rs"), "utf8");
  /source_code: "https:\/\/github\.com\/applicure\/pixelburn"/.test(lib) ? ok("security_txt source_code") : bad("security_txt source_code is not the public repo");

  console.log("\nbudget");
  const st = readState(mode);
  const soPath = st.build?.path ?? resolve(chainDir, "target/deploy/pixel.so");
  if (!existsSync(soPath)) { bad(`no .so to size at ${soPath}: run anchor build or mainnet-build`); return finish(); }
  const soBytes = statSync(soPath).size;
  const rentCache = new Map<number, bigint>();
  const rentOf = async (n: number) => { if (!rentCache.has(n)) rentCache.set(n, BigInt(await c.getMinimumBalanceForRentExemption(n))); return rentCache.get(n)!; };
  // loader rent is linear, so a local table from a few RPC reads is exact
  const base = await rentOf(0);
  const perByte = ((await rentOf(1000)) - base) / 1000n;
  const rent = (n: number) => base + perByte * BigInt(n);
  const [launchBal, keeperBal, treasuryBal, programAcc] = await Promise.all([
    c.getBalance(r.launch), c.getBalance(r.keeper), c.getBalance(r.treasury), c.getAccountInfo(pid),
  ]);
  const uploader = existsSync(resolve(mode.keysDir, "uploader.json")) ? await c.getBalance(loadKey(mode, "uploader").publicKey) : 0;
  const bufferAcc = existsSync(resolve(mode.keysDir, "buffer.json")) ? await c.getAccountInfo(loadKey(mode, "buffer").publicKey) : null;
  const px = await fetchSolUsd(c, pythPriceFeedAccount()).catch(() => null);
  if (!px && !mode.rehearsal) bad("Pyth SOL/USD unreadable: can't price the smoke tests");
  const usd = px ? Number(px.price) * 10 ** px.expo : 200; // rehearsal without an oracle only
  const lamportsFor = (dollars: number) => BigInt(Math.ceil((dollars / usd) * 1e9));
  const budget = launchBudget({
    soBytes, rent, launchBalance: BigInt(launchBal), keeperBalance: BigInt(keeperBal), uploaderBalance: BigInt(uploader), treasuryBalance: BigInt(treasuryBal),
    openBufferLamports: BigInt(bufferAcc?.lamports ?? 0),
    solBuyLamports: (lamportsFor(100) * 103n) / 100n, tokenBuyLamports: (lamportsFor(90) * 110n) / 100n, // $100 block + slippage; $90 of tokens + fees + impact
    deployed: !!programAcc, initialized: !!st.steps.init,
  });
  console.log("launch wallet (the coin isn't in this budget: the owner launches it on pump.fun with their own wallet)");
  for (const l of budget.lines) console.log(`  ${sol(l.lamports).padStart(9)} SOL  ${l.item}`);
  console.log(`  ${sol(budget.peakAtDeploy).padStart(9)} SOL  PEAK while deploying`);
  console.log(`  ${sol(budget.net).padStart(9)} SOL  net cost after the buffer refund`);
  console.log(`  ${sol(budget.smokeReserve).padStart(9)} SOL  smoke tests at $${usd.toFixed(2)}/SOL: one 1x1 SOL buy + a market buy for one 1x1 token payment (both optional)`);
  console.log(`  ${sol(launchBal).padStart(9)} SOL  launch wallet balance (budget ${sol(LAUNCH_BUDGET_LAMPORTS)})`);
  console.log(`  ${sol(budget.spare).padStart(9)} SOL  left after everything`);
  budget.fits ? ok(`launch budget fits, ${sol(budget.spare)} SOL spare`) : bad(`launch budget does NOT fit: peak ${sol(budget.peakAtDeploy)}, net + smoke ${sol(budget.net + budget.smokeReserve)}, wallet ${sol(launchBal)}`);

  console.log("\ndeployment state");
  if (programAcc) {
    const pd = await c.getAccountInfo(programDataAddress(pid));
    const auth = pd ? parseProgramData(pd.data).authority : null;
    auth?.equals(r.launch) ? ok(`program deployed, upgrade authority is the launch wallet`) : bad(`program exists but upgrade authority is ${auth?.toBase58() ?? "none"}`);
  } else ok(`program ${pid.toBase58()} not deployed yet`);
  console.log(`  steps done: ${Object.keys(st.steps).join(", ") || "none"}`);

  console.log("\nexternal programs");
  for (const [n, k] of [["pump", PUMP_PROGRAM_ID], ["PumpSwap", PUMP_AMM_PROGRAM_ID]] as const) {
    const a = await c.getAccountInfo(k);
    a?.executable ? ok(`${n} ${k.toBase58()}`) : bad(`${n} not found`);
  }
  try {
    const px = await fetchSolUsd(c, pythPriceFeedAccount());
    const age = Math.floor(Date.now() / 1000) - Number(px.publishTime);
    age < 180 ? ok(`Pyth SOL/USD fresh (${age}s old)`) : warn(`Pyth SOL/USD is ${age}s old`);
  } catch (e) { (mode.rehearsal ? warn : bad)(`Pyth SOL/USD unreadable: ${(e as Error).message}`); }

  console.log("\npump (the owner launches the coin on pump.fun; this only checks what init will rely on)");
  try {
    const global = await new OnlinePumpSdk(c).fetchGlobal();
    console.log(`  --    Global: initial virtual reserves ${global.initialVirtualSolReserves} lamports / ${global.initialVirtualTokenReserves} base units, supply ${global.tokenTotalSupply}`);
    global.tokenTotalSupply.toString() === TOKEN_INITIAL_SUPPLY ? ok(`new coins mint ${TOKEN_INITIAL_SUPPLY} base units`) : bad(`pump Global supply is ${global.tokenTotalSupply}: TOKEN_INITIAL_SUPPLY needs review`);
  } catch (e) { bad(`pump read failed: ${(e as Error).message}`); }
  finish();

  function finish() {
    console.log(`\n${problems.length ? `NO-GO: ${problems.length} problem(s)` : "GO"}${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
    process.exit(problems.length ? 1 : 0);
  }
});
