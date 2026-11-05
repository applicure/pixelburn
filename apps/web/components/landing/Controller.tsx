"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BRAND } from "@/lib/config";
import { useLaunchState } from "@/lib/launchState";
import { vaultLamports } from "@/lib/phase";
import { useBuybacksLive } from "@/lib/usePhase";
import { fmtInt, fmtSol, tokensToWhole } from "@/lib/format";
import { useLive } from "@/lib/store";
import { Odometer } from "@/components/ui/Odometer";
import { FeedRow } from "@/components/ui/FeedRow";

export function Controller() {
  const live = useBuybacksLive();
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
    live
      ? { label: `${BRAND.ticker} burned, forever`, value: stats ? fmtInt(Math.round(tokensToWhole(stats.tokensBurned))) : "0", unit: "", tone: "text-cone" }
      : { label: "in the buyback vault", value: stats ? fmtSol(vaultLamports(stats), 1) : "0.0", unit: "SOL", tone: "text-cone" },
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
            {connection === "open" ? live ? "Streaming purchases and burns as they land" : "Streaming purchases as they land" : "Reconnecting to the live stream"}
          </p>
        </div>

        <div className="mt-12 grid gap-12 lg:grid-cols-12">
          {stats && stats.soldBlocks === 0 ? (
            <ColdKiln />
          ) : (
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
                  className="absolute inset-y-0 left-0 bg-[linear-gradient(90deg,#b3200e,#ff6400_60%,#ffc23d)]"
                  initial={false}
                  animate={{ width: `${pct}%` }}
                  transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0, duration: 1.2 }}
                />
                <div className="absolute inset-y-[-6px] left-[99%] w-px bg-heat" />
              </div>
              <p className="mt-3 flex justify-between text-[0.85rem] text-ash">
                <span>
                  {stats ? fmtInt(stats.soldBlocks) : 0} of 10,000 blocks sold
                </span>
                <span>auction at 99%</span>
              </p>
            </div>
          </div>
          )}

          <div className="lg:col-span-5">
            <h3 className="font-display text-[1.25rem] font-extrabold [font-variation-settings:'wdth'_110]">Firing log</h3>
            <div className="relative mt-3 h-[30rem] overflow-hidden border-t border-char" data-lenis-prevent>
              {feed.length === 0 && (
                <div className="py-6">
                  <p className="flex items-center gap-2 text-[0.95rem] text-heat/85">
                    <span className="inline-block h-2 w-2 animate-[flicker_2s_infinite] bg-flame" aria-hidden />
                    Waiting for the first purchase.
                  </p>
                  <p className="mt-1 text-[0.85rem] text-ash">It shows up here the moment it confirms on-chain{live ? ", and so does every burn after it" : ""}.</p>
                  <div className="mt-6 space-y-3" aria-hidden>
                    {[0.5, 0.32, 0.18].map((o) => (
                      <div key={o} className="flex items-center gap-3" style={{ opacity: o }}>
                        <span className="block h-9 w-9 border border-dashed border-ash/60" />
                        <span className="block h-2.5 flex-1 bg-char" />
                        <span className="block h-2.5 w-12 bg-char" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
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

/** Launch day: instead of four zeros, say what's true and what happens next. */
function ColdKiln() {
  const live = useBuybacksLive();
  const preLaunch = useLaunchState() !== "live";
  return (
    <div className="relative self-start overflow-hidden bg-soot ring-1 ring-char lg:col-span-7">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-[radial-gradient(60%_80%_at_30%_100%,rgba(179,32,14,.28),transparent_70%)]" />
      <div className="relative p-6 sm:p-10">
        <p className="font-display text-[clamp(2rem,4.4vw,3.6rem)] font-black leading-[0.95] [font-variation-settings:'wdth'_70]">The kiln is cold.</p>
        <p className="mt-4 max-w-[46ch] text-heat/85">
          {live ? (
            <>
              Nothing has been bought or burned yet. These counters start moving with the first block: dollars and SOL raised,
              share of the wall sold, and {BRAND.ticker} burned for good.
            </>
          ) : (
            "Nothing has been bought yet. These counters start moving with the first block: dollars and SOL raised, share of the wall sold, and SOL in the buyback vault."
          )}
        </p>
        <dl className="mt-8 grid gap-px bg-char sm:grid-cols-3">
          {[
            ["The first block", "$100 for 10×10 px, anywhere on the wall"],
            ["Half of the SOL", "goes straight to the buyback vault"],
            live ? [`Paid in ${BRAND.ticker}`, "burned in the same transaction"] : [`Buybacks and ${BRAND.ticker} payments`, "coming soon"],
          ].map(([t, d]) => (
            <div key={t} className="bg-soot py-4 pr-4">
              <dt className="font-display text-[1.15rem] font-extrabold [font-variation-settings:'wdth'_110]">{t}</dt>
              <dd className="mt-1 text-[0.88rem] text-ash">{d}</dd>
            </div>
          ))}
        </dl>
        <Link href={preLaunch ? "/canvas" : "/canvas?select=1&w=1&h=1"} className="btn-fire mt-8">
          {preLaunch ? "See the canvas" : "Light it: claim the first block"}
        </Link>
      </div>
    </div>
  );
}
