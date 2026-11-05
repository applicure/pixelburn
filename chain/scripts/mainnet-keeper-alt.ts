/**
 * Pre-creates the keeper's address lookup table, so KEEPER_LOOKUP_TABLE can be pinned from the first deploy. On mainnet the keeper never
 * scans for its table, and without a pin each restart would create (and pay for) a new one. Idempotent via the state file.
 *   node mainnet-keeper-alt.ts [--execute --mainnet-i-understand]
 */
import { AddressLookupTableProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { buildTx, connect, explorer, loadKey, main, parseArgs, priorityMicroLamports, readState, redact, roles, runMode, sendAndConfirm, simulate, writeState } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  const { connection: c, label } = await connect(mode);
  const r = roles(mode);
  console.log(`cluster   ${label}\nmode      ${mode.execute ? "EXECUTE" : "DRY RUN"}\nauthority ${r.keeper.toBase58()} (keeper)`);
  const st = readState(mode);
  if (st.keeperLookupTable && (await c.getAccountInfo(new (await import("@solana/web3.js")).PublicKey(st.keeperLookupTable)))) {
    console.log(`already created: KEEPER_LOOKUP_TABLE=${st.keeperLookupTable}`);
    return;
  }
  const hashes = await c.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY);
  if (!hashes) throw new Error("SlotHashes unreadable");
  if ((await c.getBalance(r.keeper)) === 0 && !mode.execute) { console.log("keeper isn't funded yet: run mainnet-fund first. DRY RUN: nothing sent"); return; }
  for (const entry of [4, 8, 16, 32]) {
    const recentSlot = hashes.data.readBigUInt64LE(8 + 40 * entry);
    const [ix, addr] = AddressLookupTableProgram.createLookupTable({ authority: r.keeper, payer: r.keeper, recentSlot });
    const { tx, lastValidBlockHeight } = await buildTx(c, r.keeper, [ix], { units: 10_000, microLamports: await priorityMicroLamports(c) });
    const sim = await simulate(c, tx);
    console.log(`simulate  ${sim.ok ? "ok" : `ERR ${JSON.stringify(sim.err)}`} (recent slot entry ${entry})`);
    if (!sim.ok) continue;
    if (!mode.execute) { console.log(`DRY RUN: nothing sent`); return; }
    try {
      const sig = await sendAndConfirm(c, tx, lastValidBlockHeight, [loadKey(mode, "keeper")]);
      const s = readState(mode);
      s.keeperLookupTable = addr.toBase58();
      s.steps["keeper-alt"] = { at: new Date().toISOString(), sig };
      writeState(mode, s);
      console.log(`KEEPER_LOOKUP_TABLE=${addr.toBase58()}  ${explorer(mode, "tx", sig)}`);
      return;
    } catch (e) { console.log(`create failed, trying an older slot: ${redact((e as Error).message)}`); }
  }
  throw new Error("lookup table create failed for every recent slot tried");
});
