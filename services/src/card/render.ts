// Server-rendered 1200x630 share card, the picture X and others show for /ad/<id>.
// Text is drawn from glyph outlines (glyphs.generated.ts): the API image has no system fonts, and buyer text never
// reaches the SVG parser as text, so it cannot inject markup or make librsvg load anything.
//
// The layout is mirrored by apps/web/components/canvas/shareCard.ts for the buyer's own download. Change both.
import sharp, { type OverlayOptions } from "sharp";
import { BLOCK_PX, GRID } from "../constants.js";
import { getBlock } from "../lib/blocks.js";
import { MARK_GRID, MARK_PATH, MARK_PIXEL, WORDMARK_GRID, WORDMARK_PATH } from "./brandPaths.js";
import { GLYPHS, type GlyphFont } from "./glyphs.generated.js";

export const CARD_W = 1200;
export const CARD_H = 630;
const FLAME = "#FF6400";
const CREAM = "#FFF5DC";
const BLACK = "#000000";
const ASH = "#9A9087";
const MARGIN = 40;
const FRAME = 6;
/** Height of the flame block: the burn figure, the map and the tagline. */
const ZONE_H = 340;

export type CardState = "approved" | "pending" | "rejected";

export interface CardFacts {
  state: CardState;
  id: number;
  /** Bounding rectangle, in blocks. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Differs from w*h only for the final-auction lot. */
  blockCount: number;
  payMode: "sol" | "token" | "auction";
  usd: number;
  lamports: string;
  tokens: string;
  decimals: number;
  cluster: "devnet" | "mainnet-beta";
  /** Approved ads only. */
  title?: string;
  /** Approved ads only. */
  image?: Buffer | null;
  /** Composed canvas of approved ads (1000x1000 PNG), null if none yet. */
  canvasPng: Buffer | null;
  /** Occupancy bitmap: what is sold, approved or not. */
  sold: Uint8Array;
}

// ---- text ----
type FontKey = keyof typeof GLYPHS;

function measure(font: GlyphFont, text: string, size: number, tracking = 0) {
  let adv = 0;
  const chars = [...text];
  chars.forEach((c, i) => {
    adv += font.glyphs[c]?.[0] ?? 0;
    const next = chars[i + 1];
    if (next) adv += font.kern[c + next] ?? 0;
  });
  return (adv / font.upm) * size + tracking * Math.max(0, chars.length - 1);
}

function text(key: FontKey, str: string, x: number, y: number, size: number, fill: string, opts: { anchor?: "start" | "end"; tracking?: number } = {}) {
  const font = GLYPHS[key];
  const tracking = opts.tracking ?? 0;
  const k = size / font.upm;
  const startX = opts.anchor === "end" ? x - measure(font, str, size, tracking) : x;
  let pen = 0;
  let out = "";
  const chars = [...str];
  chars.forEach((c, i) => {
    const g = font.glyphs[c];
    if (!g) return;
    if (g[1]) out += `<path transform="translate(${(startX + pen).toFixed(2)} ${y}) scale(${k.toFixed(5)})" d="${g[1]}"/>`;
    const next = chars[i + 1];
    pen += (g[0] + (next ? font.kern[c + next] ?? 0 : 0)) * k + tracking;
  });
  return `<g fill="${fill}">${out}</g>`;
}

/** Largest size at most `max` that fits `width`, never under `min`. */
function fit(key: FontKey, str: string, width: number, max: number, min: number) {
  const atMax = measure(GLYPHS[key], str, max);
  return atMax <= width ? max : Math.max(min, Math.floor((max * width) / atMax));
}

