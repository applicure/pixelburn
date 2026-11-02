import { Connection } from "@solana/web3.js";
import { fetchConfig, readSpotPriceQ, tokenPricingStatus } from "@mpb/sdk";
const c = new Connection("https://api.devnet.solana.com", "confirmed");
const t0 = Date.now();
for (;;) {
  const cfg = await fetchConfig(c);
  const spot = await readSpotPriceQ(c, cfg.priceSource);
  const slot = await c.getSlot(); const chainNow = (await c.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const st = tokenPricingStatus(cfg, spot, chainNow, 1);
  console.log(new Date().toISOString().slice(11, 19), `warmup=${cfg.emaWarmupCranks}`, `spot/ema=${(Number(spot) / Number(cfg.tokenEmaPriceSol)).toFixed(3)}`, st.ok ? `OK pricedBy=${st.pricedBy}` : st.reason);
  if (st.ok) process.exit(0);
  if (Date.now() - t0 > 30 * 60_000) process.exit(3);
  await new Promise((r) => setTimeout(r, 30_000));
}
