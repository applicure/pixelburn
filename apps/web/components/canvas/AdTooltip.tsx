"use client";
import { AnimatePresence, motion } from "motion/react";
import { fmtUsd, linkHost, shortAddr } from "@/lib/format";
import { BRAND } from "@/lib/config";
import type { Ad } from "@/lib/types";

export function AdTooltip({ ad, x, y }: { ad: Ad | null; x: number; y: number }) {
  const flipX = typeof window !== "undefined" && x > window.innerWidth - 300;
  const flipY = typeof window !== "undefined" && y > window.innerHeight - 160;
  return (
    <AnimatePresence>
      {ad && (
        <motion.div
          key={ad.id}
          className="pointer-events-none fixed z-40 w-[17rem] bg-soot/95 p-3 text-[0.85rem] shadow-[0_16px_40px_-12px_rgba(0,0,0,.9)] ring-1 ring-char"
          style={{ left: flipX ? x - 16 - 272 : x + 16, top: flipY ? y - 16 - 120 : y + 16 }}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <p className="font-semibold text-heat">{ad.title}</p>
          <p className="mt-0.5 text-cobalt-hi">{linkHost(ad.link)}</p>
          <dl className="num mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.72rem] text-ash">
            <dt>owner</dt>
            <dd className="text-heat/85">{shortAddr(ad.owner)}</dd>
            <dt>size</dt>
            <dd className="text-heat/85">
              {ad.w}×{ad.h} blocks at {ad.x},{ad.y}
            </dd>
            <dt>paid</dt>
            <dd className="text-heat/85">
              {fmtUsd(ad.usd)} in {ad.payMode === "token" ? `${BRAND.ticker}, burned` : "SOL"}
            </dd>
          </dl>
          <p className="mt-2 text-[0.75rem] text-ash">Click to visit</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
