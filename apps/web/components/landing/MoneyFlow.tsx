"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BRAND } from "@/lib/config";
import { fmtCompact, fmtSol, lamportsToSol, tokensToWhole } from "@/lib/format";
import { onLiveEvent, useLive } from "@/lib/store";
import { Odometer } from "@/components/ui/Odometer";

type P = { t: number; side: -1 | 1; speed: number; size: number; jitter: number };
type E = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number };

// geometry in unit space
const SRC = { x: 0.5, y: 0.03 };
const SPLIT = { x: 0.5, y: 0.36 };
const L = { c: { x: 0.2, y: 0.38 }, end: { x: 0.2, y: 0.66 } };
const R = { c: { x: 0.8, y: 0.38 }, end: { x: 0.8, y: 0.66 } };

function quad(a: { x: number; y: number }, c: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}
function along(p: P) {
  if (p.t < 0.4) {
    const k = p.t / 0.4;
    return { x: SRC.x + (SPLIT.x - SRC.x) * k, y: SRC.y + (SPLIT.y - SRC.y) * k * k * 0.4 + (SPLIT.y - SRC.y) * k * 0.6 };
  }
  const k = (p.t - 0.4) / 0.6;
  return quad(SPLIT, p.side < 0 ? L.c : R.c, p.side < 0 ? L.end : R.end, k);
}

