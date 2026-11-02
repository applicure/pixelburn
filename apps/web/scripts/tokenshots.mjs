// Token-payment states (mock overrides): node scripts/tokenshots.mjs <base>
import { chromium } from "playwright";
const base = process.argv[2] || "http://localhost:3200";
const b = await chromium.launch({ args: ["--use-gl=angle"] });
const out = [];
const errs = [];
for (const [label, vw, vh, dsf] of [["desktop", 1440, 900, 1], ["mobile", 390, 844, 2]]) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dsf, isMobile: label === "mobile", hasTouch: label === "mobile" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(e.message));
  const sheet = async (q, name, pickToken = false) => {
    await p.goto(`${base}/canvas?select=1&w=8&h=5&${q}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(2200);
    await p.getByRole("button", { name: "Buy these blocks" }).click();
    await p.waitForTimeout(1400);
    if (pickToken) {
      await p.getByRole("radio", { name: /10% off/ }).click();
      await p.waitForTimeout(900);
    }
    const f = `screens/token-${name}-${label}.png`;
    await p.screenshot({ path: f });
    out.push(f);
  };
  await sheet("tokenStatus=hourly_cap&tokenBlocks=24", "sheet-hourly-cap");
  await sheet("tokenBlocks=0", "sheet-cap-exhausted");
  await sheet("tokenStatus=deviation", "sheet-deviation");
  await sheet("tokenStatus=warming_up", "sheet-warming-up");
  await sheet("pricedBy=slow_ema", "sheet-slow-ema", true);
  await p.goto(`${base}/?tokenStatus=deviation`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await p.evaluate(() => document.querySelector('[aria-labelledby="token-title"]')?.scrollIntoView());
  await p.waitForTimeout(1800);
  const box = await p.evaluate(() => { const r = document.querySelector('[aria-labelledby="token-title"] .bg-soot')?.getBoundingClientRect(); return r ? r.top : 0; });
  await p.evaluate((t) => window.scrollBy(0, t - 80), box);
  await p.waitForTimeout(1200);
  const f = `screens/token-landing-deviation-${label}.png`;
  await p.screenshot({ path: f });
  out.push(f);
  await ctx.close();
}
console.log(out.map((f) => process.cwd() + "/" + f).join("\n"));
console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close();
