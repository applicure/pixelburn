/**
 * Deploys target/mainnet/pixel.so in two resumable stages through a named buffer (keys/mainnet/buffer.json):
 *   1. write-buffer. Re-running only writes chunks that differ, so a crash halfway costs nothing but the fees already paid.
 *   2. deploy from the buffer with --max-len (.so + 25%). This closes the buffer and refunds its rent to the launch wallet atomically.
 * Before stage 2 the buffer's bytes are compared with the .so. After it, the on-chain program is hash-checked (mainnet-verify.ts deploy).
 *
 *   node mainnet-deploy.ts [--execute --mainnet-i-understand]
 *   node mainnet-deploy.ts --close-buffer [--execute --mainnet-i-understand]   # abandon a partial deploy, refund the buffer
 */
import { PublicKey } from "@solana/web3.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { BUFFER_HEADER, DEVNET_PROGRAM_ID, connect, die, ensureKey, explorer, keypath, loadKey, main, markStep, maxLenFor, parseArgs, priorityMicroLamports, programDataAddress, parseProgramData, programId, readState, repoDir, roles, runMode, sha256File, sleep, solanaCli, sol } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const { connection: c, url, label } = await connect(mode);
  const pid = programId(mode);
  const r = roles(mode);
  const st = readState(mode);
  console.log(`cluster   ${label}\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN"}\nprogram   ${pid.toBase58()}`);
  if (loadKey(mode, "program").publicKey.toBase58() !== pid.toBase58()) die("program.json doesn't match the declared id");
  const launchPath = keypath(mode, "launch");

  const bufferExists = existsSync(keypath(mode, "buffer"));
  const bufferPk: PublicKey | null = bufferExists ? loadKey(mode, "buffer").publicKey : null;
  const bufferAcc = bufferPk ? await c.getAccountInfo(bufferPk) : null;

  if (args.has("close-buffer")) {
    if (!bufferAcc || !bufferPk) { console.log("no open buffer to close"); return; }
    console.log(`would close buffer ${bufferPk.toBase58()}, refund ${sol(bufferAcc.lamports)} SOL to the launch wallet`);
    if (!mode.execute) { console.log("DRY RUN"); return; }
    solanaCli(url, ["program", "close", bufferPk.toBase58(), "--recipient", r.launch.toBase58(), "--authority", launchPath, "--keypair", launchPath, "--bypass-warning"]);
    return;
  }

  const prog = await c.getAccountInfo(pid);
  if (prog) {
    const pd = await c.getAccountInfo(programDataAddress(pid));
    const auth = pd ? parseProgramData(pd.data).authority : null;
    if (!auth?.equals(r.launch)) die(`program exists with authority ${auth?.toBase58() ?? "none"}`);
    console.log("already deployed, upgrade authority is the launch wallet");
    if (bufferAcc) console.log(`note: buffer ${bufferPk!.toBase58()} is still open; --close-buffer refunds it`);
    if (mode.execute) markStep(mode, "deploy", { program: pid.toBase58() });
    return;
  }

  if (!st.build) { if (mode.execute) die("no build recorded: run mainnet-build first"); console.log("no build recorded yet; run mainnet-build first"); return; }
  const so = readFileSync(st.build.path);
  // The id in the actual binary decides, not the source: a default build at this address would fail every call, with the rent already spent.
  if (!so.includes(pid.toBuffer())) die(`${st.build.path} doesn't embed ${pid.toBase58()}: rebuild with mainnet-build (--features mainnet)`);
  if (so.includes(new PublicKey(DEVNET_PROGRAM_ID).toBuffer())) die(`${st.build.path} embeds the devnet program id: refusing to deploy`);
  if ((await sha256File(st.build.path)) !== st.build.sha256) die(`${st.build.path} no longer matches the recorded build hash: rebuild`);
  // A stale binary can't deploy: what's on chain must be what the commit says.
  const head = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
  const dirty = execSync("git status --porcelain -- chain/programs chain/Cargo.lock chain/Cargo.toml", { cwd: repoDir, encoding: "utf8" }).trim();
  const stale = st.build.commit !== head ? `the build is from ${st.build.commit.slice(0, 10)} but HEAD is ${head.slice(0, 10)}: rebuild (mainnet-launch.ts --only build --redo build)` : dirty ? `chain/programs has uncommitted changes:\n${dirty}` : null;
  if (stale) { if (mode.execute) die(stale); console.log(`would refuse: ${stale}`); }
  // A partial buffer from a different build: the CLI would keep its trailing bytes, and they'd end up in the program.
  if (bufferAcc && bufferAcc.data.length !== BUFFER_HEADER + so.length) {
    const m = `buffer ${bufferPk!.toBase58()} holds ${bufferAcc.data.length - BUFFER_HEADER} B but this .so is ${so.length} B. Run mainnet-deploy.ts --close-buffer (refunds it), then re-run.`;
    if (mode.execute) die(m);
    console.log(`would refuse: ${m}`);
  }
  const maxLen = maxLenFor(so.length);
  const micro = await priorityMicroLamports(c);
  console.log(`so        ${so.length} B, sha256 ${st.build.sha256}, verifiable: ${st.build.verifiable}\nmax-len   ${maxLen}\npriority  ${micro} microLamports/CU`);
  if (bufferAcc) console.log(`resuming: buffer ${bufferPk!.toBase58()} exists (${bufferAcc.data.length} B)`);
  if (!mode.execute) {
    console.log("DRY RUN: would run\n  solana program write-buffer <so> --buffer keys/buffer.json --use-rpc\n  solana program deploy --buffer <buffer> --program-id keys/program.json --upgrade-authority keys/launch.json --max-len " + maxLen);
    return;
  }
  const buffer = ensureKey(mode, "buffer").pubkey;
  const writeBuf = ["program", "write-buffer", st.build.path, "--buffer", keypath(mode, "buffer"), "--buffer-authority", launchPath, "--keypair", launchPath, "--use-rpc", "--with-compute-unit-price", String(micro), "--max-sign-attempts", "20"];
  const complete = bufferAcc && Buffer.compare(bufferAcc.data.subarray(BUFFER_HEADER, BUFFER_HEADER + so.length), so) === 0;
  if (complete) console.log("buffer is already complete: skipping the write");
  else solanaCli(url, writeBuf);
  // An RPC can lag the validator the CLI just wrote through.
  let onchain = await c.getAccountInfo(buffer);
  for (let i = 0; i < 15 && (!onchain || onchain.data.length < BUFFER_HEADER + so.length); i++) { await sleep(2_000); onchain = await c.getAccountInfo(buffer); }
  if (!onchain) die("buffer missing after write-buffer");
  const written = onchain.data.subarray(BUFFER_HEADER);
  if (Buffer.compare(written.subarray(0, so.length), so) !== 0) die("buffer content differs from the .so: re-run to rewrite the differing chunks");
  console.log("buffer content equals the .so");

  const out = solanaCli(url, ["program", "deploy", "--buffer", keypath(mode, "buffer"), "--program-id", keypath(mode, "program"), "--upgrade-authority", launchPath, "--keypair", launchPath, "--max-len", String(maxLen), "--with-compute-unit-price", String(micro), "--use-rpc", "--max-sign-attempts", "20"]);
  const sig = /Signature: (\S+)/.exec(out)?.[1];
  markStep(mode, "deploy", { sig, program: pid.toBase58() });
  console.log(`deployed ${explorer(mode, "address", pid.toBase58())}`);
});
