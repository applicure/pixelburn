/**
 * Thin runner for everything that happens BEFORE the coin exists. Each step checks chain state itself and is safe to re-run, so a crash just
 * means running the same command again; finished steps are skipped by the state file (chain/.mainnet-state.json, no secrets).
 *
 *   node mainnet-launch.ts                                            dry run of everything (continues past failures, reports them)
 *   node mainnet-launch.ts --through <step> --execute --mainnet-i-understand
 *   node mainnet-launch.ts --status
 * Other options: [--only <step>] [--redo <step>] [--allow-unverifiable-build]
 *
 * Steps: preflight build fund keeper-alt deploy verify-deploy env
 * It stops there and reports READY: the owner then launches the coin on pump.fun and gives the mint to mainnet-init.ts, which isn't a step here
 * on purpose. Neither are the graduation watcher, the smoke tests and the registry. Runbook: docs/mainnet-cutover.md
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { die, here, main, parseArgs, readState, runMode, strArg } from "./mainnet-lib.ts";

const STEPS: { name: string; file: string; sub?: string; pass?: string[]; alwaysRun?: boolean }[] = [
  { name: "preflight", file: "mainnet-preflight.ts", alwaysRun: true },
  { name: "build", file: "mainnet-build.ts", pass: ["allow-unverifiable-build"] },
  { name: "fund", file: "mainnet-fund.ts" },
  { name: "keeper-alt", file: "mainnet-keeper-alt.ts" },
  { name: "deploy", file: "mainnet-deploy.ts" },
  { name: "verify-deploy", file: "mainnet-verify.ts", sub: "deploy" },
  { name: "env", file: "mainnet-env.ts", alwaysRun: true },
];

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const st = readState(mode);
  if (args.has("status")) {
    for (const s of STEPS) console.log(`${(st.steps[s.name] ? "done" : "todo").padEnd(5)} ${s.name}${st.steps[s.name] ? `  ${st.steps[s.name]!.at}` : ""}`);
    console.log(st.steps["verify-deploy"] ? "READY for the owner's coin launch" : "not ready yet");
    return;
  }
  const through = strArg(args, "through"), only = strArg(args, "only"), redo = strArg(args, "redo");
  if (mode.execute && !through && !only) die("--execute needs --through <step> or --only <step>: decide how far this run goes");
  for (const n of [through, only, redo]) if (n && !STEPS.some((s) => s.name === n)) die(`unknown step ${n}`);
  console.log(`runner: ${mode.rehearsal ? "REHEARSAL" : "MAINNET"} ${mode.execute ? "EXECUTE" : "DRY RUN"}`);
  const failed: string[] = [];
  for (const s of STEPS) {
    if (only && s.name !== only) continue;
    if (st.steps[s.name] && !s.alwaysRun && redo !== s.name && mode.execute) { console.log(`\n=== ${s.name}: done at ${st.steps[s.name]!.at}, skipped`); if (through === s.name) break; continue; }
    console.log(`\n=== ${s.name}`);
    const flags: string[] = [];
    for (const f of ["execute", "mainnet-i-understand", "rehearsal"]) if (args.has(f)) flags.push(`--${f}`);
    for (const p of s.pass ?? []) {
      const v = args.get(p);
      if (v === true) flags.push(`--${p}`);
      else if (v !== undefined) flags.push(`--${p}`, v);
    }
    const r = spawnSync("node", [resolve(here, s.file), ...(s.sub ? [s.sub] : []), ...flags], { stdio: "inherit", cwd: here });
    if (r.status !== 0) {
      failed.push(s.name);
      if (mode.execute) { console.error(`\nstep ${s.name} FAILED. Fix it and run the same command again: finished steps are skipped.`); process.exit(1); }
      console.log(`(dry run continues; ${s.name} reported a problem)`);
    }
    if (through === s.name) break;
  }
  const after = readState(mode);
  if (failed.length) { console.log(`\nDry run finished with problems in: ${failed.join(", ")}`); process.exit(1); }
  console.log(after.steps["verify-deploy"] ? "\nREADY: program deployed and hash-checked. Do the pre-launch switch, start the graduation watcher, then the owner launches the coin." : `\n${mode.execute ? "Run" : "Dry run"} finished.`);
});
