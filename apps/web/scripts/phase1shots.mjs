// Launch-phase screenshots: node scripts/phase1shots.mjs mock|api [base]
// mock: a build without NEXT_PUBLIC_API_URL. api: a build with NEXT_PUBLIC_API_URL=http://localhost:3299 NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta,
// answered by the stub below the way services answers in the SOL-only phase. Fails if anything asks for a token quote.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const kind = process.argv[2] || "mock";
const base = process.argv[3] || "http://localhost:3200";
const out = resolve("screens/phase1");
mkdirSync(out, { recursive: true });
const sizes = { desktop: [1440, 900], mobile: [390, 844] };
const PROGRAM = "C44yH6k1btWPyRhyE3ub855RnCrBFgZqfjB8waFq7yu9";

const tokenQuotes = [];
const stats = {
  buybackPhase: "later", buybackVaultLamports: "890880", soldBlocks: 0, totalBlocks: 10000, adsCount: 0, usdRaised: 0, lamportsRaised: "0", lamportsToTreasury: "0",
  lamportsToBuyback: "0", lamportsSpentBuyback: "0", tokensBurned: "0", tokensBurnedDirect: "0", tokensBurnedBuyback: "0", tokenSupply: "1000000000000000", burnedPct: 0,
  solPriceUsd: 150, tokenPriceUsd: null, marketCapUsd: null, auction: null, updatedAt: 1800000000,
};
function stub() {
  return createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("access-control-allow-origin", "*");
    const json = (v, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (u.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`); return; }
    if (u.pathname === "/api/stats") return json(stats);
    if (u.pathname === "/api/quote") {
      if (u.searchParams.get("mode") === "token") { tokenQuotes.push(req.url); return json({ error: "token_pricing_unavailable", reason: "upgrade_pending", tokenPaymentStatus: "upgrade_pending", detail: "token payments start after a program upgrade" }, 503); }
      const usd = Number(u.searchParams.get("w")) * Number(u.searchParams.get("h")) * 100;
      return json({ usd, usdMicro: String(usd * 1e6), solPriceUsd: 150, discountBps: 1000, expiresAt: Math.floor(Date.now() / 1000) + 30, tokenPriceUsd: null, tokenPaymentStatus: "upgrade_pending", tokenPaymentDetail: "token payments start after a program upgrade", tokenPricedBy: null, tokenBlocksAvailable: null, lamports: String(Math.ceil((usd / 150) * 1e9)) });
    }
    if (u.pathname === "/api/occupancy") return json({ bitmap: Buffer.alloc(1250).toString("base64"), soldBlocks: 0, totalBlocks: 10000, slot: 1, updatedAt: 1800000000 });
    if (u.pathname === "/api/buybacks") return json({ items: [], nextCursor: null });
    if (u.pathname === "/api/auction") return json(null);
    if (["/api/feed", "/api/ads", "/api/leaderboard"].includes(u.pathname)) return json([]);
    res.writeHead(404); res.end();
  }).listen(3299);
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const logs = [], files = [], texts = {};
const settle = (page, ms = 1500) => page.waitForTimeout(ms);

async function context(label, launched) {
  const [width, height] = sizes[label];
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: label === "mobile" ? 2 : 1, isMobile: label === "mobile", hasTouch: label === "mobile" });
  if (kind === "api")
    await ctx.route("**/api/rpc**", async (route) => {
      const one = (b) => ({ jsonrpc: "2.0", id: b.id, result: b.method === "getAccountInfo" ? { context: { slot: 1 }, value: launched ? { owner: PROGRAM, lamports: 1, executable: false, rentEpoch: 0, data: ["", "base64"] } : null } : null });
      const b = route.request().postDataJSON();
      await route.fulfill({ json: Array.isArray(b) ? b.map(one) : one(b) });
    });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && logs.push(`${label} console: ${m.text().slice(0, 160)}`));
  return { ctx, page };
}
const shot = async (page, name, full = false) => {
  const p = `${out}/${name}.png`;
  await page.screenshot({ path: p, fullPage: full });
  files.push(p);
};
const toSection = async (page, title) => {
  await page.evaluate((t) => document.querySelector(`[aria-labelledby="${t}"]`)?.scrollIntoView({ behavior: "instant" }), title);
  await settle(page, 1800);
};
const collect = async (page, key) => { texts[key] = await page.evaluate(() => document.body.innerText); };

if (kind === "api") {
  stub();
  for (const label of Object.keys(sizes)) {
    for (const [state, launched] of [["prelaunch", false], ["launched", true]]) {
      const { ctx, page } = await context(label, launched);
      await page.goto(`${base}/`, { waitUntil: "load" });
      await settle(page, 5200);
      await shot(page, `landing-${state}-${label}`);
      await collect(page, `landing-${state}-${label}`);
      await page.goto(`${base}/canvas?select=1&w=3&h=2`, { waitUntil: "load" });
      await settle(page, 2600);
      await shot(page, `canvas-${state}-${label}`);
      if (launched) {
        await page.getByRole("button", { name: "Buy these blocks" }).click();
        await settle(page, 1800);
        await shot(page, `sheet-real-api-${label}`);
        await collect(page, `sheet-real-api-${label}`);
      }
      await page.goto(`${base}/burns`, { waitUntil: "load" });
      await settle(page, 2400);
      await shot(page, `burns-${state}-${label}`, true);
      await collect(page, `burns-${state}-${label}`);
      await ctx.close();
    }
  }
} else {
  for (const label of Object.keys(sizes)) {
    const { ctx, page } = await context(label, true);
    await page.goto(`${base}/`, { waitUntil: "load" });
    await settle(page, 5200);
    await shot(page, `landing-sold-${label}`);
    await toSection(page, "flow-title");
    await shot(page, `moneyflow-${label}`);
    await toSection(page, "token-title");
    await shot(page, `pay-with-token-${label}`);
    await toSection(page, "live-title");
    await shot(page, `controller-${label}`);
    await toSection(page, "auction-title");
    await shot(page, `auction-teaser-${label}`);
    await toSection(page, "faq-title");
    for (const q of ["Where does the money go?", "What is coming soon?"]) await page.getByRole("button", { name: q }).click();
    await settle(page, 900);
    await shot(page, `faq-${label}`, false);
    await collect(page, `landing-${label}`);
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    await settle(page, 1800);
    await shot(page, `footer-${label}`);
    if (label === "mobile") {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.getByRole("button", { name: "Open menu" }).click();
      await settle(page, 900);
      await shot(page, "nav-menu-mobile");
    }
    await page.goto(`${base}/?empty=1`, { waitUntil: "load" });
    await settle(page, 5200);
    await shot(page, `landing-live-first-block-${label}`);
    await toSection(page, "live-title");
    await shot(page, `controller-empty-${label}`);
    await page.goto(`${base}/burns`, { waitUntil: "load" });
    await settle(page, 2400);
    await shot(page, `burns-${label}`, true);
    await collect(page, `burns-${label}`);
    await page.goto(`${base}/auction`, { waitUntil: "load" });
    await settle(page, 1800);
    await collect(page, `auction-${label}`);
    await page.goto(`${base}/canvas?select=1&w=8&h=5`, { waitUntil: "load" });
    await settle(page, 2400);
    await shot(page, `canvas-selection-${label}`);
    await page.getByRole("button", { name: "Buy these blocks" }).click();
    await settle(page, 900);
    await page.setInputFiles("input[type=file]", "scripts/sample-ad.png");
    await page.fill("#ad-title", "Night Shift Coffee");
    await page.fill("#ad-link", "https://nightshift.coffee");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await settle(page, 600);
    await page.getByRole("button", { name: "Use a demo wallet" }).click();
    await settle(page, 1000);
    await shot(page, `purchase-sheet-${label}`);
    await collect(page, `sheet-${label}`);
    await page.getByRole("button", { name: /^Buy for / }).click();
    await settle(page, 6500);
    await shot(page, `success-panel-${label}`);
    await collect(page, `success-${label}`);
    await ctx.close();
  }
}
writeFileSync(`${out}/.text-${kind}.json`, JSON.stringify(texts, null, 1));
console.log(files.join("\n"));
console.log(logs.length ? "LOGS:\n" + [...new Set(logs)].join("\n") : "no console errors");
console.log("token quote requests:", tokenQuotes.length);
await browser.close();
process.exit(tokenQuotes.length ? 1 : 0);
