// Exits 0 only if the .so embeds this program id and not the other deployment's. usage: node check-so-id.mjs <so> <id> [<forbiddenId>]
// A devnet upgrade with a mainnet-feature build (or the reverse) would otherwise brick the program: every call fails DeclaredProgramIdMismatch.
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
const [so, id, forbidden] = process.argv.slice(2);
const data = readFileSync(so);
const has = (k) => data.includes(new PublicKey(k).toBuffer());
if (!has(id)) { console.error(`REFUSING: ${so} does not embed program id ${id}`); process.exit(1); }
if (forbidden && has(forbidden)) { console.error(`REFUSING: ${so} embeds the other deployment's id ${forbidden}`); process.exit(1); }
