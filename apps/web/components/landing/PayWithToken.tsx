"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useInView } from "motion/react";
import { useQuote } from "@/lib/useQuote";
import { normTokenStatus, SLOW_EMA_HINT, tokenStatusCopy } from "@/lib/tokenStatus";
import { BRAND } from "@/lib/config";
import { useBuybacksLive } from "@/lib/usePhase";
import { quoteLamports, quoteTokens, quoteUsd } from "@/lib/quote";
import { useLive } from "@/lib/store";
import { fmtInt, fmtSol, fmtTokens, fmtUsd, fmt2 } from "@/lib/format";
import { IconMinus, IconPlus } from "@/components/ui/icons";
import { Odometer } from "@/components/ui/Odometer";

const PRESETS: [number, number, string][] = [
  [1, 1, "One block"],
  [3, 2, "Small banner"],
  [10, 4, "Leaderboard"],
  [10, 10, "Big square"],
];

function Stepper({ label, value, set }: { label: string; value: number; set: (n: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-[0.85rem]">{label}</span>
      <button
        className="grid h-10 w-10 place-items-center border border-soot/40 hover:bg-soot hover:text-flame active:scale-95"
        onClick={() => set(Math.max(1, value - 1))}
        aria-label={`Fewer blocks in ${label.toLowerCase()}`}
      >
        <IconMinus size={18} />
      </button>
      <output className="num w-10 text-center text-lg" aria-live="polite">
        {value}
      </output>
      <button
        className="grid h-10 w-10 place-items-center border border-soot/40 hover:bg-soot hover:text-flame active:scale-95"
        onClick={() => set(Math.min(100, value + 1))}
        aria-label={`More blocks in ${label.toLowerCase()}`}
      >
        <IconPlus size={18} />
      </button>
    </div>
  );
}

export function PayWithToken() {
  const live = useBuybacksLive();
  const [w, setW] = useState(3);
  const [h, setH] = useState(2);
  // live estimate from the prices in the stats stream; the binding quote is taken at checkout
  const solUsd = useLive((s) => s.stats?.solPriceUsd ?? 0);
  const tokUsd = useLive((s) => s.stats?.tokenPriceUsd ?? 0);
  const usd = w * h * 100;
  const micro = quoteUsd(w, h);
  const lamports = solUsd > 0 ? quoteLamports(micro, solUsd).toString() : null;
  const tokens = tokUsd > 0 ? quoteTokens(micro, tokUsd).toString() : null;
  // one SOL quote per size (no auto-refresh) tells us whether $PXL can pay for this size right now
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { margin: "200px" });
  const gate = useQuote(w, h, "sol", live && inView, false);
  const status = normTokenStatus(gate.quote?.tokenPaymentStatus);
  const note = !live ? null : tokenStatusCopy(status, w * h, gate.quote?.tokenBlocksAvailable ?? null);
  const slowEma = status === "ok" && gate.quote?.tokenPricedBy === "slow_ema";

  return (
    <section className="grain relative isolate overflow-hidden bg-flame text-soot" aria-labelledby="token-title">
      <div className="relative z-10 mx-auto grid max-w-[1400px] gap-12 px-4 py-24 sm:px-6 sm:py-32 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <h2 id="token-title" className="font-black text-[clamp(2.6rem,7vw,6rem)] [font-variation-settings:'wdth'_130]">
            {live ? <>Pay in {BRAND.ticker}. Save 10%. Burn all of it.</> : <>Pay with {BRAND.ticker}: coming soon.</>}
          </h2>
          {live ? (
            <>
          <p className="mt-6 max-w-[42ch] text-[1.08rem] leading-relaxed">
            Choose {BRAND.ticker} at checkout and the price drops by 10%. Every token you pay is burned in the same
            transaction: none of it goes to the treasury.
          </p>
          <p className="mt-4 max-w-[42ch] text-[0.95rem] leading-relaxed text-soot/80">
            The conversion uses the lowest of the live pool price and two on-chain averages (a fast one and a 4-hour
            one), so pumping the price never lowers the number of tokens you owe. Token payments pause briefly after a
            sharp spike and are capped at 1,000 blocks an hour; SOL always works.
          </p>
            </>
          ) : (
            <>
              <p className="mt-6 max-w-[42ch] text-[1.08rem] leading-relaxed">
                {BRAND.ticker} is launching on pump.fun. Paying for pixels with it comes together with buybacks, in a later program upgrade that will be announced as a new feature.
              </p>
              <p className="mt-4 max-w-[42ch] text-[0.95rem] leading-relaxed text-soot/80">For now every block is paid in SOL.</p>
            </>
          )}
        </div>

        <div className="lg:col-span-7">
          <div ref={box} className="bg-soot p-5 text-heat sm:p-8">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Ad size presets">
              {PRESETS.map(([pw, ph, name]) => {
                const on = pw === w && ph === h;
                return (
                  <button
                    key={name}
                    onClick={() => {
                      setW(pw);
                      setH(ph);
                    }}
                    aria-pressed={on}
                    className={`border px-3 py-2 text-[0.88rem] transition-colors ${on ? "border-flame bg-flame text-soot" : "border-char text-ash hover:border-heat hover:text-heat"}`}
                  >
                    {name} <span className="num ml-1 text-[0.75rem] opacity-80">{pw}×{ph}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 text-heat [&_button]:border-char [&_button:hover]:bg-char">
              <Stepper label="Wide" value={w} set={setW} />
              <Stepper label="High" value={h} set={setH} />
              <p className="text-[0.9rem] text-ash">
                <span className="num text-heat">{fmtInt(w * h * 100)}</span> pixels, <span className="num text-heat">{fmtUsd(usd)}</span>
              </p>
            </div>

            <div className="mt-8 grid gap-px bg-char sm:grid-cols-2">
              <div className="bg-soot pb-2 pr-4 pt-4">
                <p className="text-[0.9rem] text-cobalt-hi">Pay in SOL</p>
                <p className="mt-2 text-[2.1rem] leading-none sm:text-[2.6rem]">
                  <Odometer value={lamports ? fmtSol(lamports, 3) : "0.000"} />
                  <span className="ml-2 text-base text-ash">SOL</span>
                </p>
                <p className="num mt-2 text-[0.8rem] text-ash">
                  {fmtUsd(usd)} at ${fmt2(solUsd)}/SOL
                </p>
              </div>
              <div className="relative bg-soot pb-2 pt-4 sm:pl-6">
                {live ? (
                  <>
                    <p className="text-[0.9rem] text-flame">Pay in {BRAND.ticker}, 10% off</p>
                    <p className={`mt-2 text-[2.1rem] leading-none sm:text-[2.6rem] ${note ? "text-ash/60 line-through decoration-2" : "text-cone"}`}>
                      <Odometer value={tokens ? fmtTokens(tokens) : "0"} />
                    </p>
                    <p className="num mt-2 text-[0.8rem] text-ash">
                      {fmtUsd(usd * 0.9)} at ${tokUsd.toFixed(5)}, you save {fmtUsd(usd * 0.1)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[0.9rem] text-ash">Pay with {BRAND.ticker}</p>
                    <p className="mt-2 text-[2.1rem] leading-none text-ash sm:text-[2.6rem]">Coming soon</p>
                  </>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
              {(note || slowEma) && (
                <p className="flex w-full gap-2.5 bg-char/60 px-3 py-2.5 text-[0.85rem] leading-snug" role="status">
                  <span className="mt-1.5 block h-2 w-2 shrink-0 bg-cone" aria-hidden />
                  <span>
                    {note ? (
                      <>
                        <span className="font-semibold text-heat">{note.title}.</span> <span className="text-heat/75">{note.body}</span>
                      </>
                    ) : (
                      <span className="text-heat/75">{SLOW_EMA_HINT}</span>
                    )}
                  </span>
                </p>
              )}
              <p className="flex items-center gap-2 text-[0.82rem] text-ash">
                <span className="inline-block h-2 w-2 animate-[flicker_2s_infinite] bg-cone" aria-hidden />
                Live estimate. Your exact quote locks for 30 seconds at checkout.
              </p>
              <Link href={`/canvas?select=1&w=${w}&h=${h}`} className="btn-fire">
                Find {w}×{h} free blocks
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
