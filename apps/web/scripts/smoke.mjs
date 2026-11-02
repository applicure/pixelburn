// Smoke test against a running build (real API or mock): node scripts/smoke.mjs <base> <outDir>
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const [base = "http://localhost:3000", out = "screens/real-api"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on("console", (m) => (m.type() === "error" || /Content Security Policy/.test(m.text())) && errs.push(m.text().slice(0, 220)));
p.on("pageerror", (e) => errs.push("pageerror " + e.message));
for (const [path, name, wait] of [["/", "home", 5500], ["/canvas", "canvas", 3000], ["/burns", "burns", 3000], ["/auction", "auction", 2500]]) {
  await p.goto(base + path, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(wait);
  if (name === "canvas") {
    const bb = await p.locator("canvas[role=application]").boundingBox();
    await p.mouse.move(bb.x + bb.width * 0.45, bb.y + bb.height * 0.25);
    await p.waitForTimeout(400);
  }
  await p.screenshot({ path: `${out}/${name}-desktop.png` });
}
// a quote through the real API from the selection bar
await p.goto(base + "/canvas?select=1&w=4&h=3", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3500);
await p.screenshot({ path: `${out}/canvas-select-desktop.png` });
console.log(errs.length ? [...new Set(errs)].join("\n") : "no console errors / CSP violations");
await b.close();
