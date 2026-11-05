/**
 * Creates the mainnet program keypair if absent (chain/keys/mainnet/program.json, gitignored, mode 600; never overwritten) and
 * syncs its PUBLIC key into the source: the feature-gated declare_id! in lib.rs, Anchor.toml [programs.mainnet], and the SDK's
 * cluster map in packages/sdk/src/constants.ts. Sends nothing, reads no RPC.
 *
 *   node mainnet-program-id.ts           # generate if absent, show what differs
 *   node mainnet-program-id.ts --sync    # also write the id into those three files
 *
 * Use this instead of `anchor keys sync`: that one rewrites the first declare_id! it finds, which here is the devnet one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEVNET_PROGRAM_ID, chainDir, die, ensureKey, main, parseArgs, repoDir, runMode } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  if (mode.rehearsal) die("the program id is the same in a rehearsal: run this without --rehearsal");
  const { pubkey, created } = ensureKey(mode, "program");
  const id = pubkey.toBase58();
  if (id === DEVNET_PROGRAM_ID) die("generated key equals the devnet program id");
  console.log(`program keypair ${created ? "CREATED" : "exists"}: chain/keys/mainnet/program.json`);
  console.log(`program id      ${id}`);

  const edits: { file: string; re: RegExp; to: string }[] = [
    { file: resolve(chainDir, "programs/pixel/src/lib.rs"), re: /(#\[cfg\(feature = "mainnet"\)\]\s*declare_id!\(")[^"]*("\))/, to: `$1${id}$2` },
    { file: resolve(chainDir, "Anchor.toml"), re: /(\[programs\.mainnet\]\s*pixel = ")[^"]*(")/, to: `$1${id}$2` },
    { file: resolve(repoDir, "packages/sdk/src/constants.ts"), re: /("mainnet-beta": new PublicKey\(")[^"]*("\))/, to: `$1${id}$2` },
  ];
  for (const e of edits) {
    const src = readFileSync(e.file, "utf8");
    if (!e.re.test(src)) die(`no program id slot found in ${e.file}`);
    const next = src.replace(e.re, e.to);
    if (next === src) { console.log(`in sync         ${e.file.replace(`${repoDir}/`, "")}`); continue; }
    if (args.has("sync")) { writeFileSync(e.file, next); console.log(`updated         ${e.file.replace(`${repoDir}/`, "")}`); }
    else console.log(`DIFFERS         ${e.file.replace(`${repoDir}/`, "")} (re-run with --sync)`);
  }
});
