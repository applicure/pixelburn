import { BITMAP_BYTES, GRID, MAX_IMAGE_URI_LEN, MAX_LINK_LEN, MAX_TITLE_LEN, TOTAL_BLOCKS } from "./params.js";

/** Rectangle in block units (1 block = 10x10 px). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Block index = by * 100 + bx. Bitmap bit for index i: byte i>>3, bit i&7 (LSB first) — same as on-chain. */
export function blockIndex(bx: number, by: number): number {
  if (!isInt(bx) || !isInt(by) || bx < 0 || by < 0 || bx >= GRID || by >= GRID) {
    throw new RangeError(`block (${bx},${by}) out of range`);
  }
  return by * GRID + bx;
}

export function blockCoords(index: number): { bx: number; by: number } {
  if (!isInt(index) || index < 0 || index >= TOTAL_BLOCKS) throw new RangeError(`bad block index ${index}`);
  return { bx: index % GRID, by: Math.floor(index / GRID) };
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

/** Same rule as the program: integers, w,h >= 1, x+w <= 100, y+h <= 100. */
export function isValidRect(r: Rect): boolean {
  return (
    isInt(r.x) && isInt(r.y) && isInt(r.w) && isInt(r.h) &&
    r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 &&
    r.x + r.w <= GRID && r.y + r.h <= GRID
  );
}

export function assertValidRect(r: Rect): void {
  if (!isValidRect(r)) throw new RangeError(`invalid rect ${JSON.stringify(r)}`);
}

/** All block indices covered by the rect, row-major. Throws on an invalid rect. */
export function rectBlocks(r: Rect): number[] {
  assertValidRect(r);
  const out: number[] = [];
  for (let by = r.y; by < r.y + r.h; by++) for (let bx = r.x; bx < r.x + r.w; bx++) out.push(by * GRID + bx);
  return out;
}

export function rectBlockCount(r: Rect): number {
  assertValidRect(r);
  return r.w * r.h;
}

export function isBlockSet(bitmap: Uint8Array, index: number): boolean {
  return ((bitmap[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

function checkBitmap(bitmap: Uint8Array): void {
  if (bitmap.length !== BITMAP_BYTES) throw new RangeError(`bitmap must be ${BITMAP_BYTES} bytes, got ${bitmap.length}`);
}

/** True if the rect is valid and none of its blocks are sold. Invalid rects return false. */
export function isRectFree(bitmap: Uint8Array, r: Rect): boolean {
  checkBitmap(bitmap);
  if (!isValidRect(r)) return false;
  for (let by = r.y; by < r.y + r.h; by++) {
    for (let bx = r.x; bx < r.x + r.w; bx++) if (isBlockSet(bitmap, by * GRID + bx)) return false;
  }
  return true;
}

/** Returns a copy of the bitmap with the rect's blocks set. */
export function markRect(bitmap: Uint8Array, r: Rect): Uint8Array {
  checkBitmap(bitmap);
  const out = new Uint8Array(bitmap);
  for (const i of rectBlocks(r)) out[i >> 3]! |= 1 << (i & 7);
  return out;
}

export function countSet(bitmap: Uint8Array): number {
  let n = 0;
  for (const b of bitmap) {
    let v = b;
    while (v) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}

export function freeBlocks(bitmap: Uint8Array): number[] {
  checkBitmap(bitmap);
  const out: number[] = [];
  for (let i = 0; i < TOTAL_BLOCKS; i++) if (!isBlockSet(bitmap, i)) out.push(i);
  return out;
}

export function emptyBitmap(): Uint8Array {
  return new Uint8Array(BITMAP_BYTES);
}

/** Mirrors the on-chain content validation (byte lengths, schemes, no control/whitespace in URLs). */
export function validateAdContent(c: { title: string; link: string; imageUri: string }): string | null {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  // eslint-disable-next-line no-control-regex
  const badTitle = (s: string) => /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(s);
  const badUrl = (s: string) => !/^[\x21-\x7e]*$/.test(s);
  if (bytes(c.title) > MAX_TITLE_LEN || badTitle(c.title)) return "title must be <= 64 bytes without control/format characters";
  if (bytes(c.link) > MAX_LINK_LEN || !c.link.startsWith("https://") || c.link.length <= 8 || badUrl(c.link))
    return "link must be https://, printable ASCII, <= 200 bytes";
  const okScheme =
    (c.imageUri.startsWith("ar://") && c.imageUri.length > 5) ||
    (c.imageUri.startsWith("https://") && c.imageUri.length > 8);
  if (bytes(c.imageUri) > MAX_IMAGE_URI_LEN || !okScheme || badUrl(c.imageUri))
    return "image URI must be ar:// or https://, printable ASCII, <= 200 bytes";
  return null;
}
