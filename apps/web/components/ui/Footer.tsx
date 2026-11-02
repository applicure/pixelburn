"use client";
import Link from "next/link";
import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { BRAND, HISTORY_2005, USE_MOCK } from "@/lib/config";
import { Mark } from "./icons";

export function Footer() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end end"] });
  // the sign-off heats up (widens) as it comes into view
  const wdth = useTransform(scrollYProgress, [0, 1], [52, 122]);
  const fvs = useTransform(wdth, (w) => `"wdth" ${reduce ? 120 : w.toFixed(1)}`);
  return (
    <footer ref={ref} className="relative overflow-hidden border-t border-char pt-20">
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Mark size={26} />
            <p className="mt-4 max-w-[30ch] text-[0.92rem] text-ash">
              {BRAND.name}. A tribute to the 2005 Million Dollar Homepage by {HISTORY_2005.founder}, not affiliated with it.
            </p>
          </div>
          <nav aria-label="Footer" className="grid content-start gap-2 text-[0.95rem]">
            <Link className="hover:text-flame" href="/canvas">Canvas</Link>
            <Link className="hover:text-flame" href="/canvas?select=1">Buy pixels</Link>
            <Link className="hover:text-flame" href="/burns">Burns and treasury</Link>
            <Link className="hover:text-flame" href="/auction">Final auction</Link>
          </nav>
          <div className="text-[0.85rem] text-ash sm:col-span-2">
            <p>
              {BRAND.ticker} is a placeholder ticker. Nothing on this site is financial advice. Purchases are permanent
              on-chain; this site only displays moderated ads.
            </p>
            {USE_MOCK && (
              <p className="mt-3 border border-char p-3 text-heat/80">
                Demo data: no API is connected, so every ad, owner, price and burn on this page is generated locally.
              </p>
            )}
          </div>
        </div>
      </div>
      <motion.p
        aria-hidden
        className="mt-16 pb-6 select-none whitespace-nowrap text-center font-display font-black leading-[0.8] text-flame"
        style={{ fontVariationSettings: fvs, fontSize: "clamp(2.2rem, 8.6vw, 12rem)", letterSpacing: "-0.04em" }}
      >
        Feed the fire
      </motion.p>
    </footer>
  );
}
