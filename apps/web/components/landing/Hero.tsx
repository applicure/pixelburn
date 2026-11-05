"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import { KineticHeading } from "@/components/ui/KineticHeading";
import { LiveCanvas } from "@/components/ui/LiveCanvas";
import { BRAND, TOTAL_BLOCKS } from "@/lib/config";
import { fmtCompact, fmtInt, fmtSol, tokensToWhole } from "@/lib/format";
import { useLaunchState } from "@/lib/launchState";
import { PHASE_LINE, vaultLamports } from "@/lib/phase";
import { useBuybacksLive } from "@/lib/usePhase";
import { useLive } from "@/lib/store";

const EARLY_BLOCKS = 200;

/** Free block (with a free 1-block margin) closest to the centre of the wall, where the claim tag lines up best with the tilted plane. */
function nearestFree(occ: Uint8Array) {
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (let r = 0; r < 50 && !best; r++)
    for (let y = 49 - r; y <= 50 + r; y++)
      for (let x = 49 - r; x <= 50 + r; x++) {
        if (x < 0 || y < 0 || x > 99 || y > 99) continue;
        // the ring is ~2 blocks wide: keep a 1-block margin so it never covers a neighbouring ad
        let clear = true;
        for (let dy = -1; dy <= 1 && clear; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx > 99 || yy > 99) continue;
            const j = yy * 100 + xx;
            if ((occ[j >> 3] >> (j & 7)) & 1) {
              clear = false;
              break;
            }
          }
        if (!clear) continue;
        const d = Math.hypot(x - 49.5, y - 49.5);
        if (d < bd) {
          bd = d;
          best = { x, y };
        }
      }
  return best;
}

const KilnScene = dynamic(() => import("./KilnScene"), { ssr: false });

function supportsWebGL2() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export function Hero() {
  const live = useBuybacksLive();
  const reduce = useReducedMotion();
  const [gl, setGl] = useState<boolean | null>(null);
  const [sceneOn, setSceneOn] = useState(false);
  const stats = useLive((s) => s.stats);
  // launch day (nothing sold) and the early days (< 2% sold): keep one claimable block glowing near the centre
  const occupancy = useLive((s) => s.occupancy);
  const sold = stats?.soldBlocks ?? null;
  const launch = sold === 0;
  const early = sold !== null && sold < EARLY_BLOCKS;
  // before the on-chain Config exists nothing can be bought, so nothing here offers a purchase
  const preLaunch = useLaunchState() !== "live";
  const claim = useMemo(() => (early && !preLaunch ? nearestFree(occupancy) : null), [early, preLaunch, occupancy]);
  const vault = stats ? `${fmtSol(vaultLamports(stats), 2)} SOL` : "—";
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
            "radial-gradient(60% 40% at 62% 100%, rgba(255,100,0,.38), rgba(179,32,14,.16) 45%, transparent 75%)",
        }}
      />
      <div className="mx-auto grid max-w-[1600px] grid-cols-1 items-center gap-y-6 px-4 sm:px-6 lg:min-h-[calc(100svh-3.5rem)] lg:grid-cols-12 lg:gap-x-8">
        {/* the billboard */}
        <div className="relative order-2 mx-auto aspect-square w-full max-w-[min(100%,86svh)] lg:col-span-7 lg:max-w-none">
          <div className="tile-grid absolute inset-[3%] opacity-60" aria-hidden />
          {poster && (
            <div className="absolute inset-[3%] transition-opacity duration-700" style={{ opacity: sceneOn ? 0 : 1 }}>
              <LiveCanvas className="h-full w-full shadow-[0_30px_120px_-20px_rgba(255,100,0,.45)]" />
            </div>
          )}
          {gl && <KilnScene assembled={small} claim={claim} onReady={() => setSceneOn(true)} />}
          <ClaimTag claim={claim} sold={sold ?? 0} />
          <p className="sr-only">
            The live billboard: {stats ? fmtInt(stats.soldBlocks) : "…"} of {fmtInt(TOTAL_BLOCKS)} blocks are sold and showing ads.
          </p>
          <Link
            href="/canvas"
            className="absolute bottom-[1%] right-[3%] flex items-center gap-2 bg-soot/70 px-2.5 py-1.5 text-[0.78rem] text-ash backdrop-blur hover:text-heat"
            style={{ opacity: sceneOn || poster ? 1 : 0, transition: "opacity .6s" }}
          >
            <span className="inline-block h-2 w-2 animate-[flicker_2.4s_infinite] bg-flame" aria-hidden />
            {preLaunch ? "" : "Live, "}1000 × 1000 px. Open the canvas
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
            {!live && <p className="mt-4 max-w-[40ch] text-[1.02rem] font-semibold leading-[1.4] text-cone sm:mt-5 sm:text-[1.13rem]">{PHASE_LINE}</p>}
            <p className={`max-w-[38ch] text-[1.02rem] leading-[1.5] text-heat/85 sm:text-[1.13rem] sm:leading-[1.55] ${live ? "mt-5 sm:mt-7" : "mt-3 sm:mt-4"}`}>
              {live ? (
                <>
                  The 2005 Million Dollar Homepage, rebuilt on Solana. $1 a pixel. Pay in SOL and half of it buys back and
                  burns {BRAND.ticker}. Pay in {BRAND.ticker} instead and every token you pay is burned.
                </>
              ) : (
                <>The 2005 Million Dollar Homepage, rebuilt on Solana. $1 a pixel, paid in SOL. The other half goes to the treasury.</>
              )}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3 sm:mt-8">
              {preLaunch ? (
                <Link href="/canvas" className="btn-fire text-lg">
                  See the canvas
                </Link>
              ) : (
                <>
                  <Link href={launch ? `/canvas?select=1&w=1&h=1` : "/canvas?select=1"} className="btn-fire text-lg">
                    {launch ? "Claim the first block" : "Buy pixels"}
                  </Link>
                  <Link href="/canvas" className="btn-line">
                    Explore the canvas
                  </Link>
                </>
              )}
            </div>
            <dl className="mt-6 grid max-w-md grid-cols-2 gap-x-6 border-t border-char pt-3 text-[0.82rem] sm:mt-10 sm:pt-4">
              {launch ? (
                <>
                  <div>
                    <dt className="text-ash">{preLaunch ? "Blocks at launch" : "Open blocks"}</dt>
                    <dd className="mt-1 text-[1.1rem] font-semibold text-heat">All 10,000</dd>
                  </div>
                  <div>
                    <dt className="text-ash">{live ? "Burned so far" : "In the buyback vault"}</dt>
                    <dd className="mt-1 text-[1.1rem] font-semibold tabular-nums text-cone">{live ? "Starts with the first buy" : vault}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt className="text-ash">Blocks sold</dt>
                    <dd className="mt-1 text-[1.1rem] font-semibold tabular-nums text-heat">
                      {stats ? fmtInt(stats.soldBlocks) : "—"}
                      <span className="text-ash"> / 10,000</span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ash">{live ? `${BRAND.ticker} burned` : "In the buyback vault"}</dt>
                    <dd className="mt-1 text-[1.1rem] font-semibold tabular-nums text-cone">{!live ? vault : stats ? fmtCompact(tokensToWhole(stats.tokensBurned)) : "—"}</dd>
                  </div>
                </>
              )}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Launch-day / early tag: a pulsing ring on the claimable block plus a price tag. The block sits near the centre,
 * where the tilted WebGL plane barely moves, so the ring lines up with the in-scene glow (and with the 2D poster).
 */
