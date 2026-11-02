/**
 * Procedural pixel-art ads for the mock canvas. Deterministic per ad id.
 * Everything is drawn with integer rects so it stays crisp at 10px/block.
 */
import { BLOCK_PX } from "./config";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Saturated palettes in the spirit of 2005 banner ads, plus a few 2026 ones.
const PALETTES: string[][] = [
  ["#ff2e63", "#08d9d6", "#252a34", "#eaeaea"],
  ["#ffde00", "#ff5400", "#1a1a1a", "#ffffff"],
  ["#00a8e8", "#003459", "#ffffff", "#ffd400"],
  ["#7bd389", "#1b512d", "#f2f7f2", "#ff6b35"],
  ["#ff006e", "#8338ec", "#ffbe0b", "#ffffff"],
  ["#3a86ff", "#ffffff", "#fb5607", "#0b090a"],
  ["#06d6a0", "#073b4c", "#ffd166", "#ef476f"],
  ["#e63946", "#f1faee", "#1d3557", "#a8dadc"],
  ["#ff9f1c", "#2ec4b6", "#ffffff", "#011627"],
  ["#c1121f", "#fdf0d5", "#003049", "#669bbc"],
  ["#b5179e", "#4cc9f0", "#f72585", "#ffffff"],
  ["#2d00f7", "#f20089", "#ffffff", "#ffd60a"],
  ["#55a630", "#ffff3f", "#0b090a", "#ffffff"],
  ["#ff5d8f", "#ffe5ec", "#3d0b1f", "#ffb703"],
  ["#14213d", "#fca311", "#e5e5e5", "#ffffff"],
  ["#00f5d4", "#9b5de5", "#f15bb5", "#fee440"],
  ["#d00000", "#ffba08", "#03071e", "#ffffff"],
  ["#0096c7", "#caf0f8", "#023e8a", "#ff006e"],
];

// 3x5 pixel font for initials and short words.
const FONT: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
  E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
  Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111", "0": "111101101101111", "1": "010110010010111",
  "2": "110001010100111", "3": "110001010001110", "4": "101101111001001", "5": "111100110001110",
  "6": "011100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001110",
  $: "011110010011110", "!": "010010010000010", " ": "000000000000000", ".": "000000000000010",
};

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: number, color: string) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] ?? FONT[" "];
    for (let i = 0; i < 15; i++) if (g[i] === "1") ctx.fillRect(cx + (i % 3) * s, y + Math.floor(i / 3) * s, s, s);
    cx += 4 * s;
  }
  return cx - x - s;
}

type Style = "sprite" | "logo" | "sunset" | "pattern" | "coin" | "banner" | "landscape" | "eye";

export function pickStyle(rand: () => number, w: number, h: number): Style {
  const aspect = w / h;
  if (aspect >= 3 && w >= 4) return rand() < 0.75 ? "banner" : "sunset";
  if (w === 1 && h === 1) return (["sprite", "coin", "pattern", "logo"] as Style[])[Math.floor(rand() * 4)];
  const pool: Style[] = ["sprite", "logo", "sunset", "pattern", "coin", "landscape", "eye", "banner"];
  return pool[Math.floor(rand() * pool.length)];
}

/**
 * Paint one ad into ctx at block coordinates. `title` feeds wordmarks.
 */
