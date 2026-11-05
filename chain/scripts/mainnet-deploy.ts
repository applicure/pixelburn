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
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { BUFFER_HEADER, connect, die, ensureKey, explorer, keypath, loadKey, main, markStep, maxLenFor, parseArgs, priorityMicroLamports, programDataAddress, parseProgramData, programId, readState, roles, runMode, solanaCli, sol } from "./mainnet-lib.ts";

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
  solanaCli(url, writeBuf);
  const onchain = await c.getAccountInfo(buffer);
  if (!onchain) die("buffer missing after write-buffer");
  const written = onchain.data.subarray(BUFFER_HEADER);
  if (Buffer.compare(written.subarray(0, so.length), so) !== 0) die("buffer content differs from the .so: re-run to rewrite the differing chunks");
  console.log("buffer content equals the .so");

  const out = solanaCli(url, ["program", "deploy", "--buffer", keypath(mode, "buffer"), "--program-id", keypath(mode, "program"), "--upgrade-authority", launchPath, "--keypair", launchPath, "--max-len", String(maxLen), "--with-compute-unit-price", String(micro), "--use-rpc", "--max-sign-attempts", "20"]);
  const sig = /Signature: (\S+)/.exec(out)?.[1];
  markStep(mode, "deploy", { sig, program: pid.toBase58() });
  console.log(`deployed ${explorer(mode, "address", pid.toBase58())}`);
});