function ClaimTag({ claim, sold }: { claim: { x: number; y: number } | null; sold: number }) {
  const show = !!claim;
  // plane spans 1/1.06 of the square mount, centred
  const pos = (b: number) => 50 + (b + 0.5 - 50) * (100 / 106);
  const lx = claim ? pos(claim.x) : 50;
  const ly = claim ? pos(claim.y) : 50;
  return (
    <div className="pointer-events-none absolute inset-0 transition-opacity duration-700" style={{ opacity: show ? 1 : 0 }} aria-hidden={!show}>
      <span className="claim-ring absolute block h-[2.6%] w-[2.6%] -translate-x-1/2 -translate-y-1/2 border-2 border-cone" style={{ left: `${lx}%`, top: `${ly}%` }} />
      <span className="absolute block h-px w-[9%] origin-left -rotate-[32deg] bg-cone/70" style={{ left: `${lx + 1}%`, top: `${ly - 0.6}%` }} />
      <Link
        href="/canvas?select=1&w=1&h=1"
        tabIndex={show ? 0 : -1}
        className="pointer-events-auto absolute block bg-soot/90 px-3 py-2.5 ring-1 ring-cone/60 backdrop-blur hover:ring-cone sm:px-4 sm:py-3"
        style={{ left: `${Math.min(lx + 8, 62)}%`, top: `${ly - 12}%` }}
      >
        <span className="block font-display text-[clamp(0.95rem,1.6vw,1.25rem)] font-extrabold leading-none [font-variation-settings:'wdth'_115]">
          {sold === 0 ? "Be the first." : `${fmtInt(sold)} claimed. Yours next.`}
        </span>
        <span className="mt-1 block text-[clamp(0.72rem,1vw,0.85rem)] text-heat/80">
          One block, <span className="num text-cone">10×10 px</span>, $100
        </span>
      </Link>
    </div>
  );
}
