// Launch-day (empty) states + the switch to normal: node scripts/emptyshots.mjs <base>
import { chromium } from "playwright";
const base = process.argv[2] || "http://localhost:3200";
const b = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const out = [];
const errs = [];
const at = async (p, sel, off = -20) => {
  await p.evaluate(([s, o]) => { const el = document.querySelector(s); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY + o, behavior: "instant" }); }, [sel, off]);
  await p.waitForTimeout(1600);
};
for (const [label, vw, vh, dsf] of [["desktop", 1440, 900, 1], ["mobile", 390, 844, 2]]) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dsf, isMobile: label === "mobile", hasTouch: label === "mobile" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(e.message));
  const shot = async (n) => { const f = `screens/empty-${n}-${label}.png`; await p.screenshot({ path: f }); out.push(f); };
  await p.goto(`${base}/?empty=1`, { waitUntil: "networkidle" });
  await p.waitForTimeout(5500);
  await shot("hero");
  await at(p, '[aria-labelledby="flow-title"]', 40); await p.waitForTimeout(1500); await shot("moneyflow");
  await at(p, '[aria-labelledby="live-title"]'); await shot("live");
  await at(p, '[aria-labelledby="auction-title"]'); await shot("auction-teaser");
  await p.goto(`${base}/burns?empty=1`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2200); await shot("burns");
  await at(p, '[aria-labelledby="curve-title"]'); await shot("burns-curve");
  await at(p, '[aria-labelledby="bb-title"]'); await shot("burns-buybacks");
  await p.goto(`${base}/canvas?empty=1`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2000); await shot("canvas");
  await p.goto(`${base}/auction?empty=1`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2000); await shot("auction");
  // the switch: start empty, let the first mock purchases land
  await p.goto(`${base}/?empty=1&live=1`, { waitUntil: "networkidle" });
  await p.waitForTimeout(13000);
  await shot("after-first-buys-hero");
  await at(p, '[aria-labelledby="live-title"]'); await shot("after-first-buys-live");
  await ctx.close();
}
console.log(out.map((f) => process.cwd() + "/" + f).join("\n"));
console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close();
