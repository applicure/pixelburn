// Waits (poll 60 s, max 2 h) for the deployer to be funded, then distributes the planned amounts.
// Proceeds early if >= 12 SOL; otherwise, once >= MIN and unchanged for 10 min (or at timeout), uses what is there.
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
const c = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(`../keys/${n}.json`, import.meta.url)))));
const deployer = kp("deployer");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEPLOY_RESERVE = 6.5, ADMIN = 1.5, KEEPER = 0.3, BUY_EACH = 1.15, FEES = 0.05;
const MIN = DEPLOY_RESERVE + ADMIN + KEEPER + BUY_EACH + FEES; // 9.5: deploy + one SOL test buy
const bal = async (k) => (await c.getBalance(k)) / LAMPORTS_PER_SOL;
const start = Date.now();
let last = -1, stableSince = Date.now();
for (;;) {
  const b = await bal(deployer.publicKey).catch(() => last);
  if (b !== last) { console.log(`${new Date().toISOString()} deployer balance ${b}`); last = b; stableSince = Date.now(); }
  if (b >= 12) break;
  if (b >= MIN && Date.now() - stableSince > Number(process.env.STABLE_MS ?? 10 * 60_000)) break;
  if (Date.now() - start > 2 * 3600_000) {
    if (b >= MIN) break;
    console.log(`TIMEOUT: deployer has ${b} SOL, need >= ${MIN}`);
    process.exit(2);
  }
  await sleep(60_000);
}
const b = await bal(deployer.publicKey);
const buyer = process.env.BUYER_SOL !== undefined ? Number(process.env.BUYER_SOL) : Math.min(3.5, Math.max(0, b - DEPLOY_RESERVE - ADMIN - KEEPER - FEES));
// buyer may already hold SOL (funded separately); SOL_BUYS overrides the derived count
const buys = process.env.SOL_BUYS ? Number(process.env.SOL_BUYS) : Math.floor((buyer - 0.02) / BUY_EACH);
const plan = { admin: ADMIN, keeper: KEEPER, buyer: Number(buyer.toFixed(3)) };
const tx = new Transaction();
for (const [n, sol] of Object.entries(plan))
  if (sol > 0) tx.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp(n).publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
const sig = await sendAndConfirmTransaction(c, tx, [deployer], { commitment: "confirmed" });
console.log(`distributed ${JSON.stringify(plan)}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
writeFileSync(new URL("../.devnet-plan.json", import.meta.url), JSON.stringify({ solBuys: Math.max(1, buys), distributeSig: sig, plan }));
const logUrl = new URL("../devnet-log.json", import.meta.url);
let arr = []; try { arr = JSON.parse(readFileSync(logUrl, "utf8")); } catch {}
arr.push({ step: "fund: deployer -> admin/keeper/buyer", sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`, at: new Date().toISOString(), plan });
writeFileSync(logUrl, JSON.stringify(arr, null, 2));
