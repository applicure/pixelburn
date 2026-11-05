/**
 * Tops up from the launch wallet to fixed targets, so a re-run never double-pays: keeper float, Arweave uploader float (creates
 * keys/mainnet/uploader.json if absent), treasury rent-exemption. One transaction; dry run simulates it.
 * Never touches the creator wallet: the owner funds that one directly.
 *   node mainnet-fund.ts [--execute --mainnet-i-understand]
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { existsSync } from "node:fs";
import { KEEPER_FLOAT_LAMPORTS, UPLOADER_FLOAT_LAMPORTS, buildTx, connect, ensureKey, explorer, keypath, loadKey, main, markStep, parseArgs, priorityMicroLamports, roles, runMode, sendAndConfirm, simulate, sol } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const { connection: c, label } = await connect(mode);
  const r = roles(mode);
  const uploader = mode.execute ? ensureKey(mode, "uploader").pubkey : existsSync(keypath(mode, "uploader")) ? loadKey(mode, "uploader").publicKey : null;
  console.log(`cluster   ${label}\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN"}`);
  const targets: [string, PublicKey | null, bigint][] = [
    ["keeper", r.keeper, KEEPER_FLOAT_LAMPORTS],
    ["uploader", uploader, UPLOADER_FLOAT_LAMPORTS],
    ["treasury", r.treasury, BigInt(await c.getMinimumBalanceForRentExemption(0))],
  ];
  const ixs: TransactionInstruction[] = [];
  for (const [name, to, target] of targets) {
    if (!to) { console.log(`  uploader: key is created on --execute, then topped up to ${sol(target)}`); continue; }
    const have = BigInt(await c.getBalance(to));
    const need = target > have ? target - have : 0n;
    console.log(`  ${name.padEnd(9)} ${to.toBase58()} has ${sol(have)}, target ${sol(target)}, send ${sol(need)}`);
    if (need > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: r.launch, toPubkey: to, lamports: need }));
  }
  if (!ixs.length) { console.log("nothing to do"); if (mode.execute) markStep(mode, "fund"); return; }
  const { tx, lastValidBlockHeight } = await buildTx(c, r.launch, ixs, { units: 5_000, microLamports: await priorityMicroLamports(c) });
  const sim = await simulate(c, tx);
  console.log(`simulate  ${sim.ok ? "ok" : `ERR ${JSON.stringify(sim.err)}`}`);
  if (!sim.ok) throw new Error(sim.logs.slice(-4).join(" | "));
  if (!mode.execute) { console.log("DRY RUN: nothing sent"); return; }
  const sig = await sendAndConfirm(c, tx, lastValidBlockHeight, [loadKey(mode, "launch")]);
  markStep(mode, "fund", { sig });
  console.log(`funded ${explorer(mode, "tx", sig)}`);
});