function heatColor(h: number, a: number) {
  // white-heat → cone → flame → cherry as h goes 0 → 1
  const stops = [
    [255, 246, 232],
    [255, 194, 61],
    [255, 91, 20],
    [179, 32, 14],
  ];
  const x = Math.min(0.999, Math.max(0, h)) * 3;
  const i = Math.floor(x);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function MoneyFlow() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLCanvasElement>(null);
  const stats = useLive((s) => s.stats);
  const [flare, setFlare] = useState<{ sol: string; tokens: string; key: string } | null>(null);
  const burstRef = useRef(0);
  // treasury vessel level = treasury value / the $500k it would hold at sell-out if every block were paid in SOL
  const fillReal = stats ? (lamportsToSol(stats.lamportsToTreasury) * stats.solPriceUsd) / 500_000 : 0;
  const fillTarget = Math.min(0.95, Math.max(0.02, fillReal)); // visual floor so the vessel never looks broken
  const fillRef = useRef(fillTarget);
  useEffect(() => {
    fillRef.current = fillTarget;
  }, [fillTarget]);
  const flareRef = useRef(0);

  useEffect(
    () =>
      onLiveEvent((f) => {
        if (f.type === "purchase") burstRef.current += Math.min(40, 6 + Math.round(f.usd / 100) * 2);
        if (f.type === "buyback") {
          flareRef.current = 1;
          setFlare({ sol: fmtSol(f.lamportsIn, 2), tokens: fmtCompact(tokensToWhole(f.tokensBurned)), key: f.sig });
          setTimeout(() => setFlare((cur) => (cur?.key === f.sig ? null : cur)), 5200);
        }
      }),
    [],
  );

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    let W = 0, H = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = cv.clientWidth;
      H = cv.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduce) drawStatic();
    };
    const ps: P[] = [];
    const es: E[] = [];
    let treasuryFill = fillRef.current;

    const drawFrame = (glow: number) => {
      ctx.clearRect(0, 0, W, H);
      // guide lines
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 6]);
      ctx.strokeStyle = "rgba(255,246,232,.18)";
      ctx.beginPath();
      ctx.moveTo(SRC.x * W, SRC.y * H);
      ctx.lineTo(SPLIT.x * W, SPLIT.y * H);
      for (const side of [L, R]) {
        ctx.moveTo(SPLIT.x * W, SPLIT.y * H);
        ctx.quadraticCurveTo(side.c.x * W, side.c.y * H, side.end.x * W, side.end.y * H);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // splitter
      ctx.fillStyle = "#fff6e8";
      const s = 7;
      ctx.beginPath();
      ctx.moveTo(SPLIT.x * W, SPLIT.y * H - s);
      ctx.lineTo(SPLIT.x * W + s, SPLIT.y * H);
      ctx.lineTo(SPLIT.x * W, SPLIT.y * H + s);
      ctx.lineTo(SPLIT.x * W - s, SPLIT.y * H);
      ctx.fill();
      // treasury vessel (cobalt glaze: kept)
      const vx = L.end.x * W - W * 0.11, vy = L.end.y * H + 6, vw = W * 0.22, vh = H * 0.19;
      ctx.strokeStyle = "#2b47e8";
      ctx.lineWidth = 2;
      ctx.strokeRect(vx, vy, vw, vh);
      ctx.fillStyle = "rgba(43,71,232,.85)";
      const fh = vh * treasuryFill;
      ctx.fillRect(vx + 3, vy + vh - fh - 3 + 3, vw - 6, fh - 3);
      ctx.fillStyle = "rgba(127,147,255,.9)";
      ctx.fillRect(vx + 3, vy + vh - fh, vw - 6, 2);
      // firebox
      const fx = R.end.x * W, fy = R.end.y * H;
      const g = ctx.createRadialGradient(fx, fy + H * 0.12, 4, fx, fy + H * 0.1, Math.min(W * 0.17, H * 0.3) * (1 + glow * 0.6));
      g.addColorStop(0, `rgba(255,194,61,${0.55 + glow * 0.45})`);
      g.addColorStop(0.4, `rgba(255,91,20,${0.35 + glow * 0.4})`);
      g.addColorStop(1, "rgba(179,32,14,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,91,20,.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fx - W * 0.11, fy + 6);
      ctx.lineTo(fx - W * 0.11, fy + H * 0.19 + 6);
      ctx.lineTo(fx + W * 0.11, fy + H * 0.19 + 6);
      ctx.lineTo(fx + W * 0.11, fy + 6);
      ctx.stroke();
    };

    function drawStatic() {
      treasuryFill = fillRef.current;
      drawFrame(0.2);
    }

    if (reduce) {
      const ro = new ResizeObserver(resize);
      ro.observe(cv);
      resize();
      return () => ro.disconnect();
    }

    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(cv);
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    resize();

    let last = performance.now();
    let acc = 0;
    let glow = 0;
    let raf = 0;
    const spawnEmber = (x: number, y: number, power = 1) =>
      es.push({ x, y, vx: (Math.random() - 0.5) * 30 * power, vy: -(30 + Math.random() * 70) * power, life: 0, max: 0.8 + Math.random() * 1.2, size: 1.5 + Math.random() * 2.5 });

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible) return;
      // feed the stream
      acc += dt * 9;
      while (acc > 1) {
        acc -= 1;
        ps.push({ t: 0, side: ps.length % 2 ? 1 : -1, speed: 0.22 + Math.random() * 0.08, size: 2 + Math.random() * 2, jitter: (Math.random() - 0.5) * 6 });
      }
      if (burstRef.current > 0) {
        const n = Math.min(4, burstRef.current);
        burstRef.current -= n;
        for (let i = 0; i < n; i++)
          ps.push({ t: Math.random() * 0.05, side: Math.random() < 0.5 ? 1 : -1, speed: 0.26 + Math.random() * 0.1, size: 3 + Math.random() * 2.5, jitter: (Math.random() - 0.5) * 10 });
      }
      if (flareRef.current > 0) {
        for (let i = 0; i < 140; i++) spawnEmber(R.end.x * W + (Math.random() - 0.5) * W * 0.2, R.end.y * H + H * 0.14, 2.2);
        flareRef.current = 0;
        glow = 1;
      }
      glow *= 0.985;
      treasuryFill += (fillRef.current - treasuryFill) * 0.01; // arrivals bump it, the real number pulls it back
      // idle fire
      if (Math.random() < 0.9) spawnEmber(R.end.x * W + (Math.random() - 0.5) * W * 0.18, R.end.y * H + H * 0.18);

      drawFrame(glow);

      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.t += dt * p.speed;
        if (p.t >= 1) {
          if (p.side > 0) for (let k = 0; k < 3; k++) spawnEmber(R.end.x * W + p.jitter, R.end.y * H + 8);
          else treasuryFill = Math.min(0.97, treasuryFill + 0.0015);
          ps.splice(i, 1);
          continue;
        }
        const q = along(p);
        const x = q.x * W + (p.t > 0.4 ? p.jitter * ((p.t - 0.4) / 0.6) : 0);
        const y = q.y * H;
        if (p.t < 0.4) ctx.fillStyle = "#fff6e8";
        else if (p.side < 0) ctx.fillStyle = p.t > 0.75 ? "#7f93ff" : "#c9d0ff";
        else ctx.fillStyle = heatColor(((p.t - 0.4) / 0.6) * 0.7, 1);
        ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
      }
      ctx.globalCompositeOperation = "lighter";
      for (let i = es.length - 1; i >= 0; i--) {
        const e = es[i];
        e.life += dt;
        if (e.life > e.max) {
          es.splice(i, 1);
          continue;
        }
        e.vy -= 20 * dt;
        e.vx += (Math.random() - 0.5) * 60 * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        const h = e.life / e.max;
        ctx.fillStyle = heatColor(h, 1 - h);
        const sz = e.size * (1 - h * 0.6);
        ctx.fillRect(e.x - sz / 2, e.y - sz / 2, sz, sz);
      }
      ctx.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
    };
  }, [reduce]);

  const treasury = stats ? fmtSol(stats.lamportsToTreasury, 1) : "0.0";
  const vault = stats ? fmtSol(stats.lamportsToBuyback, 1) : "0.0";
  const burned = stats ? fmtCompact(tokensToWhole(stats.tokensBurnedBuyback)) : "0";

  return (
    <section className="relative pb-14 pt-24 sm:pb-16 sm:pt-32" aria-labelledby="flow-title">
      <div className="mx-auto grid max-w-[1400px] gap-12 px-4 sm:px-6 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-5 lg:pt-10">
          <h2 id="flow-title" className="font-black text-[clamp(2.4rem,6vw,5rem)] [font-variation-settings:'wdth'_96]">
            Where your SOL goes.
          </h2>
          <p className="mt-6 max-w-[44ch] text-heat/85">
            Every SOL purchase splits in the same transaction. Half lands in the treasury. The other half goes to the
            buyback vault, which can only do one thing: buy {BRAND.ticker} on the market and burn it.
          </p>
          {stats && BigInt(stats.lamportsRaised) === 0n ? (
            <FirstBlockSplit solUsd={stats.solPriceUsd} tokenUsd={stats.tokenPriceUsd} />
          ) : (
          <dl className="mt-10 grid grid-cols-1 gap-px bg-char sm:grid-cols-2">
            <div className="bg-soot py-4 pr-4">
              <dt className="text-[0.85rem] text-cobalt-hi">Treasury, 50%</dt>
              <dd className="mt-2 text-[1.9rem] font-medium">
                <Odometer value={treasury} /> <span className="text-[0.95rem] text-ash">SOL</span>
              </dd>
            </div>
            <div className="bg-soot py-4 pr-4">
              <dt className="text-[0.85rem] text-flame">Buyback and burn, 50%</dt>
              <dd className="mt-2 text-[1.9rem] font-medium">
                <Odometer value={vault} /> <span className="text-[0.95rem] text-ash">SOL</span>
              </dd>
            </div>
            <div className="bg-soot py-4 pr-4 sm:col-span-2">
              <dt className="text-[0.85rem] text-ash">{BRAND.ticker} bought back and burned so far</dt>
              <dd className="mt-2 text-[1.9rem] font-medium text-cone">
                <Odometer value={burned} />
              </dd>
            </div>
          </dl>
          )}
        </div>

        <div className="relative lg:col-span-7">
          <div className="relative mb-8 aspect-[4/5] w-full sm:aspect-[16/11]">
            <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden />
            <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full pb-1 text-[0.85rem] text-heat">Your SOL</span>
            <span className="absolute left-[20%] top-[88%] -translate-x-1/2 whitespace-nowrap text-center text-[0.85rem] leading-tight text-cobalt-hi">
              Treasury
              <span className="num block text-[0.7rem] text-ash">{fillReal === 0 ? "empty for now" : fillReal < 0.01 ? "under 1% of sell-out" : `${Math.round(fillReal * 100)}% of sell-out`}</span>
            </span>
            <span className="absolute left-[80%] top-[88%] -translate-x-1/2 whitespace-nowrap text-[0.85rem] text-flame">Buyback, then burn</span>
            <AnimatePresence>
              {flare && (
                <motion.div
                  key={flare.key}
                  role="status"
                  className="absolute right-0 top-[8%] max-w-[17rem] bg-flame p-4 text-soot"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ type: "spring", bounce: 0, duration: 0.5 }}
                >
                  <p className="font-display text-[1.3rem] font-black leading-none [font-variation-settings:'wdth'_120]">Buyback landed</p>
                  <p className="mt-2 text-[0.92rem] leading-snug">
                    <span className="num">{flare.sol}</span> SOL bought <span className="num">{flare.tokens}</span> {BRAND.ticker}. All of it burned.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Nothing raised yet: instead of three zeros, show what the first $100 block does at today's prices. */
function FirstBlockSplit({ solUsd, tokenUsd }: { solUsd: number; tokenUsd: number }) {
  const sol = solUsd > 0 ? 100 / solUsd : 0;
  const tokens = tokenUsd > 0 ? 50 / tokenUsd : 0;
  return (
    <div className="mt-10">
      <p className="text-[0.95rem] text-heat/85">Nothing raised yet. Here is what the first $100 block paid in SOL does, at today&apos;s prices:</p>
      <dl className="mt-4 grid grid-cols-1 gap-px bg-char sm:grid-cols-3">
        <div className="bg-soot py-4 pr-4">
          <dt className="text-[0.85rem] text-cobalt-hi">To the treasury</dt>
          <dd className="num mt-1 text-[1.5rem]">{solUsd > 0 ? (sol / 2).toFixed(3) : "…"} <span className="text-[0.8rem] text-ash">SOL</span></dd>
        </div>
        <div className="bg-soot py-4 pr-4">
          <dt className="text-[0.85rem] text-flame">To the buyback vault</dt>
          <dd className="num mt-1 text-[1.5rem]">{solUsd > 0 ? (sol / 2).toFixed(3) : "…"} <span className="text-[0.8rem] text-ash">SOL</span></dd>
        </div>
        <div className="bg-soot py-4 pr-4">
          <dt className="text-[0.85rem] text-ash">Then burned, estimated</dt>
          <dd className="num mt-1 text-[1.5rem] text-cone">{tokenUsd > 0 ? fmtCompact(tokens) : "…"} <span className="text-[0.8rem] text-ash">{BRAND.ticker}</span></dd>
        </div>
      </dl>
      <p className="mt-3 text-[0.78rem] text-ash">The burn is an estimate: the vault buys later, at the price of the day.</p>
    </div>
  );
}
