// Deterministic procedural pixel-art generator for demo/seed data and tests.
import sharp from "sharp";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RGB = [number, number, number];

const PALETTES: RGB[][] = [
  [[20, 20, 35], [255, 94, 91], [255, 237, 102], [0, 206, 209], [255, 255, 255]],
  [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15], [224, 248, 208]],
  [[34, 32, 52], [69, 40, 60], [172, 50, 50], [223, 113, 38], [251, 242, 54]],
  [[0, 0, 0], [153, 69, 255], [20, 241, 149], [0, 194, 255], [255, 255, 255]],
  [[29, 43, 83], [126, 37, 83], [0, 135, 81], [255, 163, 0], [255, 236, 39]],
  [[250, 250, 245], [230, 57, 70], [29, 53, 87], [69, 123, 157], [168, 218, 220]],
  [[40, 20, 10], [140, 70, 20], [230, 160, 40], [250, 220, 120], [255, 250, 230]],
];

/**
 * Render a w*10 × h*10 PNG (w, h in blocks) in one of several pixel-art styles.
 * Cells are 5×5 px so the art reads as chunky pixels on the canvas.
 */
export async function generatePixelArt(wBlocks: number, hBlocks: number, seed: number): Promise<Buffer> {
  const rng = mulberry32(seed);
  const cell = 5;
  const gw = (wBlocks * 10) / cell, gh = (hBlocks * 10) / cell;
  const pal = PALETTES[Math.floor(rng() * PALETTES.length)]!;
  const pick = () => pal[1 + Math.floor(rng() * (pal.length - 1))]!;
  const grid: RGB[] = new Array(gw * gh).fill(pal[0]);
  const style = Math.floor(rng() * 4);

  if (style === 0) {
    // Mirrored sprite (space-invader style) tiled to the ad's aspect.
    const fg = pick(), accent = pick();
    const sw = Math.min(gw, 8), sh = Math.min(gh, 8);
    const half = Math.ceil(sw / 2);
    const mask: boolean[] = [];
    for (let y = 0; y < sh; y++) for (let x = 0; x < half; x++) mask[y * half + x] = rng() > 0.45;
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const lx = x % sw, ly = y % sh;
        const mx = lx < half ? lx : sw - 1 - lx;
        if (mask[ly * half + mx]) grid[y * gw + x] = (Math.floor(x / sw) + Math.floor(y / sh)) % 2 ? accent : fg;
      }
  } else if (style === 1) {
    // Diagonal stripes / banner
    const a = pick(), b = pick(), wdt = 1 + Math.floor(rng() * 3);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) grid[y * gw + x] = Math.floor((x + y) / wdt) % 2 ? a : b;
    // Solid band in the middle like a logo strip
    const band = Math.floor(gh / 2);
    for (let x = 0; x < gw; x++) grid[band * gw + x] = pal[0]!;
  } else if (style === 2) {
    // Ordered-dither vertical gradient between two palette colors
    const a = pick(), b = pick();
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const t = gh > 1 ? y / (gh - 1) : 0.5;
        grid[y * gw + x] = t * 16 > bayer[(y % 4) * 4 + (x % 4)]! ? a : b;
      }
  } else {
    // Concentric rings / target
    const cx = (gw - 1) / 2, cy = (gh - 1) / 2;
    const cols = [pick(), pick(), pal[0]!];
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
        grid[y * gw + x] = cols[Math.floor(d) % cols.length]!;
      }
  }

  const raw = Buffer.alloc(gw * gh * 3);
  grid.forEach((c, i) => raw.set(c, i * 3));
  return sharp(raw, { raw: { width: gw, height: gh, channels: 3 } })
    .resize(wBlocks * 10, hBlocks * 10, { kernel: "nearest" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
