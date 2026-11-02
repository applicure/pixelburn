import { Connection } from "@solana/web3.js";
import { fetchConfig, parseEvents, readSpotPriceQ } from "@mpb/sdk";
const c = new Connection("https://api.devnet.solana.com", "confirmed");
for (const sig of process.argv.slice(2)) {
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) { console.log(sig, "not found"); continue; }
  const ev = parseEvents(tx.meta?.logMessages ?? []).map((e) => e.name === "BuybackBurned" ? `BuybackBurned lamportsIn=${e.data.lamportsIn} tokensBurned=${e.data.tokensBurned}` : e.name);
  const size = tx.transaction.message.serialize().length + 1 + 64 * tx.transaction.signatures.length;
  const alts = "addressTableLookups" in tx.transaction.message ? tx.transaction.message.addressTableLookups.map((l) => l.accountKey.toBase58()) : [];
  console.log(JSON.stringify({ sig: sig.slice(0, 12) + "…", slot: tx.slot, err: tx.meta?.err, sizeBytes: size, alts, cu: tx.meta?.computeUnitsConsumed, events: ev }));
}
const cfg = await fetchConfig(c);
const spot = await readSpotPriceQ(c, cfg.priceSource);
console.log(JSON.stringify({ now: new Date().toISOString().slice(11, 19), spotOverFastEma: (Number((spot * 1_000_000n) / cfg.tokenEmaPriceSol) / 1e6).toFixed(4), outstanding: cfg.buybackOutstandingLamports.toString() }));
