"use client";
/**
 * Full-screen billboard viewport.
 * - Pan: drag (explore mode) / two fingers / space+drag / middle mouse, with momentum
 *   projection on release and rubber-banding past the edges.
 * - Zoom: wheel or trackpad pinch around the cursor, two-finger pinch on touch.
 * - Select: drag snaps a rectangle to whole blocks; sold blocks are shaded.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { BLOCK_PX, CANVAS_PX, GRID } from "@/lib/config";
import { bitGet, isRectFree } from "@/lib/quote";
import { getCanvas } from "@/lib/store";
import type { Ad, Rect } from "@/lib/types";

export interface View {
  s: number;
  x: number;
  y: number;
}
export interface ViewportHandle {
  zoomBy(f: number, cx?: number, cy?: number): void;
  fit(): void;
  centerOn(bx: number, by: number, s?: number): void;
  getView(): View;
  size(): { w: number; h: number };
}

interface Props {
  mode: "explore" | "select";
  ads: Ad[];
  occupancy: Uint8Array;
  canvasVersion: number;
  selection: Rect | null;
  cursor: { x: number; y: number } | null;
  flash: Rect | null;
  onSelect(r: Rect | null, done: boolean): void;
  onHover(ad: Ad | null, sx: number, sy: number, block: { x: number; y: number } | null): void;
  onActivate(ad: Ad): void;
  onView(v: View, w: number, h: number): void;
  reduceMotion: boolean;
}

const MAX_S = 40;
const rubber = (o: number, d: number, c = 0.55) => (o * d * c) / (d + c * Math.abs(o));

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport(p, ref) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ s: 1, x: 0, y: 0 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const props = useRef(p);
  const dirty = useRef(true);
  const anim = useRef<{ vx: number; vy: number; target?: View; t0?: number; from?: View } | null>(null);
  const ownerIdx = useRef<Int32Array>(new Int32Array(GRID * GRID).fill(-1));
  const occOverlay = useRef<HTMLCanvasElement | null>(null);
  const flashT = useRef(0);
  useEffect(() => {
    props.current = p;
    dirty.current = true;
  });

  // block → ad index for hit testing
  useEffect(() => {
    const idx = new Int32Array(GRID * GRID).fill(-1);
    p.ads.forEach((a, i) => {
      if (a.blocks?.length) for (const b of a.blocks) idx[b] = i; // auction lot: scattered blocks
      else for (let y = a.y; y < a.y + a.h; y++) for (let x = a.x; x < a.x + a.w; x++) idx[y * GRID + x] = i;
    });
    ownerIdx.current = idx;
  }, [p.ads]);

  // sold-block shade (100×100, scaled with nearest neighbour)
  useEffect(() => {
    const c = occOverlay.current ?? document.createElement("canvas");
    c.width = GRID;
    c.height = GRID;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(GRID, GRID);
    for (let i = 0; i < GRID * GRID; i++) {
      const sold = bitGet(p.occupancy, i);
      img.data[i * 4 + 0] = 0;
      img.data[i * 4 + 1] = 0;
      img.data[i * 4 + 2] = 0;
      img.data[i * 4 + 3] = sold ? 170 : 0;
    }
    ctx.putImageData(img, 0, 0);
    occOverlay.current = c;
    dirty.current = true;
  }, [p.occupancy]);

  useEffect(() => {
    if (p.flash) flashT.current = performance.now();
  }, [p.flash]);

  const bounds = useCallback((s: number) => {
    const { w, h } = size.current;
    const cw = CANVAS_PX * s;
    const ch = CANVAS_PX * s;
    const m = 80;
    // keep at least part of the billboard on screen; centre it when smaller than the viewport
    const minX = cw < w ? (w - cw) / 2 : w - cw - m;
    const maxX = cw < w ? (w - cw) / 2 : m;
    const minY = ch < h ? (h - ch) / 2 : h - ch - m;
    const maxY = ch < h ? (h - ch) / 2 : m + 56;
    return { minX, maxX, minY, maxY };
  }, []);

  const fitScale = useCallback(() => {
    const { w, h } = size.current;
    return Math.min((w - 32) / CANVAS_PX, (h - 56 - 120) / CANVAS_PX);
  }, []);

  const animateTo = useCallback((t: View) => {
    if (props.current.reduceMotion) {
      view.current = t;
      dirty.current = true;
      return;
    }
    anim.current = { vx: 0, vy: 0, target: t, from: { ...view.current }, t0: performance.now() };
  }, []);

  const clampView = useCallback(
    (v: View): View => {
      const b = bounds(v.s);
      return { s: v.s, x: Math.min(b.maxX, Math.max(b.minX, v.x)), y: Math.min(b.maxY, Math.max(b.minY, v.y)) };
    },
    [bounds],
  );

  const zoomAt = useCallback(
    (ns: number, cx: number, cy: number, animate = false) => {
      const v = view.current;
      const s = Math.min(MAX_S, Math.max(fitScale() * 0.75, ns));
      const k = s / v.s;
      const next = clampView({ s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
      if (animate) animateTo(next);
      else {
        view.current = next;
        dirty.current = true;
      }
    },
    [animateTo, clampView, fitScale],
  );

  useImperativeHandle(ref, () => ({
    zoomBy: (f, cx, cy) => zoomAt(view.current.s * f, cx ?? size.current.w / 2, cy ?? size.current.h / 2, true),
    fit: () => {
      const s = fitScale();
      const { w, h } = size.current;
      animateTo({ s, x: (w - CANVAS_PX * s) / 2, y: 56 + (h - 56 - 120 - CANVAS_PX * s) / 2 + 8 });
    },
    centerOn: (bx, by, s) => {
      const ns = s ?? view.current.s;
      const { w, h } = size.current;
      animateTo(clampView({ s: ns, x: w / 2 - (bx * BLOCK_PX + 5) * ns, y: h / 2 - (by * BLOCK_PX + 5) * ns }));
    },
    getView: () => view.current,
    size: () => ({ w: size.current.w, h: size.current.h }),
  }));

  // ---------- render loop ----------
  useEffect(() => {
    const cv = cvRef.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    let first = true;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      size.current = { w, h, dpr };
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      if (first) {
        first = false;
        const s = fitScale();
        view.current = { s, x: (w - CANVAS_PX * s) / 2, y: 56 + (h - 56 - 120 - CANVAS_PX * s) / 2 + 8 };
      } else view.current = clampView(view.current);
      dirty.current = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    resize();

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // view animation (critically damped glide to a target) or momentum
      const a = anim.current;
      if (a?.target && a.from && a.t0 !== undefined) {
        const t = Math.min(1, (now - a.t0) / 420);
        const e = 1 - Math.pow(1 - t, 4);
        const f = a.from, g = a.target;
        // interpolate scale geometrically so zoom feels even
        const s = f.s * Math.pow(g.s / f.s, e);
        view.current = { s, x: f.x + (g.x - f.x) * e, y: f.y + (g.y - f.y) * e };
        dirty.current = true;
        if (t >= 1) anim.current = null;
      } else if (a && (Math.abs(a.vx) > 0.02 || Math.abs(a.vy) > 0.02)) {
        const v = view.current;
        const b = bounds(v.s);
        let nx = v.x + a.vx * 16;
        let ny = v.y + a.vy * 16;
        a.vx *= 0.94;
        a.vy *= 0.94;
        // past an edge: spring back instead of continuing
        if (nx > b.maxX || nx < b.minX) {
          const edge = nx > b.maxX ? b.maxX : b.minX;
          nx += (edge - nx) * 0.2;
          a.vx *= 0.6;
        }
        if (ny > b.maxY || ny < b.minY) {
          const edge = ny > b.maxY ? b.maxY : b.minY;
          ny += (edge - ny) * 0.2;
          a.vy *= 0.6;
        }
        view.current = { s: v.s, x: nx, y: ny };
        dirty.current = true;
      } else if (a) {
        anim.current = null;
        const c = clampView(view.current);
        if (c.x !== view.current.x || c.y !== view.current.y) animateTo(c);
      }
      const flashing = now - flashT.current < 1800;
      if (!dirty.current && !flashing) return;
      dirty.current = false;

      const { w, h, dpr } = size.current;
      const { s, x, y } = view.current;
      const P = props.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0d0907";
      ctx.fillRect(0, 0, w, h);

      // kiln shelf shadow under the billboard
      ctx.fillStyle = "rgba(255,100,0,0.07)";
      ctx.fillRect(x - 6, y - 6, CANVAS_PX * s + 12, CANVAS_PX * s + 12);
      ctx.fillStyle = "#16110e";
      ctx.fillRect(x, y, CANVAS_PX * s, CANVAS_PX * s);

      const src = getCanvas();
      ctx.imageSmoothingEnabled = s < 1;
      if (src) ctx.drawImage(src, x, y, CANVAS_PX * s, CANVAS_PX * s);

      // block grid once blocks are big enough to see
      const bs = BLOCK_PX * s;
      if (bs >= 7) {
        ctx.strokeStyle = `rgba(255,245,220,${Math.min(0.1, (bs - 7) / 60)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const x0 = Math.max(0, Math.floor(-x / bs)), x1 = Math.min(GRID, Math.ceil((w - x) / bs));
        const y0 = Math.max(0, Math.floor(-y / bs)), y1 = Math.min(GRID, Math.ceil((h - y) / bs));
        for (let i = x0; i <= x1; i++) {
          const px = Math.round(x + i * bs) + 0.5;
          ctx.moveTo(px, y + y0 * bs);
          ctx.lineTo(px, y + y1 * bs);
        }
        for (let j = y0; j <= y1; j++) {
          const py = Math.round(y + j * bs) + 0.5;
          ctx.moveTo(x + x0 * bs, py);
          ctx.lineTo(x + x1 * bs, py);
        }
        ctx.stroke();
      }

      if (P.mode === "select" && occOverlay.current) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(occOverlay.current, x, y, CANVAS_PX * s, CANVAS_PX * s);
      }

      // freshly bought rectangle glows white-hot then cools
      if (flashing && P.flash) {
        const k = 1 - (now - flashT.current) / 1800;
        const r = P.flash;
        ctx.fillStyle = `rgba(255,194,61,${0.5 * k})`;
        ctx.fillRect(x + r.x * bs, y + r.y * bs, r.w * bs, r.h * bs);
        ctx.strokeStyle = `rgba(255,245,220,${k})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + r.x * bs - 2, y + r.y * bs - 2, r.w * bs + 4, r.h * bs + 4);
      }

      const sel = P.selection;
      if (sel) {
        const free = isRectFree(P.occupancy, sel);
        const rx = x + sel.x * bs, ry = y + sel.y * bs, rw = sel.w * bs, rh = sel.h * bs;
        ctx.fillStyle = free ? "rgba(255,194,61,0.22)" : "rgba(179,32,14,0.45)";
        ctx.fillRect(rx, ry, rw, rh);
        if (!free) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(rx, ry, rw, rh);
          ctx.clip();
          ctx.strokeStyle = "rgba(255,100,0,0.8)";
          ctx.lineWidth = 1.5;
          for (let k = -rh; k < rw; k += 8) {
            ctx.moveTo(rx + k, ry + rh);
            ctx.lineTo(rx + k + rh, ry);
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.strokeStyle = free ? "#ffc23d" : "#ff6400";
        ctx.lineWidth = 2;
        ctx.strokeRect(rx - 1, ry - 1, rw + 2, rh + 2);
        // corner ticks
        ctx.fillStyle = free ? "#ffc23d" : "#ff6400";
        for (const [cx, cy] of [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]]) ctx.fillRect(cx - 4, cy - 4, 8, 8);
      }
      if (P.cursor) {
        const c = P.cursor;
        ctx.strokeStyle = "#fff5dc";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + c.x * bs - 1, y + c.y * bs - 1, bs + 2, bs + 2);
        ctx.setLineDash([]);
      }
      P.onView(view.current, w, h);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [animateTo, bounds, clampView, fitScale]);

  useEffect(() => {
    dirty.current = true;
  }, [p.canvasVersion, p.mode, p.selection, p.cursor]);

  // ---------- gestures ----------
  useEffect(() => {
    const cv = cvRef.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let mode: "none" | "pan" | "select" | "pinch" = "none";
    let start = { x: 0, y: 0, vx: 0, vy: 0 };
    let selStart: { x: number; y: number } | null = null;
    let moved = 0;
    let hist: { x: number; y: number; t: number }[] = [];
    let pinch0 = { d: 1, s: 1, cx: 0, cy: 0, vx: 0, vy: 0 };
    let space = false;

    const toBlock = (sx: number, sy: number) => {
      const { s, x, y } = view.current;
      return { x: Math.floor((sx - x) / (BLOCK_PX * s)), y: Math.floor((sy - y) / (BLOCK_PX * s)) };
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const adAt = (b: { x: number; y: number }) => {
      if (b.x < 0 || b.y < 0 || b.x >= GRID || b.y >= GRID) return null;
      const i = ownerIdx.current[b.y * GRID + b.x];
      return i >= 0 ? props.current.ads[i] : null;
    };
    const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => {
      const cl = (n: number) => Math.max(0, Math.min(GRID - 1, n));
      const x0 = cl(Math.min(a.x, b.x)), x1 = cl(Math.max(a.x, b.x));
      const y0 = cl(Math.min(a.y, b.y)), y1 = cl(Math.max(a.y, b.y));
      return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };

    const down = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      const l = local(e);
      pts.set(e.pointerId, l);
      anim.current = null;
      moved = 0;
      hist = [{ ...l, t: performance.now() }];
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.current.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: view.current.x, vy: view.current.y };
        if (mode === "select") props.current.onSelect(null, false);
        mode = "pinch";
        return;
      }
      const wantsPan = props.current.mode === "explore" || e.button === 1 || space;
      if (wantsPan) {
        mode = "pan";
        start = { x: l.x, y: l.y, vx: view.current.x, vy: view.current.y };
        cv.style.cursor = "grabbing";
      } else if (e.button === 0) {
        mode = "select";
        selStart = toBlock(l.x, l.y);
        props.current.onSelect(rectFrom(selStart, selStart), false);
      }
    };

    const move = (e: PointerEvent) => {
      const l = local(e);
      if (pts.has(e.pointerId)) pts.set(e.pointerId, l);
      if (mode === "none") {
        const b = toBlock(l.x, l.y);
        const inside = b.x >= 0 && b.y >= 0 && b.x < GRID && b.y < GRID;
        props.current.onHover(adAt(b), e.clientX, e.clientY, inside ? b : null);
        cv.style.cursor = props.current.mode === "select" ? "crosshair" : adAt(b) ? "pointer" : "grab";
        return;
      }
      props.current.onHover(null, 0, 0, null);
      if (mode === "pinch" && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const s = Math.min(MAX_S, Math.max(fitScale() * 0.6, pinch0.s * (d / pinch0.d)));
        const k = s / pinch0.s;
        view.current = { s, x: cx - (pinch0.cx - pinch0.vx) * k, y: cy - (pinch0.cy - pinch0.vy) * k };
        dirty.current = true;
        return;
      }
      moved = Math.max(moved, Math.hypot(l.x - hist[0].x, l.y - hist[0].y));
      hist.push({ ...l, t: performance.now() });
      if (hist.length > 6) hist.shift();
      if (mode === "pan") {
        const v = view.current;
        const b = bounds(v.s);
        let nx = start.vx + (l.x - start.x);
        let ny = start.vy + (l.y - start.y);
        const { w, h } = size.current;
        if (nx > b.maxX) nx = b.maxX + rubber(nx - b.maxX, w);
        if (nx < b.minX) nx = b.minX + rubber(nx - b.minX, w);
        if (ny > b.maxY) ny = b.maxY + rubber(ny - b.maxY, h);
        if (ny < b.minY) ny = b.minY + rubber(ny - b.minY, h);
        view.current = { s: v.s, x: nx, y: ny };
        dirty.current = true;
      } else if (mode === "select" && selStart) {
        props.current.onSelect(rectFrom(selStart, toBlock(l.x, l.y)), false);
      }
    };

    const up = (e: PointerEvent) => {
      const l = local(e);
      pts.delete(e.pointerId);
      if (mode === "pinch") {
        if (pts.size === 0) {
          mode = "none";
          animateTo(clampView(view.current));
        }
        return;
      }
      if (mode === "pan") {
        cv.style.cursor = props.current.mode === "select" ? "crosshair" : "grab";
        if (moved < 5) {
          const ad = adAt(toBlock(l.x, l.y));
          if (ad) props.current.onActivate(ad);
        } else if (!props.current.reduceMotion && hist.length > 1) {
          const a = hist[0], b = hist[hist.length - 1];
          const dt = Math.max(1, b.t - a.t);
          anim.current = { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
        } else animateTo(clampView(view.current));
      } else if (mode === "select" && selStart) {
        props.current.onSelect(rectFrom(selStart, toBlock(l.x, l.y)), true);
        selStart = null;
      }
      mode = "none";
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const l = local(e);
      anim.current = null;
      const isTrackpadPan = !e.ctrlKey && Math.abs(e.deltaX) > 0.5 && e.deltaMode === 0;
      if (isTrackpadPan) {
        view.current = clampView({ ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY });
        dirty.current = true;
        return;
      }
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022) * (e.deltaMode === 1 ? 16 : 1));
      zoomAt(view.current.s * k, l.x, l.y);
    };
    const leave = () => props.current.onHover(null, 0, 0, null);
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" && document.activeElement === cv) {
        space = true;
        e.preventDefault();
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") space = false;
    };

    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", leave);
    cv.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("pointerleave", leave);
      cv.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [animateTo, bounds, clampView, fitScale, zoomAt]);

  return (
    <canvas
      ref={cvRef}
      className="absolute inset-0 h-full w-full touch-none select-none outline-none"
      tabIndex={0}
      role="application"
      aria-roledescription="billboard"
      aria-label="The billboard. Use arrow keys to move the block cursor, Shift plus arrows to grow a selection, plus and minus to zoom, Enter to buy the selection or open the ad under the cursor, S to switch between exploring and selecting."
      aria-describedby="canvas-status"
    />
  );
});