export function paintAd(
  ctx: CanvasRenderingContext2D,
  ad: { id: number; x: number; y: number; w: number; h: number; title: string },
) {
  const rand = mulberry32(ad.id * 9973 + 17);
  const pal = PALETTES[Math.floor(rand() * PALETTES.length)];
  const [c0, c1, c2, c3] = pal;
  const X = ad.x * BLOCK_PX;
  const Y = ad.y * BLOCK_PX;
  const W = ad.w * BLOCK_PX;
  const H = ad.h * BLOCK_PX;
  const style = pickStyle(rand, ad.w, ad.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(X, Y, W, H);
  ctx.clip();
  ctx.fillStyle = c0;
  ctx.fillRect(X, Y, W, H);

  switch (style) {
    case "sprite": {
      // symmetric 5x5 / 7x7 creature, identicon style
      const n = W >= 40 && H >= 40 ? 7 : 5;
      const cell = Math.max(1, Math.floor(Math.min(W, H) / (n + 1)));
      const ox = X + Math.floor((W - cell * n) / 2);
      const oy = Y + Math.floor((H - cell * n) / 2);
      ctx.fillStyle = c2;
      ctx.fillRect(X, Y, W, H);
      ctx.fillStyle = c1;
      const half = Math.ceil(n / 2);
      for (let r = 0; r < n; r++)
        for (let c = 0; c < half; c++)
          if (rand() > 0.48) {
            ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
            ctx.fillRect(ox + (n - 1 - c) * cell, oy + r * cell, cell, cell);
          }
      // eyes
      ctx.fillStyle = c3;
      ctx.fillRect(ox + 1 * cell, oy + 1 * cell, cell, cell);
      ctx.fillRect(ox + (n - 2) * cell, oy + 1 * cell, cell, cell);
      break;
    }
    case "logo": {
      const initials = ad.title.replace(/[^A-Za-z0-9$ ]/g, "").split(/\s+/).map((s) => s[0] ?? "").join("").slice(0, 3) || "AD";
      const s = Math.max(1, Math.floor(Math.min(W / (initials.length * 4 + 1), H / 7)));
      const tw = initials.length * 4 * s - s;
      ctx.fillStyle = c1;
      if (rand() > 0.5) ctx.fillRect(X + 1, Y + 1, W - 2, H - 2);
      ctx.fillStyle = c0;
      ctx.fillRect(X + 2, Y + 2, W - 4, H - 4);
      drawText(ctx, initials, X + Math.floor((W - tw) / 2), Y + Math.floor((H - 5 * s) / 2), s, c2);
      break;
    }
    case "sunset": {
      const bands = 5;
      for (let i = 0; i < bands; i++) {
        ctx.fillStyle = [c0, c3, c1, c2, c0][i];
        ctx.fillRect(X, Y + Math.floor((i * H) / bands), W, Math.ceil(H / bands));
      }
      const r = Math.max(2, Math.floor(Math.min(W, H) * 0.32));
      const cx = X + Math.floor(W * (0.3 + rand() * 0.4));
      const cy = Y + Math.floor(H * 0.55);
      ctx.fillStyle = c3;
      for (let dy = -r; dy <= 0; dy += 1) {
        const hw = Math.floor(Math.sqrt(r * r - dy * dy));
        if ((dy + r) % 3 !== 2) ctx.fillRect(cx - hw, cy + dy, hw * 2, 1);
      }
      ctx.fillStyle = c2;
      ctx.fillRect(X, cy, W, Y + H - cy);
      break;
    }
    case "pattern": {
      const cell = Math.max(2, Math.floor(BLOCK_PX / (1 + Math.floor(rand() * 2))));
      const kind = Math.floor(rand() * 3);
      ctx.fillStyle = c1;
      for (let py = 0; py < H; py += cell)
        for (let px = 0; px < W; px += cell) {
          const i = px / cell, j = py / cell;
          const on = kind === 0 ? (i + j) % 2 === 0 : kind === 1 ? (i + j) % 3 === 0 : Math.abs(((i - j) % 4)) < 1;
          if (on) ctx.fillRect(X + px, Y + py, cell, cell);
        }
      break;
    }
    case "coin": {
      ctx.fillStyle = c2;
      ctx.fillRect(X, Y, W, H);
      const r = Math.floor(Math.min(W, H) * 0.42);
      const cx = X + W / 2;
      const cy = Y + H / 2;
      for (let dy = -r; dy <= r; dy++) {
        const hw = Math.floor(Math.sqrt(r * r - dy * dy));
        ctx.fillStyle = Math.abs(dy) > r - 2 || hw < 2 ? c1 : c3;
        ctx.fillRect(Math.round(cx - hw), Math.round(cy + dy), hw * 2, 1);
      }
      const s = Math.max(1, Math.floor(r / 4));
      drawText(ctx, "$", Math.round(cx - 1.5 * s), Math.round(cy - 2.5 * s), s, c1);
      break;
    }
    case "banner": {
      ctx.fillStyle = c1;
      ctx.fillRect(X, Y, W, H);
      ctx.fillStyle = c0;
      ctx.fillRect(X, Y + H - Math.max(2, Math.floor(H / 6)), W, Math.max(2, Math.floor(H / 6)));
      const word = ad.title.replace(/[^A-Za-z0-9$! .]/g, "").toUpperCase().slice(0, 18);
      const s = Math.max(1, Math.min(Math.floor((H - 4) / 6), Math.floor((W - 6) / (word.length * 4))));
      const tw = word.length * 4 * s - s;
      if (tw > 0 && s >= 1) drawText(ctx, word, X + Math.max(3, Math.floor((W - tw) / 2)), Y + Math.floor((H - 5 * s) / 2) - 1, s, c3);
      break;
    }
    case "landscape": {
      ctx.fillStyle = c3;
      ctx.fillRect(X, Y, W, H);
      ctx.fillStyle = c1;
      let h = H * 0.5;
      for (let px = 0; px < W; px += 2) {
        h += (rand() - 0.5) * 6;
        h = Math.max(H * 0.25, Math.min(H * 0.8, h));
        ctx.fillRect(X + px, Y + Math.floor(H - h), 2, Math.ceil(h));
      }
      ctx.fillStyle = c2;
      ctx.fillRect(X, Y + Math.floor(H * 0.82), W, Math.ceil(H * 0.18));
      break;
    }
    case "eye": {
      ctx.fillStyle = c2;
      ctx.fillRect(X, Y, W, H);
      const rings = [c1, c3, c0, c2];
      const r0 = Math.floor(Math.min(W, H) / 2) - 1;
      rings.forEach((col, k) => {
        const r = Math.floor(r0 * (1 - k * 0.24));
        ctx.fillStyle = col;
        for (let dy = -r; dy <= r; dy++) {
          const hw = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
          ctx.fillRect(Math.round(X + W / 2 - hw), Math.round(Y + H / 2 + dy), hw * 2, 1);
        }
      });
      break;
    }
  }
  ctx.restore();
}
