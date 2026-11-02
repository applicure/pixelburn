"use client";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { linkHost, shortAddr } from "@/lib/format";
import type { Ad } from "@/lib/types";
import { AdThumb } from "@/components/ui/AdThumb";
import { IconExternal } from "@/components/ui/icons";

/** Ads link to arbitrary sites; confirm before sending people off the billboard. */
export function LeaveConfirm({ ad, onClose }: { ad: Ad | null; onClose(): void }) {
  const reduce = useReducedMotion();
  const goRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!ad) return;
    const prev = document.activeElement as HTMLElement | null;
    goRef.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("keydown", k);
      prev?.focus?.();
    };
  }, [ad, onClose]);
  return (
    <AnimatePresence>
      {ad && (
        <motion.div className="fixed inset-0 z-[70] grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-soot/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-title"
            aria-describedby="leave-desc"
            className="relative w-full max-w-md bg-kiln p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,.9)] ring-1 ring-char"
            initial={reduce ? { opacity: 0 } : { scale: 0.94, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { scale: 0.96, opacity: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.35 }}
          >
            <div className="flex items-start gap-4">
              <div className="grid h-16 w-16 shrink-0 place-items-center bg-soot">
                <AdThumb rect={ad} size={56} />
              </div>
              <div className="min-w-0">
                <h2 id="leave-title" className="font-display text-[1.6rem] font-black leading-none [font-variation-settings:'wdth'_110]">
                  Leave for {linkHost(ad.link)}?
                </h2>
                <p id="leave-desc" className="mt-2 text-[0.92rem] text-ash">
                  <span className="text-heat">{ad.title}</span> links to a site we don&apos;t control. Owner{" "}
                  <span className="num text-[0.8rem]">{shortAddr(ad.owner)}</span>.
                </p>
              </div>
            </div>
            <p className="num mt-5 break-all border border-char bg-soot px-3 py-2 text-[0.78rem] text-heat/90">{ad.link}</p>
            <div className="mt-6 flex justify-end gap-3">
              <button className="btn-line" onClick={onClose}>
                Stay here
              </button>
              <a ref={goRef} className="btn-fire" href={ad.link} target="_blank" rel="noopener noreferrer nofollow" onClick={onClose}>
                Open site <IconExternal size={18} />
              </a>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
