/**
 * Builds the mainnet .so from a clean `git archive` export of HEAD and records its hash. Local only: no RPC, no transactions. chain/keys never enters
 * the build, and target/deploy here stays the devnet build; the mainnet binary lives in target/mainnet/pixel.so.
 *
 *   node mainnet-build.ts                                     # dry run: says what it would do, re-checks an earlier build
 *   node mainnet-build.ts --execute --mainnet-i-understand    # solana-verify build (Docker, reproducible)
 *   ... --allow-unverifiable-build                            # without Docker: cargo build-sbf. It can't be verified against the repo.
 */
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { BASE_IMAGE, DEVNET_PROGRAM_ID, chainDir, die, hasCommand, main, parseArgs, programId, readState, redact, repoDir, runMode, sha256File, writeState } from "./mainnet-lib.ts";

const docker = () => { try { execSync("docker info", { stdio: "ignore", timeout: 15_000 }); return true; } catch { return false; } };

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const pid = programId(mode);
  const out = resolve(chainDir, "target/mainnet/pixel.so");
  const st = readState(mode);
  const reproducible = docker() && hasCommand("solana-verify") && !mode.rehearsal;
  console.log(`Docker + solana-verify available: ${reproducible ? "yes, reproducible build" : "NO: a reproducible build isn't possible on this machine right now"}`);

  const check = async (path: string) => {
    const data = readFileSync(path);
    if (!data.includes(pid.toBuffer())) die(`${path} doesn't embed the mainnet id ${pid.toBase58()}`);
    if (data.includes(new PublicKey(DEVNET_PROGRAM_ID).toBuffer())) die(`${path} embeds the devnet id`);
    if (!data.includes(Buffer.from("github.com/applicure/pixelburn"))) die(`${path} has no source_code in security.txt`);
    return { sha256: await sha256File(path), bytes: statSync(path).size };
  };

  if (!mode.execute) {
    if (st.build && existsSync(st.build.path)) {
      const { sha256 } = await check(st.build.path);
      console.log(`earlier build: ${st.build.path.replace(`${repoDir}/`, "")} ${st.build.bytes} B, sha256 ${sha256} ${sha256 === st.build.sha256 ? "(matches the record)" : "(DOES NOT MATCH THE RECORD)"}, commit ${st.build.commit.slice(0, 10)}, verifiable: ${st.build.verifiable}`);
      if (sha256 !== st.build.sha256) process.exit(1);
    }
    console.log("DRY RUN: nothing built. It would run: " + (reproducible ? `solana-verify build <chain dir> --library-name pixel --base-image ${BASE_IMAGE} -- --features mainnet` : "(refuses without --allow-unverifiable-build) cargo build-sbf --features mainnet"));
    return;
  }
  const dirty = execSync("git status --porcelain -- chain/programs chain/Cargo.lock chain/Cargo.toml chain/Anchor.toml chain/rust-toolchain.toml", { cwd: repoDir, encoding: "utf8" }).trim();
  if (dirty && !mode.rehearsal) die(`uncommitted program sources:\n${dirty}`);
  const allowUnverifiable = args.has("allow-unverifiable-build") || mode.rehearsal;
  if (!reproducible && !allowUnverifiable) die("Docker or solana-verify is unavailable. Start Docker, or accept an unverifiable build with --allow-unverifiable-build");

  // Build from a clean export of the commit: only tracked files, so chain/keys never enters the container, and target/deploy here stays the devnet build.
  const verifiableRun = reproducible && !args.has("allow-unverifiable-build");
  const tmp = mkdtempSync(resolve(realpathSync(tmpdir()), "pixel-mainnet-build-"));
  try {
    execSync(`git archive HEAD chain | tar -x -C ${JSON.stringify(tmp)}`, { cwd: repoDir, shell: "/bin/sh", stdio: ["ignore", "ignore", "inherit"] });
    const exportDir = resolve(tmp, "chain");
    if (existsSync(resolve(exportDir, "keys"))) die("the export contains chain/keys: refusing to build");
    const [cmd, cargs] = verifiableRun
      ? ["solana-verify", ["build", exportDir, "--library-name", "pixel", "--base-image", BASE_IMAGE, "--", "--features", "mainnet"]] as const
      : ["cargo", ["build-sbf", "--features", "mainnet"]] as const;
    console.log(`running: ${cmd} ${cargs.join(" ")}`);
    const r = spawnSync(cmd, [...cargs], { cwd: exportDir, stdio: "inherit" });
    if (r.status !== 0) die(`${cmd} failed`);
    mkdirSync(resolve(chainDir, "target/mainnet"), { recursive: true });
    copyFileSync(resolve(exportDir, "target/deploy/pixel.so"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const { sha256, bytes } = await check(out);
  const commit = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
  const verifiable = verifiableRun;
  const next = readState(mode);
  next.build = { sha256, bytes, commit, verifiable, path: out };
  next.steps.build = { at: new Date().toISOString(), sha256, commit };
  writeState(mode, next);
  console.log(redact(`built ${bytes} B, sha256 ${sha256}, commit ${commit.slice(0, 10)}, verifiable: ${verifiable}`));
  if (!verifiable) console.log("WARNING: this binary won't match a repo verification. The explorer can't show it as verified.");
});
