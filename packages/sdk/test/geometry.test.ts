import { describe, expect, it } from "vitest";
import {
  BITMAP_BYTES,
  blockCoords,
  blockIndex,
  countSet,
  emptyBitmap,
  freeBlocks,
  isBlockSet,
  isRectFree,
  isValidRect,
  markRect,
  rectBlockCount,
  rectBlocks,
  validateAdContent,
} from "../src/index.js";

describe("geometry", () => {
  it("block index", () => {
    expect(blockIndex(0, 0)).toBe(0);
    expect(blockIndex(99, 0)).toBe(99);
    expect(blockIndex(0, 1)).toBe(100);
    expect(blockIndex(99, 99)).toBe(9_999);
    expect(() => blockIndex(100, 0)).toThrow();
    expect(() => blockIndex(-1, 0)).toThrow();
    expect(() => blockIndex(1.5, 0)).toThrow();
    expect(blockCoords(9_999)).toEqual({ bx: 99, by: 99 });
  });

  it("rect validation at the edges", () => {
    expect(isValidRect({ x: 0, y: 0, w: 100, h: 100 })).toBe(true);
    expect(isValidRect({ x: 99, y: 99, w: 1, h: 1 })).toBe(true);
    expect(isValidRect({ x: 90, y: 0, w: 10, h: 1 })).toBe(true); // x+w == 100
    expect(isValidRect({ x: 91, y: 0, w: 10, h: 1 })).toBe(false);
    expect(isValidRect({ x: 0, y: 99, w: 1, h: 2 })).toBe(false);
    expect(isValidRect({ x: 0, y: 0, w: 0, h: 1 })).toBe(false);
    expect(isValidRect({ x: -1, y: 0, w: 1, h: 1 })).toBe(false);
    expect(isValidRect({ x: 0.5, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("rectBlocks", () => {
    expect(rectBlocks({ x: 98, y: 98, w: 2, h: 2 })).toEqual([9_898, 9_899, 9_998, 9_999]);
    expect(rectBlockCount({ x: 0, y: 0, w: 100, h: 100 })).toBe(10_000);
    expect(() => rectBlocks({ x: 99, y: 0, w: 2, h: 1 })).toThrow();
  });

  it("bitmap layout matches the program (LSB first)", () => {
    const bm = markRect(emptyBitmap(), { x: 99, y: 99, w: 1, h: 1 });
    expect(bm[1249]).toBe(0b1000_0000);
    const bm2 = markRect(emptyBitmap(), { x: 0, y: 0, w: 1, h: 1 });
    expect(bm2[0]).toBe(1);
    const bm3 = markRect(emptyBitmap(), { x: 8, y: 0, w: 1, h: 1 });
    expect(bm3[1]).toBe(1);
  });

  it("overlap / adjacency", () => {
    let bm = markRect(emptyBitmap(), { x: 10, y: 10, w: 5, h: 5 });
    expect(isRectFree(bm, { x: 5, y: 10, w: 5, h: 5 })).toBe(true);
    expect(isRectFree(bm, { x: 15, y: 10, w: 5, h: 5 })).toBe(true);
    expect(isRectFree(bm, { x: 10, y: 5, w: 5, h: 5 })).toBe(true);
    expect(isRectFree(bm, { x: 10, y: 15, w: 5, h: 5 })).toBe(true);
    expect(isRectFree(bm, { x: 14, y: 14, w: 5, h: 5 })).toBe(false);
    expect(isRectFree(bm, { x: 0, y: 0, w: 100, h: 100 })).toBe(false);
    expect(isRectFree(bm, { x: 99, y: 0, w: 2, h: 1 })).toBe(false); // invalid
    bm = markRect(bm, { x: 0, y: 0, w: 100, h: 1 });
    expect(countSet(bm)).toBe(125);
    expect(freeBlocks(bm).length).toBe(10_000 - 125);
    expect(isBlockSet(bm, 50)).toBe(true);
    expect(() => isRectFree(new Uint8Array(10), { x: 0, y: 0, w: 1, h: 1 })).toThrow();
  });

  it("random rects agree with a naive set", () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 50; round++) {
      let bm = emptyBitmap();
      const naive = new Set<number>();
      for (let k = 0; k < 15; k++) {
        const w = rnd(30) + 1, h = rnd(30) + 1;
        const r = { x: rnd(101 - w), y: rnd(101 - h), w, h };
        bm = markRect(bm, r);
        rectBlocks(r).forEach((i) => naive.add(i));
      }
      expect(countSet(bm)).toBe(naive.size);
      for (let k = 0; k < 200; k++) {
        const w = rnd(100) + 1, h = rnd(100) + 1;
        const r = { x: rnd(101 - w), y: rnd(101 - h), w, h };
        expect(isRectFree(bm, r)).toBe(rectBlocks(r).every((i) => !naive.has(i)));
      }
    }
    expect(emptyBitmap().length).toBe(BITMAP_BYTES);
  });

  it("content validation mirrors the program", () => {
    const ok = { title: "hi", link: "https://a.b", imageUri: "ar://x" };
    expect(validateAdContent(ok)).toBeNull();
    expect(validateAdContent({ ...ok, link: "http://a.b" })).not.toBeNull();
    expect(validateAdContent({ ...ok, link: "https://" })).not.toBeNull();
    expect(validateAdContent({ ...ok, link: "https://a b" })).not.toBeNull();
    expect(validateAdContent({ ...ok, imageUri: "ipfs://x" })).not.toBeNull();
    expect(validateAdContent({ ...ok, title: "a\nb" })).not.toBeNull();
    expect(validateAdContent({ ...ok, title: "a".repeat(65) })).not.toBeNull();
    expect(validateAdContent({ ...ok, title: "a".repeat(64) })).toBeNull();
    expect(validateAdContent({ ...ok, title: "é".repeat(33) })).not.toBeNull(); // 66 bytes
    expect(validateAdContent({ ...ok, title: "héllo wörld ✓" })).toBeNull();
    expect(validateAdContent({ ...ok, title: "evil\u202Egnp" })).not.toBeNull(); // bidi override
    expect(validateAdContent({ ...ok, title: "a\u200Bb" })).not.toBeNull(); // zero-width
    expect(validateAdContent({ ...ok, link: "https://exаmple.com" })).not.toBeNull(); // Cyrillic а
    expect(validateAdContent({ ...ok, imageUri: "ar://x\u200B" })).not.toBeNull();
  });
});
