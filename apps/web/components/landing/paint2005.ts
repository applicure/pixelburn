/**
 * Draws a period-accurate homage of a 2005 pixel-ad homepage into a 2D canvas:
 * Times headings, blue underlined links, bevelled table chrome, a grid of tiny
 * banner ads in web-safe colours and a hit counter. It becomes the texture that burns.
 */
import { mulberry32, paintAd } from "@/lib/adArt";

export function paint2005(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const rand = mulberry32(2005);
  const narrow = w < 640;

  // window chrome (generic early-2000s browser, not a specific product)
  const grad = ctx.createLinearGradient(0, 0, 0, 30);
  grad.addColorStop(0, "#0a58d6");
  grad.addColorStop(1, "#0840a8");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, 30);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 13px Tahoma, Verdana, sans-serif";
  ctx.fillText("Million Dollar Homepage - Own a piece of internet history!", 10, 20);
  ["#d6d3ce", "#d6d3ce", "#e2482e"].forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(w - 76 + i * 23, 6, 19, 18);
  });
  ctx.fillStyle = "#ece9d8";
  ctx.fillRect(0, 30, w, 30);
  ctx.fillStyle = "#fff";
  ctx.fillRect(70, 35, w - 90, 20);
  ctx.strokeStyle = "#7f9db9";
  ctx.strokeRect(70.5, 35.5, w - 91, 19);
  ctx.fillStyle = "#000";
  ctx.font = "12px Tahoma, Verdana, sans-serif";
  ctx.fillText("Address", 14, 49);
  ctx.fillText("http://www.milliondollarhomepage.com/", 76, 49);

  // page
  const top = 60;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, top, w, h - top);
  const pad = narrow ? 12 : 26;
  ctx.fillStyle = "#000";
  ctx.font = `bold ${narrow ? 24 : 38}px "Times New Roman", Times, serif`;
  ctx.fillText("The Million Dollar Homepage", pad, top + (narrow ? 38 : 52));
  ctx.font = `${narrow ? 12 : 15}px Verdana, Geneva, sans-serif`;
  ctx.fillStyle = "#333";
  ctx.fillText("1,000,000 pixels  •  $1 per pixel  •  Own a piece of internet history!", pad, top + (narrow ? 60 : 80));

  // nav row of blue links
  const links = ["Homepage", "Buy Pixels", "FAQ", "Press", "Testimonials", "Contact me"];
  ctx.font = `${narrow ? 12 : 14}px Verdana, Geneva, sans-serif`;
  let lx = pad;
  const ly = top + (narrow ? 84 : 110);
  ctx.fillStyle = "#e9e9e9";
  ctx.fillRect(0, ly - 18, w, 28);
  for (const l of links) {
    const tw = ctx.measureText(l).width;
    if (lx + tw > w - pad) break;
    ctx.fillStyle = l === "Buy Pixels" ? "#cc0000" : "#0000ee";
    ctx.fillText(l, lx, ly);
    ctx.fillRect(lx, ly + 2, tw, 1);
    lx += tw + (narrow ? 14 : 26);
  }

  // the grid of tiny ads
  const gx = pad;
  const gy = ly + 22;
  const gw = w - pad * 2;
  const gh = h - gy - (narrow ? 64 : 70);
  ctx.fillStyle = "#fff";
  ctx.fillRect(gx, gy, gw, gh);
  const cell = narrow ? 8 : 10;
  const cols = Math.floor(gw / cell);
  const rows = Math.floor(gh / cell);
  const occ = new Uint8Array(cols * rows);
  const off = document.createElement("canvas");
  off.width = 400;
  off.height = 400;
  const octx = off.getContext("2d")!;
  let id = 500;
  for (let n = 0; n < cols * rows * 0.5; n++) {
    const bw = rand() < 0.6 ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 5);
    const bh = rand() < 0.6 ? 1 : 1 + Math.floor(rand() * 3);
    // density thins toward the bottom (sold from the top down)
    const y = Math.floor(Math.pow(rand(), 1.15) * (rows - bh + 1));
    const x = Math.floor(rand() * (cols - bw + 1));
    let free = true;
    for (let yy = y; yy < y + bh && free; yy++) for (let xx = x; xx < x + bw; xx++) if (occ[yy * cols + xx]) { free = false; break; }
    if (!free) continue;
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) occ[yy * cols + xx] = 1;
    octx.clearRect(0, 0, 400, 400);
    paintAd(octx, { id: id++, x: 0, y: 0, w: bw, h: bh, title: "AD" });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, bw * 10, bh * 10, gx + x * cell, gy + y * cell, bw * cell, bh * cell);
  }
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);

  // footer: hit counter + copyright
  const fy = h - (narrow ? 34 : 38);
  ctx.fillStyle = "#000";
  ctx.fillRect(pad, fy - 16, narrow ? 104 : 124, 22);
  ctx.fillStyle = "#33ff33";
  ctx.font = `bold ${narrow ? 14 : 16}px "Courier New", monospace`;
  ctx.fillText("01037100", pad + 8, fy);
  ctx.fillStyle = "#555";
  ctx.font = `${narrow ? 10 : 12}px Verdana, Geneva, sans-serif`;
  ctx.fillText("Best viewed at 1024×768. A 2005 homage, redrawn for this page.", pad + (narrow ? 114 : 140), fy - 2);
}
