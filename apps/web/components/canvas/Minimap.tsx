"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { CANVAS_PX } from "@/lib/config";
import { getCanvas, useLive } from "@/lib/store";
import type { View } from "./Viewport";

export interface MinimapHandle {
  draw(v: View, w: number, h: number): void;
}

/** Overview of the whole billboard with the visible window; click or drag to jump. */
export const Minimap = forwardRef<MinimapHandle, { onJump(bx: number, by: number): void; size: number }>(function Minimap({ onJump, size }, ref) {
  const cv = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ v: View; w: number; h: number } | null>(null);
  const version = useLive((s) => s.canvasVersion);

  const paint = () => {
    const c = cv.current;
    const l = last.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const k = c.width / CANVAS_PX;
    ctx.fillStyle = "#16110e";
    ctx.fillRect(0, 0, c.width, c.height);
    const src = getCanvas();
    if (src) ctx.drawImage(src, 0, 0, c.width, c.height);
    if (!l) return;
    const { v, w, h } = l;
    const x = (-v.x / v.s) * k, y = (-v.y / v.s) * k, rw = (w / v.s) * k, rh = (h / v.s) * k;
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.beginPath();
    ctx.rect(0, 0, c.width, c.height);
    ctx.rect(x, y, rw, rh);
    ctx.fill("evenodd");
    ctx.strokeStyle = "#ffc23d";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, rw, rh);
  };

  useImperativeHandle(ref, () => ({
    draw(v, w, h) {
      const prev = last.current;
      if (prev && prev.v.s === v.s && prev.v.x === v.x && prev.v.y === v.y && prev.w === w && prev.h === h) return;
      last.current = { v: { ...v }, w, h };
      paint();
    },
  }));
  useEffect(paint, [version]);

  useEffect(() => {
    const c = cv.current!;
    let dragging = false;
    const jump = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      const bx = ((e.clientX - r.left) / r.width) * 100;
      const by = ((e.clientY - r.top) / r.height) * 100;
      onJump(Math.max(0, Math.min(99, bx)), Math.max(0, Math.min(99, by)));
    };
    const d = (e: PointerEvent) => {
      dragging = true;
      c.setPointerCapture(e.pointerId);
      jump(e);
    };
    const m = (e: PointerEvent) => dragging && jump(e);
    const u = () => (dragging = false);
    c.addEventListener("pointerdown", d);
    c.addEventListener("pointermove", m);
    c.addEventListener("pointerup", u);
    return () => {
      c.removeEventListener("pointerdown", d);
      c.removeEventListener("pointermove", m);
      c.removeEventListener("pointerup", u);
    };
  }, [onJump]);

  return (
    <canvas
      ref={cv}
      width={size * 2}
      height={size * 2}
      style={{ width: size, height: size, imageRendering: "pixelated" }}
      className="block cursor-pointer touch-none"
      aria-label="Minimap. Click to move the view."
      role="img"
    />
  );
});
