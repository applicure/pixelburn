/**
 * Devnet only: create a real pump.fun coin (create_v2, Token-2022, 1B supply, 6 decimals) and buy some of it in the
 * same transaction, so the pixel program has a live bonding curve to price against.
 *
 *   node pump-devnet.ts             # DRY RUN: builds create+buy and SIMULATES it (sigVerify off), sends nothing
 *   node pump-devnet.ts --execute   # sends (spends devnet SOL); saves the mint keypair to ../keys/pump-mint.json
 *
 * Env: DEVNET_RPC_URL / SOLANA_RPC_HELIUS_KEY (devnet; SOLANA_RPC is ignored), genesis-hash guarded, CREATOR_KEYPAIR (default ../keys/admin.json),
 *      BUY_SOL (default 0.5), NAME, SYMBOL, URI. Never prints RPC URLs or keys.
 * Uses @pump-fun/pump-sdk 4.3.1 (official) for the instruction lists.
 */
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { devnetConnection, redact } from "./devnet-rpc.ts";
import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const keysDir = resolve(here, "../keys");

// Short inline data: URI as the description (nothing to host; a JSON URI makes the create+buy tx exceed 1232 bytes).
const DEFAULT_URI = "data:,Devnet test token, no value";
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

async function main() {
  const { connection, label } = await devnetConnection(); // exits unless devnet
  const creatorPath = process.env.CREATOR_KEYPAIR ?? resolve(keysDir, "admin.json");
  const creator = existsSync(creatorPath) ? load(creatorPath) : Keypair.generate();
  const mintPath = resolve(keysDir, "pump-mint.json");
  const mint = existsSync(mintPath) ? load(mintPath) : Keypair.generate();
  const buySol = new BN(Math.round(Number(process.env.BUY_SOL ?? "0.5") * LAMPORTS_PER_SOL));

  const online = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null)]);
  const amount = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: null, bondingCurve: null, amount: buySol,
    quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
  });
  const ixs = await PUMP_SDK.createV2AndBuyInstructions({
    global, mint: mint.publicKey, name: process.env.NAME ?? "Pixel Burn DEVNET TEST", symbol: process.env.SYMBOL ?? "PXTEST",
    uri: process.env.URI ?? DEFAULT_URI, creator: creator.publicKey, user: creator.publicKey,
    amount, solAmount: buySol, mayhemMode: false,
  });
  const curve = bondingCurvePda(mint.publicKey);
  console.log(`mode     ${EXECUTE ? "EXECUTE" : "DRY RUN (simulate only)"}`);
  console.log(`rpc      ${label}`);
  console.log(`creator  ${creator.publicKey.toBase58()}${existsSync(creatorPath) ? "" : " (ephemeral: no keypair file yet)"}`);
  console.log(`mint     ${mint.publicKey.toBase58()} (Token-2022, pump create_v2)`);
  console.log(`curve    ${curve.toBase58()}  -> PRICE_SOURCE=curve:${curve.toBase58()} MINT=${mint.publicKey.toBase58()}`);
  console.log(`buy      ${Number(buySol) / 1e9} SOL -> ~${amount.toString()} base units`);

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs] }).compileToV0Message(); // create+buy ~220k CU
  const tx = new VersionedTransaction(msg);
  if (!EXECUTE) {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`simulate ${sim.value.err ? `ERR ${JSON.stringify(sim.value.err)}` : "OK"} (CU ${sim.value.unitsConsumed})`);
    if (sim.value.err) console.log((sim.value.logs ?? []).slice(-8).join("\n"));
    return;
  }
  mkdirSync(keysDir, { recursive: true });
  if (!existsSync(mintPath)) writeFileSync(mintPath, JSON.stringify(Array.from(mint.secretKey)), { mode: 0o600 });
  tx.sign([creator, mint]);
  const sig = await connection.sendTransaction(tx);
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`sent ${sig}`);
}

main().catch((e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  console.error(redact(m));
  process.exit(1);
});
