"use client";
import { useEffect, useRef } from "react";
import { CANVAS_PX } from "@/lib/config";
import { getCanvas, useLive } from "@/lib/store";

/** Plain 2D copy of the live billboard. Used as the reduced-motion hero and in thumbnails. */
export function LiveCanvas({ className, label = "The live billboard" }: { className?: string; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = useLive((s) => s.canvasVersion);
  useEffect(() => {
    const c = ref.current;
    const src = getCanvas();
    if (!c || !src) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#0b0907";
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
    ctx.drawImage(src, 0, 0);
  }, [version]);
  return (
    <canvas
      ref={ref}
      width={CANVAS_PX}
      height={CANVAS_PX}
      role="img"
      aria-label={label}
      className={className}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
