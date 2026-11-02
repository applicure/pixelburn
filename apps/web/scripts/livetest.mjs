// Live devnet wallet test against the deployed site. DEVNET ONLY.
//   MODE=sol|token BUYER_KEYPAIR=../../chain/keys/buyer.json node scripts/livetest.mjs
// Env (never printed): SOLANA_RPC_HELIUS_KEY (devnet via Helius; else public devnet), PIXELBURN_ADMIN_TOKEN.
// A minimal wallet-standard wallet is injected into the page; it signs in Node via an exposed function,
// so the key never enters the page. Everything else is the production flow: upload, SDK buildBuyTx,
// simulation, /api/rpc proxy, confirmation.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

const SITE = process.env.SITE || "https://pixelburn.applicure.io";
const API = process.env.API || "https://api.pixelburn.applicure.io";
const MODE = process.env.MODE || "sol";
const MOBILE = process.env.MOBILE === "1";
const DRY = process.env.DRY === "1"; // stop at sheet-ready: nothing is signed or spent
const OUT = `screens/live-${MODE}${MOBILE ? "-mobile" : ""}${DRY ? "-dry" : ""}`;
mkdirSync(OUT, { recursive: true });
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.BUYER_KEYPAIR, "utf8"))));
const owner = kp.publicKey.toBase58();
const rpcUrl = process.env.SOLANA_RPC_HELIUS_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC_HELIUS_KEY}`
  : "https://api.devnet.solana.com";
const rpc = new Connection(rpcUrl, "confirmed");
const genesis = await rpc.getGenesisHash();
if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet, refusing");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const stats = async () => (await fetch(`${API}/api/stats`)).json();
const pick = (s) => ({
  soldBlocks: s.soldBlocks, adsCount: s.adsCount, usdRaised: s.usdRaised, lamportsRaised: s.lamportsRaised,
  lamportsToBuyback: s.lamportsToBuyback, tokensBurned: s.tokensBurned, tokensBurnedDirect: s.tokensBurnedDirect,
  tokensBurnedBuyback: s.tokensBurnedBuyback, burnedPct: s.burnedPct,
});

const before = pick(await stats());
log("buyer", owner, "SOL", (await rpc.getBalance(kp.publicKey)) / 1e9);
log("stats before", JSON.stringify(before));

const browser = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext(
  MOBILE
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } },
);
const errors = [];

// ---- SSE recorder on the site's own origin ----
const sse = await ctx.newPage();
await sse.goto(SITE + "/burns", { waitUntil: "domcontentloaded" });
await sse.evaluate((api) => {
  window.__feed = [];
  const es = new EventSource(api + "/api/events");
  es.addEventListener("feed", (e) => window.__feed.push(JSON.parse(e.data)));
}, API);

// ---- the buyer page with an injected test wallet ----
const page = await ctx.newPage();
page.on("console", async (m) => {
  if (m.type() !== "error" && !/Content Security Policy/.test(m.text())) return;
  // unwrap wallet-adapter errors: WalletSendTransactionError keeps the real cause in `.error`
  const parts = [];
  for (const a of m.args())
    parts.push(await a.evaluate((e) => (e && typeof e === "object" ? [e.name, e.message, e.error?.name, e.error?.message, JSON.stringify(e.error?.logs ?? e.logs ?? null)].filter(Boolean).join(" | ") : String(e))).catch(() => "?"));
  errors.push(parts.join(" || ").slice(0, 1200));
});
page.on("pageerror", (e) => errors.push("pageerror " + e.message));
await page.exposeFunction("__pbSign", async (b64s) =>
  b64s.map((b64) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    tx.sign([kp]);
    return Buffer.from(tx.serialize()).toString("base64");
  }),
);
await page.addInitScript(
  ({ address, pk }) => {
    const publicKey = new Uint8Array(pk);
    const b64 = (u8) => btoa(String.fromCharCode(...u8));
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const account = { address, publicKey, chains: ["solana:devnet"], features: ["solana:signTransaction"], label: "Live test" };
    const wallet = {
      version: "1.0.0",
      name: "Pixel Burn Test Wallet",
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff5b14"/></svg>'),
      chains: ["solana:devnet"],
      accounts: [],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { wallet.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { wallet.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs) => {
            window.__signRequests = (window.__signRequests || 0) + 1;
            const signed = await window.__pbSign(inputs.map((i) => b64(i.transaction)));
            return signed.map((s) => ({ signedTransaction: unb64(s) }));
          },
        },
      },
    };
    const cb = ({ register }) => register(wallet);
    try { window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: cb })); } catch {}
    try { window.addEventListener("wallet-standard:app-ready", ({ detail }) => cb(detail)); } catch {}
  },
  { address: owner, pk: Array.from(kp.publicKey.toBytes()) },
);

const shot = async (n) => page.screenshot({ path: `${OUT}/${n}.png` });
await page.goto(SITE + "/canvas?select=1&w=1&h=1", { waitUntil: "networkidle" });
await page.waitForTimeout(3500);
await shot("01-select");
await page.getByRole("button", { name: "Buy these blocks" }).click();
await page.waitForTimeout(1200);
await page.setInputFiles("input[type=file]", process.env.AD_IMAGE || "scripts/sample-ad.png");
await page.fill("#ad-title", MODE === "sol" ? "Live test: paid in SOL" : "Live test: paid in PXTEST");
await page.fill("#ad-link", "https://pixelburn.applicure.io");
if (MODE === "token") {
  const tokenBtn = page.getByRole("radio", { name: /10% off/ });
  if (await tokenBtn.isDisabled()) {
    await page.waitForTimeout(800);
    await shot("02-token-paused");
    log("TOKEN PAUSED:", await page.locator("#token-note").innerText().catch(() => "?"));
    await browser.close();
    process.exit(3);
  }
  await tokenBtn.click();
}
await page.getByRole("button", { name: "Connect wallet" }).click();
await page.waitForTimeout(700);
await shot("02-wallet-picker");
await page.getByRole("button", { name: /Pixel Burn Test Wallet/ }).click();
await page.waitForTimeout(2500);
await shot("03-sheet-ready");
if (DRY) {
  // also capture the sheet scrolled to the form top, then stop before the CTA
  await page.locator("#ad-title").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot("03b-sheet-form");
  log("DRY RUN: stopped at sheet-ready, nothing signed. CTA:", await page.locator("button.btn-fire").last().innerText());
  log("page console errors:", errors.length ? errors.join("\n") : "none");
  await browser.close();
  process.exit(0);
}
const buy = page.locator("button.btn-fire", { hasText: MODE === "sol" ? /^Buy for/ : /^Burn / });
log("CTA:", await buy.innerText());
await buy.click();
await page.waitForTimeout(2500);
await shot("04-in-flight");
const ok = await page.getByText("You're on the billboard.").waitFor({ timeout: 120_000 }).then(() => true, () => false);
await page.waitForTimeout(1500);
await shot(ok ? "05-success" : "05-failed");
if (!ok) {
  log("FAILED. sheet says:", (await page.locator('[role="alert"]').allInnerTexts()).join(" | "));
  log("page errors:", errors.join("\n"));
  await browser.close();
  process.exit(2);
}
const href = await page.locator('a:has-text("View the transaction")').getAttribute("href");
const sig = href.split("/tx/")[1].split("?")[0];
log("signature", sig, "signRequests", await page.evaluate(() => window.__signRequests));

// ---- finalized ----
for (let i = 0; i < 60; i++) {
  const st = (await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
  if (st?.err) throw new Error("tx error " + JSON.stringify(st.err));
  if (st?.confirmationStatus === "finalized") { log("finalized at slot", st.slot); break; }
  await new Promise((r) => setTimeout(r, 2000));
}

// ---- SSE saw it ----
await page.waitForTimeout(4000);
const feed = await sse.evaluate(() => window.__feed);
const seen = feed.find((f) => f.type === "purchase" && f.owner === owner && f.sig === sig);
log("SSE purchase event:", seen ? JSON.stringify(seen) : `not seen (${feed.length} feed events total)`);

// ---- admin approval ----
const auth = { authorization: `Bearer ${process.env.PIXELBURN_ADMIN_TOKEN}` };
let ad = null;
for (let i = 0; i < 30 && !ad; i++) {
  const q = await (await fetch(`${API}/api/admin/queue`, { headers: auth })).json();
  const items = Array.isArray(q) ? q : q.items ?? [];
  ad = items.find((a) => a.owner === owner && (a.sig === sig || a.title?.startsWith("Live test")));
  if (!ad) await new Promise((r) => setTimeout(r, 3000));
}
if (!ad) log("ad not found in the moderation queue");
else {
  const r = await fetch(`${API}/api/admin/ads/${ad.id}/approve`, { method: "POST", headers: auth });
  log("approve ad", ad.id, "->", r.status);
  await new Promise((r) => setTimeout(r, 2500));
  const pub = await fetch(`${API}/api/ads/${ad.id}`);
  log("/api/ads/" + ad.id, pub.status, pub.ok ? JSON.stringify(await pub.json()) : "");
}

// ---- after: canvas, burns, home ----
await page.waitForTimeout(6000);
const after = pick(await stats());
log("stats after ", JSON.stringify(after));
const ap = await ctx.newPage();
await ap.goto(SITE + "/canvas", { waitUntil: "networkidle" });
await ap.waitForTimeout(3000);
if (ad) {
  // zoom in around the ad using the keyboard model (cursor starts at 50,50)
  await ap.locator("canvas[role=application]").focus();
  for (let i = 0; i < 4; i++) await ap.keyboard.press("+");
  await ap.waitForTimeout(800);
}
await ap.screenshot({ path: `${OUT}/06-canvas-after.png` });
const box = await ap.locator("canvas[role=application]").boundingBox();
await ap.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await ap.waitForTimeout(600);
await ap.screenshot({ path: `${OUT}/07-canvas-hover.png` });
await ap.goto(SITE + "/burns", { waitUntil: "networkidle" });
await ap.waitForTimeout(3000);
await ap.screenshot({ path: `${OUT}/08-burns.png` });
await ap.goto(SITE + "/", { waitUntil: "networkidle" });
await ap.waitForTimeout(5500);
await ap.screenshot({ path: `${OUT}/09-home.png` });
log("buyer SOL after", (await rpc.getBalance(kp.publicKey)) / 1e9);
log("page console errors:", errors.length ? errors.join("\n") : "none");
await browser.close();
