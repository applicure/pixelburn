import { BITMAP_BYTES, GRID, TOTAL_BLOCKS } from "../constants.js";

// Bit order (ASSUMPTION until @mpb/sdk confirms): block i -> byte i>>3, bit (i & 7), LSB first.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const blockIndex = (bx: number, by: number) => by * GRID + bx;

export function isValidRect(r: Rect): boolean {
  return (
    [r.x, r.y, r.w, r.h].every(Number.isInteger) &&
    r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 &&
    r.x + r.w <= GRID && r.y + r.h <= GRID
  );
}

export function rectBlocks(r: Rect): number[] {
  const out: number[] = [];
  for (let by = r.y; by < r.y + r.h; by++) for (let bx = r.x; bx < r.x + r.w; bx++) out.push(blockIndex(bx, by));
  return out;
}

export function emptyBitmap(): Uint8Array {
  return new Uint8Array(BITMAP_BYTES);
}

export function setBlock(bm: Uint8Array, i: number): void {
  if (i < 0 || i >= TOTAL_BLOCKS) throw new RangeError(`block ${i} out of range`);
  bm[i >> 3]! |= 1 << (i & 7);
}

export function getBlock(bm: Uint8Array, i: number): boolean {
  return ((bm[i >> 3]! >> (i & 7)) & 1) === 1;
}

export function countBits(bm: Uint8Array): number {
  let n = 0;
  for (const b of bm) {
    let v = b;
    while (v) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}

export function isRectFree(bm: Uint8Array, r: Rect): boolean {
  return rectBlocks(r).every((i) => !getBlock(bm, i));
}

/** Bounding box of an arbitrary block list. */
export function blocksBoundingRect(blocks: number[]): Rect {
  let minX = GRID, minY = GRID, maxX = -1, maxY = -1;
  for (const i of blocks) {
    const bx = i % GRID, by = Math.floor(i / GRID);
    minX = Math.min(minX, bx); minY = Math.min(minY, by);
    maxX = Math.max(maxX, bx); maxY = Math.max(maxY, by);
  }
  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Blocks covered by an ad row: explicit list (auction ad) or its rectangle. */
export function adBlocks(ad: Rect & { blocks?: number[] | null }): number[] {
  return ad.blocks && ad.blocks.length ? ad.blocks : rectBlocks(ad);
}
