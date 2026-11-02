"use client";
import { useEffect, useRef } from "react";
import { CANVAS_PX, GRID } from "@/lib/config";
import { bitGet } from "@/lib/quote";
import { getCanvas, useLive } from "@/lib/store";

/** The lot: every block still free, glowing on top of the dimmed billboard. */
export function LotMap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const occ = useLive((s) => s.occupancy);
  const version = useLive((s) => s.canvasVersion);
  useEffect(() => {
    const c = ref.current, src = getCanvas();
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !src) return;
    ctx.fillStyle = "#16110e";
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
    ctx.globalAlpha = 0.35;
    ctx.drawImage(src, 0, 0);
    ctx.globalAlpha = 1;
    for (let i = 0; i < GRID * GRID; i++) {
      if (bitGet(occ, i)) continue;
      const x = (i % GRID) * 10, y = Math.floor(i / GRID) * 10;
      ctx.fillStyle = (i * 7919) % 5 === 0 ? "#ffc23d" : "#ff5b14";
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x + 1, y + 1, 8, 8);
    }
    ctx.globalAlpha = 1;
  }, [occ, version]);
  return <canvas ref={ref} width={CANVAS_PX} height={CANVAS_PX} className="h-auto w-full ring-1 ring-char" style={{ imageRendering: "pixelated" }} role="img" aria-label="The billboard with every unsold block highlighted. These blocks become the auction lot." />;
}
