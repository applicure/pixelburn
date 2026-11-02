// Production screenshots for review: node scripts/screens.mjs [base]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const base = process.argv[2] || "http://localhost:3200";
const out = resolve("screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const sizes = { desktop: [1440, 900], mobile: [390, 844] };
const logs = [];
const files = [];
const shot = async (page, name) => {
  const p = `${out}/${name}.png`;
  await page.screenshot({ path: p });
  files.push(p);
};

for (const [label, [w, h]] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: label === "mobile" ? 2 : 1, isMobile: label === "mobile", hasTouch: label === "mobile" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && logs.push(`${label} console: ${m.text().slice(0, 200)}`));

  // landing: hero + scroll frames
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(5200);
  await shot(page, `landing-${label}-00-hero`);
  const total = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  const marks = await page.evaluate(() => {
    const top = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().top + scrollY : 0; };
    const era = document.querySelector('[aria-labelledby="era-title"]');
    const eraTop = era ? era.getBoundingClientRect().top + scrollY : 0;
    const eraH = era ? era.offsetHeight - innerHeight : 0;
    return {
      era1: eraTop + eraH * 0.3,
      era2: eraTop + eraH * 0.6,
      era2b: eraTop + eraH * 0.74,
      era3: eraTop + eraH * 0.95,
      flow: top('[aria-labelledby="flow-title"]') + 40,
      token: top('[aria-labelledby="token-title"]') - 20,
      live: top('[aria-labelledby="live-title"]') - 20,
      auction: top('[aria-labelledby="auction-title"]') - 20,
      faq: top('[aria-labelledby="faq-title"]') - 20,
    };
  });
  const frames = [["01-2005", marks.era1], ["02-burning", marks.era2], ["02b-burning-late", marks.era2b], ["03-2026", marks.era3], ["04-moneyflow", marks.flow], ["05-pay-in-token", marks.token], ["06-live", marks.live], ["07-auction-teaser", marks.auction], ["08-faq", marks.faq], ["09-footer", total]];
  for (const [n, y] of frames) {
    await page.evaluate((p) => window.scrollTo({ top: p, behavior: "instant" }), Math.round(y));
    await page.waitForTimeout(n === "04-moneyflow" ? 3800 : 1700);
    await shot(page, `landing-${label}-${n}`);
  }

  for (const [route, name] of [["/burns", "burns"], ["/auction", "auction"], ["/auction?preview=live", "auction-live"]]) {
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2600);
    await shot(page, `${name}-${label}`);
  }
  // auction: bid through the wallet (demo wallet in mock mode)
  await page.goto(`${base}/auction?preview=live`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.fill("#bid", "900");
  await page.getByRole("button", { name: "Connect wallet to bid" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Use a demo wallet" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^Bid / }).click();
  await page.waitForTimeout(1800);
  await page.evaluate(() => document.querySelector("#bid")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await shot(page, `auction-live-${label}-bid-placed`);
  await page.goto(`${base}/burns`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('[aria-labelledby="curve-title"]')?.scrollIntoView());
  await page.waitForTimeout(1500);
  await shot(page, `burns-${label}-chart`);
  await page.evaluate(() => document.querySelector('[aria-labelledby="treasury-title"]')?.scrollIntoView());
  await page.waitForTimeout(1500);
  await shot(page, `burns-${label}-treasury`);

  // canvas: explore with tooltip, select, sheet open, success
  await page.goto(`${base}/canvas`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  if (label === "desktop") {
    const b = await page.locator("canvas[role=application]").boundingBox();
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.3);
    await page.waitForTimeout(500);
  }
  await shot(page, `canvas-${label}-explore`);
  await page.goto(`${base}/canvas?select=1&w=8&h=5`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2400);
  await shot(page, `canvas-${label}-select`);
  await page.getByRole("button", { name: "Buy these blocks" }).click();
  await page.waitForTimeout(900);
  await shot(page, `canvas-${label}-sheet-empty`);
  await page.setInputFiles("input[type=file]", "scripts/sample-ad.png");
  await page.fill("#ad-title", "Night Shift Coffee");
  await page.fill("#ad-link", "https://nightshift.coffee");
  await page.getByRole("radio", { name: /10% off/ }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.waitForTimeout(600);
  await shot(page, `canvas-${label}-wallet`);
  await page.getByRole("button", { name: "Use a demo wallet" }).click();
  await page.waitForTimeout(900);
  await shot(page, `canvas-${label}-sheet-filled`);
  await page.getByRole("button", { name: /Burn .* and buy/ }).click();
  await page.waitForTimeout(1600);
  await shot(page, `canvas-${label}-sheet-signing`);
  await page.waitForTimeout(4200);
  await shot(page, `canvas-${label}-sheet-success`);
  await ctx.close();
}

// reduced motion landing
const rm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const rp = await rm.newPage();
await rp.goto(`${base}/`, { waitUntil: "networkidle" });
await rp.waitForTimeout(2000);
await shot(rp, "landing-desktop-reduced-motion-hero");
await rp.evaluate(() => document.querySelector('[aria-labelledby="era-title"]')?.scrollIntoView());
await rp.waitForTimeout(1200);
await shot(rp, "landing-desktop-reduced-motion-2005");
await rm.close();

console.log(files.join("\n"));
console.log(logs.length ? "LOGS:\n" + [...new Set(logs)].join("\n") : "no console errors");
await browser.close();