function wrap(key: FontKey, str: string, size: number, width: number, maxLines: number): string[] {
  const font = GLYPHS[key];
  const lines: string[] = [];
  let line = "";
  const words = str.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    // a word wider than the line breaks where it must
    while (measure(font, word, size) > width && lines.length < maxLines) {
      let n = word.length;
      while (n > 1 && measure(font, `${line}${line ? " " : ""}${word.slice(0, n)}`, size) > width) n--;
      if (n <= 1 && line) {
        lines.push(line);
        line = "";
        continue;
      }
      lines.push(`${line}${line ? " " : ""}${word.slice(0, n)}`);
      line = "";
      word = word.slice(n);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (measure(font, candidate, size) <= width) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length >= maxLines) {
      line = "";
      const dropped = words.slice(i).length > 0;
      if (dropped) {
        let last = lines[maxLines - 1]!;
        while (last && measure(font, `${last}…`, size) > width) last = last.slice(0, -1).trimEnd();
        lines[maxLines - 1] = `${last}…`;
      }
      return lines.slice(0, maxLines);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** What of a title the card can draw. Falls back to the ad number when too much of it has no glyph (CJK, emoji). */
export function drawableTitle(title: string | undefined, id: number) {
  const fallback = `Ad #${id}`;
  if (!title) return fallback;
  const chars = [...title.normalize("NFC")];
  const kept = chars.filter((c) => c === " " || GLYPHS.text.glyphs[c]);
  const out = kept.join("").replace(/\s+/g, " ").trim();
  if (!out || kept.length < chars.length * 0.7) return fallback;
  return out;
}

// ---- figures ----
const group = (n: number, dp = 0) => n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function compactTokens(baseUnits: string, decimals: number) {
  const whole = Number(BigInt(baseUnits)) / 10 ** decimals;
  if (whole >= 1e9) return `${(whole / 1e9).toFixed(2)}B`;
  if (whole >= 1e6) return `${(whole / 1e6).toFixed(2)}M`;
  if (whole >= 1) return group(Math.floor(whole));
  return whole > 0 ? whole.toFixed(2) : "0";
}

function solAmount(lamports: string) {
  const sol = Number(BigInt(lamports)) / 1e9;
  const dp = sol >= 100 ? 1 : sol >= 1 ? 2 : 3;
  return sol.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** The honest headline for each way of paying. Nothing here claims a burn that has not happened. */
export function burnFigure(f: Pick<CardFacts, "payMode" | "usd" | "lamports" | "tokens" | "decimals">) {
  if (f.payMode === "token") return { label: "$PXL BURNED", figure: compactTokens(f.tokens, f.decimals), sub: "every token paid, destroyed in the purchase" };
  // Launch phase: wording shared with apps/web/lib/share.ts. Buybacks are coming soon, so only the vault is claimed.
  if (f.payMode === "auction") return { label: "TO THE BUYBACK VAULT", figure: `${solAmount(f.lamports)} SOL`, sub: "all of the winning bid, buybacks coming soon" };
  return { label: "TO THE BUYBACK VAULT", figure: `$${group(Math.round(f.usd / 2))}`, sub: `half of ${solAmount(f.lamports)} SOL paid, buybacks coming soon` };
}

function sizeLine(f: CardFacts) {
  const size = f.payMode === "auction" ? `${group(f.blockCount)} blocks` : `${f.w}×${f.h} blocks`;
  const at = f.payMode === "auction" ? "" : ` at ${f.x},${f.y}`;
  return `${size}${at}`;
}

// ---- layout ----
export interface AdBox {
  iw: number;
  ih: number;
  /** Whole-number upscale, so every pixel of the ad stays a sharp square. */
  exact: boolean;
  wide: boolean;
}

/** How the ad image sits on the card. */
export function adBox(wBlocks: number, hBlocks: number): AdBox {
  const pw = wBlocks * BLOCK_PX, ph = hBlocks * BLOCK_PX;
  const wide = pw / ph >= 2.5;
  const maxW = wide ? CARD_W - 2 * MARGIN - 2 * FRAME : 490;
  const maxH = wide ? 214 : 490;
  const raw = Math.min(maxW / pw, maxH / ph);
  const k = raw >= 1 ? Math.floor(raw) : raw;
  return { iw: Math.max(1, Math.round(pw * k)), ih: Math.max(1, Math.round(ph * k)), exact: raw >= 1, wide };
}

function lockup(x: number, y: number) {
  const u = 3, wu = 2;
  const markW = MARK_GRID.w * u;
  const wx = x + markW + 16;
  const wy = y + (MARK_GRID.h * u - WORDMARK_GRID.h * wu) / 2;
  return (
    `<g transform="translate(${x} ${y}) scale(${u})"><path fill="${FLAME}" fill-rule="evenodd" d="${MARK_PATH}"/><rect fill="${CREAM}" x="${MARK_PIXEL.x}" y="${MARK_PIXEL.y}" width="${MARK_PIXEL.w}" height="${MARK_PIXEL.h}"/></g>` +
    `<g transform="translate(${wx} ${wy}) scale(${wu})"><path fill="${CREAM}" d="${WORDMARK_PATH}"/></g>`
  );
}

/** The wall at `s` px per block: sold blocks, approved ads, and an unmissable marker on this ad's spot. */
async function renderMap(f: CardFacts, s: number): Promise<Buffer> {
  const px = GRID * s;
  const raw = Buffer.alloc(GRID * GRID * 3);
  for (let b = 0; b < GRID * GRID; b++) {
    const sold = getBlock(f.sold, b);
    raw[b * 3] = sold ? 0x4a : 0x12;
    raw[b * 3 + 1] = sold ? 0x3c : 0x0e;
    raw[b * 3 + 2] = sold ? 0x32 : 0x0c;
  }
  const ground = await sharp(raw, { raw: { width: GRID, height: GRID, channels: 3 } }).resize(px, px, { kernel: "nearest" }).png().toBuffer();
  const layers: OverlayOptions[] = [];
  if (f.canvasPng) layers.push({ input: await sharp(f.canvasPng).resize(px, px, { kernel: "lanczos3" }).png().toBuffer(), left: 0, top: 0 });

  const line = s >= 4 ? 4 : 3;
  const minBox = s >= 4 ? 18 : 14;
  const rw = Math.max(minBox, f.w * s), rh = Math.max(minBox, f.h * s);
  const rx = Math.min(px - rw, Math.max(0, (f.x + f.w / 2) * s - rw / 2));
  const ry = Math.min(px - rh, Math.max(0, (f.y + f.h / 2) * s - rh / 2));
  const cx = rx + rw / 2, cy = ry + rh / 2;
  const grid = Array.from({ length: 9 }, (_, i) => (i + 1) * 10 * s)
    .map((p) => `<path d="M${p} 0V${px}M0 ${p}H${px}" stroke="${CREAM}" stroke-opacity=".09" stroke-width="1"/>`)
    .join("");
  // the wall steps back so that the marker reads at preview size, where this map is about 80 px wide
  const hairs = `M${cx} 0V${ry}M${cx} ${ry + rh}V${px}M0 ${cy}H${rx}M${rx + rw} ${cy}H${px}`;
  const marker =
    `<rect width="${px}" height="${px}" fill="${BLACK}" fill-opacity=".45"/>` +
    `<path d="${hairs}" stroke="${BLACK}" stroke-width="${line + 2}"/><path d="${hairs}" stroke="${FLAME}" stroke-width="${line}"/>` +
    `<rect x="${rx - line}" y="${ry - line}" width="${rw + 2 * line}" height="${rh + 2 * line}" fill="${BLACK}"/>` +
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${CREAM}"/>`;
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}">${marker}${grid}</svg>`), left: 0, top: 0 });
  return sharp(ground).composite(layers).png().toBuffer();
}

async function fittedAd(image: Buffer, box: AdBox) {
  return sharp(image)
    .flatten({ background: BLACK })
    .resize(box.iw, box.ih, { fit: "fill", kernel: box.exact ? "nearest" : "lanczos3" })
    .png()
    .toBuffer();
}

const HEAD: Record<CardState, { headline: string; note: string }> = {
  approved: { headline: "", note: "" },
  pending: { headline: "IN REVIEW", note: "The ad shows here once it is approved." },
  rejected: { headline: "NOT ON DISPLAY", note: "This ad did not pass moderation." },
};

export async function renderCard(f: CardFacts): Promise<Buffer> {
  const approved = f.state === "approved";
  const hasImage = approved && !!f.image;
  const box = adBox(f.w, f.h);
  const layers: OverlayOptions[] = [];
  let svg = "";

  // left (or top) hero: the ad itself, or the wall with its spot when the ad cannot be shown
  let rx: number, zoneY: number, infoY: number, infoX: number, infoW: number, zoneX: number;
  if (hasImage && box.wide) {
    const top = CARD_H - ZONE_H;
    const outerH = box.ih + 2 * FRAME, outerW = box.iw + 2 * FRAME;
    const iy = Math.round((top - outerH) / 2) + FRAME;
    svg += `<rect x="${MARGIN}" y="${iy - FRAME}" width="${outerW}" height="${outerH}" fill="${FLAME}"/>`;
    layers.push({ input: await fittedAd(f.image!, box), left: MARGIN + FRAME, top: iy });
    rx = 580;
    zoneX = rx;
    zoneY = top;
    infoX = MARGIN;
    infoY = top + 18;
    infoW = rx - 2 * MARGIN;
  } else {
    let outerW: number;
    if (hasImage) {
      outerW = box.iw + 2 * FRAME;
      const outerH = box.ih + 2 * FRAME;
      const iy = Math.round((CARD_H - outerH) / 2);
      svg += `<rect x="${MARGIN}" y="${iy}" width="${outerW}" height="${outerH}" fill="${FLAME}"/>`;
      layers.push({ input: await fittedAd(f.image!, box), left: MARGIN + FRAME, top: iy + FRAME });
    } else {
      outerW = 500 + 2 * FRAME;
      const iy = Math.round((CARD_H - outerW) / 2);
      svg += `<rect x="${MARGIN}" y="${iy}" width="${outerW}" height="${outerW}" fill="${FLAME}"/>`;
      layers.push({ input: await renderMap(f, 5), left: MARGIN + FRAME, top: iy + FRAME });
    }
    rx = MARGIN + outerW + 40;
    zoneX = rx;
    zoneY = CARD_H - ZONE_H;
    infoX = rx;
    infoY = 36;
    infoW = CARD_W - rx - MARGIN;
  }

  // the flame block
  const zoneW = CARD_W - zoneX;
  svg += `<rect x="${zoneX}" y="${zoneY}" width="${zoneW}" height="${ZONE_H}" fill="${FLAME}"/>`;
  const padX = zoneX + 32;
  const b = burnFigure(f);
  const mapSize = 200;
  const showMini = hasImage;
  const figW = zoneW - 64 - (showMini ? mapSize + 24 : 0);
  const labelSize = fit("text", b.label, figW, 34, 20);
  svg += text("text", b.label, padX, zoneY + 62, labelSize, BLACK);
  const figSize = fit("display", b.figure, figW, 132, 40);
  const figY = zoneY + 90 + Math.round(figSize * 0.78);
  svg += text("display", b.figure, padX, figY, figSize, BLACK);
  for (const [i, l] of wrap("text", b.sub, 25, figW, 2).entries()) svg += text("text", l, padX, figY + 46 + i * 30, 25, BLACK);
  if (showMini) {
    const mini = await renderMap(f, 2);
    layers.push({ input: mini, left: CARD_W - 32 - mapSize, top: zoneY + 32 });
  }
  const tagline = "A million pixels. Half of every dollar burns.";
  svg += text("text", tagline, padX, CARD_H - 26, fit("text", tagline, zoneW - 64, 26, 18), BLACK);

  // header on black: logo, then the title or the state, then size and price
  svg += lockup(infoX, infoY);
  let y = infoY + MARK_GRID.h * 3;
  const money = f.usd > 0 ? `$${group(Math.round(f.usd))}` : "";
  const stat = [sizeLine(f), money].filter(Boolean).join(" · ");
  // beside a wide ad the header has the full height down to the card's edge; else it ends above the flame block
  const statBottom = hasImage && box.wide ? CARD_H - 34 : zoneY - 22;
  if (approved) {
    const title = drawableTitle(f.title, f.id);
    const size = title.length > 34 ? 38 : 46;
    const lines = wrap("text", title, size, infoW, 2);
    const room = statBottom - 42 - y;
    const blockH = lines.length * Math.round(size * 1.14);
    y += Math.max(44, Math.round((room - blockH) / 2) + Math.round(size * 0.86));
    for (const l of lines) {
      svg += text("text", l, infoX, y, size, CREAM);
      y += Math.round(size * 1.14);
    }
  } else {
    const h = HEAD[f.state];
    const size = fit("display", h.headline, infoW, 60, 34);
    y += 26 + Math.round(size * 0.8);
    svg += text("display", h.headline, infoX, y, size, CREAM);
    svg += text("text", h.note, infoX, y + 40, fit("text", h.note, infoW, 26, 18), ASH);
  }
  svg += text("mono", stat, infoX, statBottom, fit("mono", stat, infoW, 25, 15), CREAM);

  // a card made on a test network says so
  if (f.cluster !== "mainnet-beta") {
    const t = "TEST NETWORK, NO REAL MONEY";
    const tw = measure(GLYPHS.mono, t, 15);
    svg += `<rect x="0" y="0" width="${tw + 28}" height="26" fill="${CREAM}"/>` + text("mono", t, 14, 19, 15, BLACK);
  }

  const base = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}"><rect width="${CARD_W}" height="${CARD_H}" fill="${BLACK}"/>${svg}</svg>`);
  return sharp(base).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
