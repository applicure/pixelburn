"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { KineticHeading } from "@/components/ui/KineticHeading";
import { LiveCanvas } from "@/components/ui/LiveCanvas";
import { BRAND, TOTAL_BLOCKS } from "@/lib/config";
import { fmtCompact, fmtInt, tokensToWhole } from "@/lib/format";
import { useLive } from "@/lib/store";

const KilnScene = dynamic(() => import("./KilnScene"), { ssr: false });

function supportsWebGL2() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export function Hero() {
  const reduce = useReducedMotion();
  const [gl, setGl] = useState<boolean | null>(null);
  const [sceneOn, setSceneOn] = useState(false);
  const stats = useLive((s) => s.stats);
  // small screens: the 2D poster paints first; WebGL hydrates after idle, already assembled
  const [poster, setPoster] = useState(true);
  useEffect(() => {
    const can = !reduce && supportsWebGL2();
    const small = window.matchMedia("(max-width: 1023px)").matches;
    if (!can || !small) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPoster(!can);
      setGl(can);
      return;
    }
    const ric = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200));
    const id = ric(() => setGl(true), { timeout: 2500 } as IdleRequestOptions);
    return () => (window.cancelIdleCallback ?? window.clearTimeout)(id as number);
  }, [reduce]);
  const [small, setSmall] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSmall(window.matchMedia("(max-width: 1023px)").matches);
  }, []);

  return (
    <section className="relative isolate min-h-[100svh] overflow-hidden pt-14" aria-labelledby="hero-title">
      {/* kiln floor glow: the heat source under the shelf */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60% 40% at 62% 100%, rgba(255,91,20,.38), rgba(179,32,14,.16) 45%, transparent 75%)",
        }}
      />
      <div className="mx-auto grid max-w-[1600px] grid-cols-1 items-center gap-y-6 px-4 sm:px-6 lg:min-h-[calc(100svh-3.5rem)] lg:grid-cols-12 lg:gap-x-8">
        {/* the billboard */}
        <div className="relative order-2 mx-auto aspect-square w-full max-w-[min(100%,86svh)] lg:col-span-7 lg:max-w-none">
          <div className="tile-grid absolute inset-[3%] opacity-60" aria-hidden />
          {poster && (
            <div className="absolute inset-[3%] transition-opacity duration-700" style={{ opacity: sceneOn ? 0 : 1 }}>
              <LiveCanvas className="h-full w-full shadow-[0_30px_120px_-20px_rgba(255,91,20,.45)]" />
            </div>
          )}
          {gl && <KilnScene assembled={small} onReady={() => setSceneOn(true)} />}
          <p className="sr-only">
            The live billboard: {stats ? fmtInt(stats.soldBlocks) : "…"} of {fmtInt(TOTAL_BLOCKS)} blocks are sold and showing ads.
          </p>
          <Link
            href="/canvas"
            className="absolute bottom-[1%] right-[3%] flex items-center gap-2 bg-soot/70 px-2.5 py-1.5 text-[0.78rem] text-ash backdrop-blur hover:text-heat"
            style={{ opacity: sceneOn || poster ? 1 : 0, transition: "opacity .6s" }}
          >
            <span className="inline-block h-2 w-2 animate-[flicker_2.4s_infinite] bg-flame" aria-hidden />
            Live, 1000 × 1000 px. Open the canvas
          </Link>
        </div>

        {/* words */}
        <div className="relative order-1 pt-6 lg:col-span-5 lg:pt-0">
          <KineticHeading
            lines={["A million", "pixels.", "Half of every", "dollar burns."]}
            className="font-black text-[clamp(2.4rem,11.6vw,6.6rem)] leading-[1.04] lg:text-[clamp(3.4rem,5.3vw,6.4rem)]"
            rest={96}
            delay={0.25}
          />
          <div className="rise" style={{ ["--d" as string]: "0.55s" }}>
            <p className="mt-5 max-w-[34ch] text-[1.02rem] leading-[1.5] text-heat/85 sm:mt-7 sm:text-[1.13rem] sm:leading-[1.55]">
              The 2005 Million Dollar Homepage, rebuilt on Solana. $1 a pixel. Pay in SOL and half of it buys back and
              burns {BRAND.ticker}. Pay in {BRAND.ticker} instead and every token you pay is burned.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3 sm:mt-8">
              <Link href="/canvas?select=1" className="btn-fire text-lg">
                Buy pixels
              </Link>
              <Link href="/canvas" className="btn-line">
                Explore the canvas
              </Link>
            </div>
            <dl className="mt-6 grid max-w-md grid-cols-2 gap-x-6 border-t border-char pt-3 text-[0.82rem] sm:mt-10 sm:pt-4">
              <div>
                <dt className="text-ash">Blocks sold</dt>
                <dd className="mt-1 text-[1.1rem] font-semibold tabular-nums text-heat">
                  {stats ? fmtInt(stats.soldBlocks) : "—"}
                  <span className="text-ash"> / 10,000</span>
                </dd>
              </div>
              <div>
                <dt className="text-ash">{BRAND.ticker} burned</dt>
                <dd className="mt-1 text-[1.1rem] font-semibold tabular-nums text-cone">{stats ? fmtCompact(tokensToWhole(stats.tokensBurned)) : "—"}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
