// Devnet airdrops with exponential backoff (public faucet only). Prints pubkeys + balances, never secrets.
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";
const c = new Connection("https://api.devnet.solana.com", "confirmed");
// genesis-hash guard (hardcoded devnet URL, belt and braces)
if ((await c.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") { console.error("REFUSING: not devnet"); process.exit(1); }
const targets = { deployer: 6.5, admin: 1.5, keeper: 0.3, buyer: 3.5 };
const pk = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(`../keys/${n}.json`, import.meta.url))))).publicKey;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_TRIES = Number(process.env.MAX_TRIES ?? 6);
for (const [name, want] of Object.entries(targets)) {
  const key = pk(name);
  let delay = 5_000;
  for (let i = 0; i < MAX_TRIES; i++) {
    const bal = (await c.getBalance(key)) / LAMPORTS_PER_SOL;
    if (bal >= want) break;
    const amt = Math.min(2, Math.ceil((want - bal) * 10) / 10);
    try {
      const sig = await c.requestAirdrop(key, Math.round(amt * LAMPORTS_PER_SOL));
      await c.confirmTransaction(sig, "confirmed");
      console.log(`${name} +${amt} ok`);
      delay = 5_000;
    } catch (e) {
      console.log(`${name} airdrop failed (${String(e.message ?? e).slice(0, 60)}), backoff ${delay / 1000}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 120_000);
    }
  }
}
for (const [name, want] of Object.entries(targets)) {
  const bal = (await c.getBalance(pk(name))) / LAMPORTS_PER_SOL;
  console.log(`${name} ${pk(name).toBase58()} balance ${bal} / need ${want}${bal < want ? `  MISSING ${(want - bal).toFixed(3)}` : ""}`);
}
