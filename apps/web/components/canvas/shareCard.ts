/**
 * The buyer's own card, 1200x630, drawn in the browser from their local image so it works before approval and before the
 * indexer has seen the purchase. It mirrors services/src/card/render.ts, which draws the public card for /ad/<id>: change both.
 * This one may show the unapproved image because only the buyer sees it, on their own device.
 */
import { api } from "@/lib/api";
import { CLUSTER, GRID } from "@/lib/config";
import { MARK_GRID, MARK_PATH, MARK_PIXEL, WORDMARK_GRID, WORDMARK_PATH } from "@/lib/brandPaths";
import { bitGet } from "@/lib/quote";
import { fmtUsd } from "@/lib/format";
import { TAGLINE } from "@/lib/phase";
import { adBox, burnHeadline, type ShareFacts } from "@/lib/share";
import type { Occupancy } from "@/lib/types";

const W = 1200, H = 630, MARGIN = 40, FRAME = 6, ZONE_H = 340, MAP = 200;
const FLAME = "#FF6400", CREAM = "#FFF5DC", BLACK = "#000000";

const loadImage = (src: string, cors = false) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    const im = new Image();
    if (cors) im.crossOrigin = "anonymous";
    const t = setTimeout(() => resolve(null), 3000);
    im.onload = () => (clearTimeout(t), resolve(im));
    im.onerror = () => (clearTimeout(t), resolve(null));
    im.src = src;
  });

async function occupancyBits(): Promise<Uint8Array | null> {
  try {
    const o: Occupancy = await api.getOccupancy();
    return Uint8Array.from(atob(o.bitmap), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The whole wall with this ad's spot marked. A missing canvas or occupancy leaves a plain grid: the marker is what matters. */
function drawMap(ctx: CanvasRenderingContext2D, f: ShareFacts, x: number, y: number, s: number, sold: Uint8Array | null, wall: HTMLImageElement | null) {
  const px = GRID * s;
  ctx.fillStyle = "#120e0c";
  ctx.fillRect(x, y, px, px);
  if (sold) {
    ctx.fillStyle = "#4a3c32";
    for (let b = 0; b < GRID * GRID; b++) if (bitGet(sold, b)) ctx.fillRect(x + (b % GRID) * s, y + Math.floor(b / GRID) * s, s, s);
  }
  if (wall) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(wall, x, y, px, px);
  }
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.fillRect(x, y, px, px);
  ctx.strokeStyle = "rgba(255,245,220,.09)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath();
    ctx.moveTo(x + i * 10 * s, y);
    ctx.lineTo(x + i * 10 * s, y + px);
    ctx.moveTo(x, y + i * 10 * s);
    ctx.lineTo(x + px, y + i * 10 * s);
    ctx.stroke();
  }
  const line = 3, minBox = 14;
  const rw = Math.max(minBox, f.w * s), rh = Math.max(minBox, f.h * s);
  const rx = Math.min(px - rw, Math.max(0, (f.x + f.w / 2) * s - rw / 2));
  const ry = Math.min(px - rh, Math.max(0, (f.y + f.h / 2) * s - rh / 2));
  ctx.fillStyle = BLACK;
  ctx.fillRect(x + rx + rw / 2 - line / 2 - 1, y, line + 2, px);
  ctx.fillRect(x, y + ry + rh / 2 - line / 2 - 1, px, line + 2);
  ctx.fillStyle = FLAME;
  ctx.fillRect(x + rx + rw / 2 - line / 2, y, line, px);
  ctx.fillRect(x, y + ry + rh / 2 - line / 2, px, line);
  ctx.fillStyle = BLACK;
  ctx.fillRect(x + rx - line, y + ry - line, rw + 2 * line, rh + 2 * line);
  ctx.fillStyle = CREAM;
  ctx.fillRect(x + rx, y + ry, rw, rh);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const lines: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const cand = line ? `${line} ${words[i]}` : words[i]!;
    if (ctx.measureText(cand).width <= width) {
      line = cand;
      continue;
    }
    if (line) lines.push(line);
    line = words[i]!;
    if (lines.length === maxLines) {
      let last = lines[maxLines - 1]!;
      while (last.includes(" ") && ctx.measureText(`${last}…`).width > width) last = last.slice(0, last.lastIndexOf(" "));
      while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1).trimEnd();
      lines[maxLines - 1] = `${last}…`;
      return lines;
    }
  }
  if (line) lines.push(line);
  // a single word wider than the line: cut it
  return lines.map((l) => {
    let cut = l;
    if (ctx.measureText(cut).width <= width) return cut;
    while (cut && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
    return `${cut}…`;
  });
}

