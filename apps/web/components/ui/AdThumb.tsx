"use client";
import { useEffect, useRef } from "react";
import { BLOCK_PX } from "@/lib/config";
import { getCanvas, useLive } from "@/lib/store";
import type { Rect } from "@/lib/types";

/** Crops one ad out of the live billboard. */
export function AdThumb({ rect, size = 36, className = "" }: { rect: Rect; size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = useLive((s) => s.canvasVersion);
  const aspect = rect.w / rect.h;
  const W = aspect >= 1 ? size : Math.max(4, Math.round(size * aspect));
  const H = aspect >= 1 ? Math.max(4, Math.round(size / aspect)) : size;
  useEffect(() => {
    const c = ref.current;
    const src = getCanvas();
    const ctx = c?.getContext("2d");
    if (!c || !src || !ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(src, rect.x * BLOCK_PX, rect.y * BLOCK_PX, rect.w * BLOCK_PX, rect.h * BLOCK_PX, 0, 0, c.width, c.height);
  }, [version, rect.x, rect.y, rect.w, rect.h]);
  return <canvas ref={ref} width={W * 2} height={H * 2} style={{ width: W, height: H, imageRendering: "pixelated" }} className={className} aria-hidden />;
}
