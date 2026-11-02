"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BRAND } from "@/lib/config";
import { fmtCompact, fmtInt, fmtSol, tokensToWhole } from "@/lib/format";
import { useLive } from "@/lib/store";
import { Odometer } from "@/components/ui/Odometer";
import { FeedRow } from "@/components/ui/FeedRow";

export function Controller() {
  const stats = useLive((s) => s.stats);
  const feed = useLive((s) => s.feed);
  const connection = useLive((s) => s.connection);
  const reduce = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const pct = stats ? (stats.soldBlocks / stats.totalBlocks) * 100 : 0;
  const readouts = [
    { label: "of the billboard sold", value: pct.toFixed(2), unit: "%", tone: "text-heat" },
    { label: "raised in dollars", value: stats ? fmtInt(stats.usdRaised) : "0", unit: "$", pre: true, tone: "text-heat" },
    { label: "raised in SOL", value: stats ? fmtSol(stats.lamportsRaised, 1) : "0.0", unit: "SOL", tone: "text-heat" },
    { label: `${BRAND.ticker} burned, forever`, value: stats ? fmtInt(Math.round(tokensToWhole(stats.tokensBurned))) : "0", unit: "", tone: "text-cone" },
  ];

  return (
    <section className="relative py-24 sm:py-32" aria-labelledby="live-title">
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="live-title" className="font-black text-[clamp(2.4rem,6vw,5rem)] [font-variation-settings:'wdth'_96]">
            Live from the kiln.
          </h2>
          <p className="flex items-center gap-2 text-[0.85rem] text-ash">
            <span className={`inline-block h-2 w-2 ${connection === "open" ? "animate-[flicker_2s_infinite] bg-flame" : "bg-ash"}`} aria-hidden />
            {connection === "open" ? "Streaming purchases and burns as they land" : "Reconnecting to the live stream"}
          </p>
        </div>

        <div className="mt-12 grid gap-12 lg:grid-cols-12">
          <div className="grid grid-cols-1 gap-px self-start bg-char sm:grid-cols-2 lg:col-span-7">
            {readouts.map((r) => (
              <dl key={r.label} className="flex flex-col-reverse bg-soot py-6 pr-6">
                <dt className="mt-3 text-[0.92rem] text-ash">{r.label}</dt>
                <dd className={`text-[clamp(2.1rem,3.9vw,3.4rem)] font-medium leading-none tracking-tight ${r.tone}`}>
                  {r.pre && <span className="num text-[0.55em] text-ash">{r.unit}</span>}
                  <Odometer value={r.value} />
                  {!r.pre && r.unit && <span className="num ml-1 text-[0.45em] text-ash">{r.unit}</span>}
                </dd>
              </dl>
            ))}
            <div className="bg-soot py-6 pr-6 sm:col-span-2">
              <div className="relative h-3 w-full bg-char" aria-hidden>
                <motion.div
                  className="absolute inset-y-0 left-0 bg-[linear-gradient(90deg,#b3200e,#ff5b14_60%,#ffc23d)]"
                  initial={false}
                  animate={{ width: `${pct}%` }}
                  transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0, duration: 1.2 }}
                />
                <div className="absolute inset-y-[-6px] left-[99%] w-px bg-heat" />
              </div>
              <p className="mt-3 flex justify-between text-[0.85rem] text-ash">
                <span>
                  {stats ? fmtInt(stats.soldBlocks) : 0} of 10,000 blocks, {stats ? fmtCompact(tokensToWhole(stats.tokenSupply)) : "…"} {BRAND.ticker} left in supply
                </span>
                <span>auction at 99%</span>
              </p>
            </div>
          </div>

          <div className="lg:col-span-5">
            <h3 className="font-display text-[1.25rem] font-extrabold [font-variation-settings:'wdth'_110]">Firing log</h3>
            <div className="relative mt-3 h-[30rem] overflow-hidden border-t border-char" data-lenis-prevent>
              <ul className="divide-y divide-char" aria-live="polite" aria-relevant="additions">
                <AnimatePresence initial={false}>
                  {feed.slice(0, 9).map((f) => (
                    <motion.li
                      key={f.sig}
                      layout={!reduce}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -18, filter: "blur(6px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={{ opacity: 0 }}
                      transition={{ type: "spring", bounce: 0, duration: 0.55 }}
                    >
                      <FeedRow item={f} now={now} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-soot" aria-hidden />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