export async function renderShareCard(opts: { image: string | null; title: string; facts: ShareFacts; live: boolean }): Promise<string> {
  const { facts: f } = opts;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const css = getComputedStyle(document.documentElement);
  const display = css.getPropertyValue("--font-anybody").trim() || "sans-serif";
  const sans = css.getPropertyValue("--font-schibsted").trim() || "sans-serif";
  const mono = css.getPropertyValue("--font-martian").trim() || "monospace";
  const wall = api.canvasPngUrl();
  const [img, wallImg, sold] = await Promise.all([
    opts.image ? loadImage(opts.image) : Promise.resolve(null),
    wall ? loadImage(wall, true) : Promise.resolve(null),
    occupancyBits(),
    // a canvas only uses a webfont already loaded, and the mono face is not preloaded
    Promise.allSettled([document.fonts.load(`900 100px ${display}`), document.fonts.load(`700 40px ${sans}`), document.fonts.load(`500 24px ${mono}`)]),
  ]);

  // a Font with the same axes as the server's outlines: Anybody 900 / wdth 125
  const setFont = (face: "display" | "text" | "mono", size: number) => {
    ctx.font = face === "display" ? `900 ${size}px ${display}` : face === "text" ? `700 ${size}px ${sans}` : `500 ${size}px ${mono}`;
    ctx.fontStretch = face === "display" ? "expanded" : "normal";
  };
  const fit = (face: "display" | "text" | "mono", text: string, width: number, max: number, min: number) => {
    setFont(face, max);
    const m = ctx.measureText(text).width;
    const size = m <= width ? max : Math.max(min, Math.floor((max * width) / m));
    setFont(face, size);
    return size;
  };

  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);

  const box = adBox(f.w, f.h);
  const top = H - ZONE_H;
  let zoneX: number, infoX: number, infoY: number, infoW: number;
  const drawAd = (x: number, y: number) => {
    ctx.fillStyle = FLAME;
    ctx.fillRect(x, y, box.iw + 2 * FRAME, box.ih + 2 * FRAME);
    ctx.fillStyle = BLACK;
    ctx.fillRect(x + FRAME, y + FRAME, box.iw, box.ih);
    if (img) {
      ctx.imageSmoothingEnabled = !box.exact;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, x + FRAME, y + FRAME, box.iw, box.ih);
    }
  };
  if (box.wide) {
    drawAd(MARGIN, Math.round((top - box.ih - 2 * FRAME) / 2));
    zoneX = 580;
    infoX = MARGIN;
    infoY = top + 18;
    infoW = zoneX - 2 * MARGIN;
  } else {
    drawAd(MARGIN, Math.round((H - box.ih - 2 * FRAME) / 2));
    zoneX = MARGIN + box.iw + 2 * FRAME + 40;
    infoX = zoneX;
    infoY = 36;
    infoW = W - zoneX - MARGIN;
  }

  // the flame block
  const zoneW = W - zoneX, padX = zoneX + 32, figW = zoneW - 64 - MAP - 24;
  ctx.fillStyle = FLAME;
  ctx.fillRect(zoneX, top, zoneW, ZONE_H);
  const b = burnHeadline(f, opts.live);
  ctx.fillStyle = BLACK;
  ctx.textBaseline = "alphabetic";
  fit("text", b.label, figW, 34, 20);
  ctx.fillText(b.label, padX, top + 62);
  const figSize = fit("display", b.figure, figW, 132, 40);
  const figY = top + 90 + Math.round(figSize * 0.78);
  ctx.fillText(b.figure, padX, figY);
  setFont("text", 25);
  wrap(ctx, b.sub, figW, 2).forEach((l, i) => ctx.fillText(l, padX, figY + 46 + i * 30));
  drawMap(ctx, f, W - 32 - MAP, top + 32, 2, sold, wallImg);
  ctx.fillStyle = BLACK;
  fit("text", TAGLINE, zoneW - 64, 26, 18);
  ctx.fillText(TAGLINE, padX, H - 26);

  // logo, title, size and price on black
  ctx.save();
  ctx.translate(infoX, infoY);
  ctx.scale(3, 3);
  ctx.fillStyle = FLAME;
  ctx.fill(new Path2D(MARK_PATH), "evenodd");
  ctx.fillStyle = CREAM;
  ctx.fillRect(MARK_PIXEL.x, MARK_PIXEL.y, MARK_PIXEL.w, MARK_PIXEL.h);
  ctx.restore();
  ctx.save();
  ctx.translate(infoX + MARK_GRID.w * 3 + 16, infoY + (MARK_GRID.h * 3 - WORDMARK_GRID.h * 2) / 2);
  ctx.scale(2, 2);
  ctx.fillStyle = CREAM;
  ctx.fill(new Path2D(WORDMARK_PATH));
  ctx.restore();

  const statBottom = box.wide ? H - 34 : top - 22;
  const size = opts.title.length > 34 ? 38 : 46;
  setFont("text", size);
  const lines = wrap(ctx, opts.title, infoW, 2);
  const lh = Math.round(size * 1.14);
  let y = infoY + MARK_GRID.h * 3;
  const room = statBottom - 42 - y;
  y += Math.max(44, Math.round((room - lines.length * lh) / 2) + Math.round(size * 0.86));
  ctx.fillStyle = CREAM;
  for (const l of lines) {
    ctx.fillText(l, infoX, y);
    y += lh;
  }
  const blocks = `${f.w}×${f.h} block${f.blockCount === 1 ? "" : "s"} at ${f.x},${f.y}`;
  const stat = `${blocks} · ${fmtUsd(f.usd)}`;
  fit("mono", stat, infoW, 25, 15);
  ctx.fillText(stat, infoX, statBottom);

  if (CLUSTER !== "mainnet-beta") {
    const t = "TEST NETWORK, NO REAL MONEY";
    setFont("mono", 15);
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = CREAM;
    ctx.fillRect(0, 0, tw + 28, 26);
    ctx.fillStyle = BLACK;
    ctx.fillText(t, 14, 19);
  }
  return c.toDataURL("image/png");
}
