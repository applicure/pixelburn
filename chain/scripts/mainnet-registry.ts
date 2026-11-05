/**
 * Post-launch: public proof that the deployed program is this repo at this commit.
 *   1. solana-verify rebuilds from the public repo at the recorded commit and compares with the on-chain hash (Docker).
 *   2. It writes the verification PDA, signed directly by the launch key (upgrade authority; there's no Squads).
 *   3. It submits the job to the OtterSec registry.
 * The repo must be public and the commit pushed.
 *   node mainnet-registry.ts [--execute --mainnet-i-understand]
 */
import { spawnSync } from "node:child_process";
import { REPO_URL, connect, die, hasCommand, keypath, main, markStep, parseArgs, programId, readState, redact, roles, runMode } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  if (mode.rehearsal) die("the registry only knows mainnet");
  const { url, label } = await connect(mode);
  const pid = programId(mode).toBase58();
  const st = readState(mode);
  const uploader = roles(mode).launch.toBase58();
  console.log(`cluster   ${label}\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN"}\nprogram   ${pid}\nrepo      ${REPO_URL}\ncommit    ${st.build?.commit ?? "(no build recorded)"}\nverifiable build: ${st.build?.verifiable ?? "n/a"}`);
  if (!hasCommand("solana-verify")) die("solana-verify isn't installed");
  const verifyArgs = (commit: string) => ["verify-from-repo", REPO_URL, "--url", url, "--program-id", pid, "--commit-hash", commit, "--library-name", "pixel", "--mount-path", "chain", "--keypair", keypath(mode, "launch"), "--skip-prompt", "--", "--features", "mainnet"];
  const show = (a: string[]) => a.map((x) => (x === url ? "<rpc>" : x)).join(" ");
  const submit = ["remote", "submit-job", "--url", url, "--program-id", pid, "--uploader", uploader];
  if (!mode.execute) {
    console.log(`would run:\n  solana-verify ${show(verifyArgs(st.build?.commit ?? "<commit>"))}\n  solana-verify ${show(submit)}`);
    const r = spawnSync("solana-verify", ["get-program-pda", "--url", url, "--program-id", pid, "--signer", uploader], { encoding: "utf8" });
    console.log(`verification PDA today: ${redact(`${r.stdout}${r.stderr}`).trim().split("\n").slice(-1)[0] || "none"}`);
    console.log("DRY RUN: nothing sent");
    return;
  }
  if (!st.build?.commit) die("no build recorded");
  if (!st.build.verifiable) die("the deployed build wasn't reproducible: the registry will not match it");
  const pushed = spawnSync("git", ["ls-remote", REPO_URL], { encoding: "utf8" });
  if (pushed.status !== 0) die("can't read the public repo");
  for (const a of [verifyArgs(st.build.commit), submit]) {
    console.log(`running: solana-verify ${show(a)}`);
    const r = spawnSync("solana-verify", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    console.log(redact(`${r.stdout}${r.stderr}`).split("\n").slice(-25).join("\n"));
    if (r.status !== 0) die("solana-verify failed");
  }
  markStep(mode, "registry", { commit: st.build.commit });
});
