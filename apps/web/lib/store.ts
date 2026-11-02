"use client";
/**
 * Live client store: stats, ads, feed, occupancy and the composed 1000×1000 canvas.
 * Fed by api.* on boot and by the SSE stream (or the mock event loop) afterwards.
 */
import { useSyncExternalStore } from "react";
import { paintAd } from "./adArt";
import { api } from "./api";
import { BLOCK_PX, CANVAS_PX } from "./config";
import { base64ToBytes, bitSet, rectBlocks } from "./quote";
import type { Ad, FeedItem, Stats } from "./types";

export interface LiveState {
  ready: boolean;
  error: string | null;
  connection: "connecting" | "open" | "error";
  stats: Stats | null;
  ads: Ad[];
  feed: FeedItem[];
  occupancy: Uint8Array;
  canvasVersion: number;
}

let state: LiveState = {
  ready: false,
  error: null,
  connection: "connecting",
  stats: null,
  ads: [],
  feed: [],
  occupancy: new Uint8Array(1250),
  canvasVersion: 0,
};

const subs = new Set<() => void>();
const eventSubs = new Set<(f: FeedItem) => void>();
const set = (patch: Partial<LiveState>) => {
  state = { ...state, ...patch };
  subs.forEach((s) => s());
};

let canvasEl: HTMLCanvasElement | null = null;
const imgCache = new Map<string, HTMLImageElement>();

export function getCanvas() {
  if (typeof document === "undefined") return null;
  if (!canvasEl) {
    canvasEl = document.createElement("canvas");
    canvasEl.width = CANVAS_PX;
    canvasEl.height = CANVAS_PX;
  }
  return canvasEl;
}

function drawAd(ad: Ad) {
  const c = getCanvas();
  const ctx = c?.getContext("2d");
  if (!ctx) return;
  if (ad.imageUrl.startsWith("mock://")) {
    paintAd(ctx, ad);
    return;
  }
  const img = imgCache.get(ad.imageUrl) ?? new Image();
  imgCache.set(ad.imageUrl, img);
  img.crossOrigin = "anonymous";
  const draw = () => {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, ad.x * BLOCK_PX, ad.y * BLOCK_PX, ad.w * BLOCK_PX, ad.h * BLOCK_PX);
    set({ canvasVersion: state.canvasVersion + 1 });
  };
  if (img.complete && img.naturalWidth) draw();
  else {
    img.onload = draw;
    if (!img.src) img.src = ad.imageUrl;
  }
}

function loadCanvasPng() {
  const url = api.canvasPngUrl();
  if (!url) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const ctx = getCanvas()?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    ctx.drawImage(img, 0, 0);
    set({ canvasVersion: state.canvasVersion + 1 });
  };
  img.src = `${url}?v=${Date.now()}`;
}

let pngTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function startLive() {
  if (started || typeof window === "undefined") return;
  started = true;
  (async () => {
    try {
      const [stats, ads, feed, occ] = await Promise.all([api.getStats(), api.getAds(), api.getFeed(60), api.getOccupancy()]);
      if (api.mode === "mock") ads.forEach(drawAd);
      else loadCanvasPng();
      set({
        ready: true,
        stats,
        ads,
        feed,
        occupancy: base64ToBytes(occ.bitmap),
        canvasVersion: state.canvasVersion + 1,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Could not reach the API", ready: true });
    }
  })();

  api.subscribe({
    status: (s) => set({ connection: s }),
    stats: (stats) => set({ stats }),
    feed: async (item) => {
      set({ feed: [item, ...state.feed].slice(0, 120) });
      eventSubs.forEach((fn) => fn(item));
      if (item.type !== "purchase") return;
      const occ = new Uint8Array(state.occupancy);
      for (const i of rectBlocks(item)) bitSet(occ, i);
      set({ occupancy: occ });
      try {
        const ad = await api.getAd(item.adId);
        if (api.mode === "mock") drawAd(ad);
        else {
          if (pngTimer) clearTimeout(pngTimer);
          pngTimer = setTimeout(loadCanvasPng, 1500);
        }
        set({ ads: [...state.ads.filter((a) => a.id !== ad.id), ad], canvasVersion: state.canvasVersion + 1 });
      } catch {
        // unapproved ads 404 until moderation: occupancy already updated, nothing to draw
      }
    },
  });
}

export function useLive<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      startLive();
      return () => subs.delete(cb);
    },
    () => select(state),
    () => select(state),
  );
}

export function onLiveEvent(fn: (f: FeedItem) => void) {
  eventSubs.add(fn);
  startLive();
  return () => {
    eventSubs.delete(fn);
  };
}

export const getLiveState = () => state;
