// Copies the IDL + generated types from chain/target after `anchor build`.
import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const chain = resolve(here, "../../../chain/target");
copyFileSync(resolve(chain, "idl/pixel.json"), resolve(here, "../src/idl/pixel.json"));
copyFileSync(resolve(chain, "types/pixel.ts"), resolve(here, "../src/idl/pixel.ts"));
console.log("synced IDL from", chain);
