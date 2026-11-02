"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "@/lib/config";
import { fmtCompact, fmtInt, tokensToWhole } from "@/lib/format";
import type { FeedItem, Stats } from "@/lib/types";

interface Pt { t: number; direct: number; buyback: number }

/** Cumulative tokens burned over time, stacked: via buyback (flame) under direct burns (cone). */
export function BurnChart({ feed, stats, now }: { feed: FeedItem[]; stats: Stats; now: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo<Pt[]>(() => {
    const items = [...feed].sort((a, b) => a.ts - b.ts);
    // totals before the first item in the window, so the curve ends at the live total
    let d = tokensToWhole(stats.tokensBurnedDirect), b = tokensToWhole(stats.tokensBurnedBuyback);
    for (const f of items) {
      if (f.type === "purchase") d -= tokensToWhole(f.tokensBurned);
      if (f.type === "buyback") b -= tokensToWhole(f.tokensBurned);
    }
    d = Math.max(0, d);
    b = Math.max(0, b);
    const out: Pt[] = [{ t: items[0]?.ts ?? now, direct: d, buyback: b }];
    for (const f of items) {
      if (f.type === "purchase") d += tokensToWhole(f.tokensBurned);
      if (f.type === "buyback") b += tokensToWhole(f.tokensBurned);
      out.push({ t: f.ts, direct: d, buyback: b });
    }
    out.push({ t: now, direct: d, buyback: b });
    return out;
  }, [feed, stats, now]);

  const H = w < 640 ? 260 : 360;
  const pad = { l: 8, r: w < 640 ? 8 : 64, t: 16, b: 28 };
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const max = Math.max(1, ...pts.map((p) => p.direct + p.buyback)) * 1.08;
  const X = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const step = (sel: (p: Pt) => number) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(sel(p)).toFixed(1)}`).join("");
  const area = (top: (p: Pt) => number, bot: (p: Pt) => number) =>
    `${step(top)}L${pts
      .slice()
      .reverse()
      .map((p) => `${X(p.t).toFixed(1)},${Y(bot(p)).toFixed(1)}`)
      .join("L")}Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => max * k / 1.08);
  const days = Math.max(1, Math.round((t1 - t0) / 86_400_000));
  const xt = [0, 0.33, 0.66, 1].map((k) => t0 + (t1 - t0) * k);
  const last = pts[pts.length - 1];
  const hp = hover !== null ? pts[hover] : null;

  const onMove = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(X(p.t) - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <figure>
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.85rem]">
        <span className="flex items-center gap-2"><span className="inline-block h-3 w-3 bg-cone" aria-hidden />Paid in {BRAND.ticker}, burned directly</span>
        <span className="flex items-center gap-2"><span className="inline-block h-3 w-3 bg-flame" aria-hidden />Bought back with SOL, then burned</span>
        <span className="text-ash">last {days} days</span>
      </div>
      <div ref={wrap} className="relative touch-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg width={w} height={H} role="img" aria-label={`Cumulative ${BRAND.ticker} burned: ${fmtCompact(last.direct + last.buyback)} in total, ${fmtCompact(last.buyback)} via buyback and ${fmtCompact(last.direct)} burned directly.`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={w - pad.r} y1={Y(v)} y2={Y(v)} stroke="#1c1714" />
              {w >= 640 && (
                <text x={w - pad.r + 8} y={Y(v) + 4} fill="#9a9087" fontSize="11" className="num">
                  {fmtCompact(v)}
                </text>
              )}
            </g>
          ))}
          {xt.map((t, i) => (
            <text key={t} x={X(t)} y={H - 8} fill="#9a9087" fontSize="11" textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}>
              {new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </text>
          ))}
          <path d={area((p) => p.buyback, () => 0)} fill="#ff5b14" opacity="0.9" />
          <path d={area((p) => p.buyback + p.direct, (p) => p.buyback)} fill="#ffc23d" opacity="0.9" />
          {/* 2px surface gap between the stacked fills */}
          <path d={step((p) => p.buyback)} fill="none" stroke="#000" strokeWidth="2" />
          <path d={step((p) => p.buyback + p.direct)} fill="none" stroke="#fff6e8" strokeWidth="2" />
          {hp && (
            <g>
              <line x1={X(hp.t)} x2={X(hp.t)} y1={pad.t} y2={H - pad.b} stroke="#fff6e8" strokeOpacity=".5" />
              <circle cx={X(hp.t)} cy={Y(hp.buyback + hp.direct)} r="5" fill="#fff6e8" stroke="#000" strokeWidth="2" />
            </g>
          )}
        </svg>
        {hp && (
          <div
            className="pointer-events-none absolute top-2 w-56 bg-soot/95 p-3 text-[0.8rem] ring-1 ring-char"
            style={{ left: Math.min(Math.max(0, X(hp.t) + 12), w - 230) }}
          >
            <p className="text-ash">{new Date(hp.t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
            <p className="mt-1 flex justify-between"><span>Total</span><span className="num">{fmtInt(Math.round(hp.direct + hp.buyback))}</span></p>
            <p className="flex justify-between text-heat/85"><span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 bg-cone" />Direct</span><span className="num">{fmtInt(Math.round(hp.direct))}</span></p>
            <p className="flex justify-between text-heat/85"><span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 bg-flame" />Buyback</span><span className="num">{fmtInt(Math.round(hp.buyback))}</span></p>
          </div>
        )}
      </div>
    </figure>
  );
}
