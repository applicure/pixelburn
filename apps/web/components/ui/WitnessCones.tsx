"use client";
import { useEffect } from "react";
import { motion, useReducedMotion, useSpring, useTransform } from "motion/react";

/**
 * Pyrometric witness cones. Potters stand three cones in the kiln; each slumps
 * when its temperature is reached. Here the "temperature" is the share of blocks sold.
 */
const SEG = 10;
function conePath(bend: number) {
  // centreline as a chain of segments whose angle grows toward the tip
  const len = 120;
  const base = 22;
  let x = 0, y = 0, a = -Math.PI / 2 + 0.08;
  const pts: [number, number, number][] = [[x, y, a]];
  for (let i = 1; i <= SEG; i++) {
    const k = i / SEG;
    a += bend * 0.42 * Math.pow(k, 1.6);
    x += Math.cos(a) * (len / SEG);
    y += Math.sin(a) * (len / SEG);
    pts.push([x, y, a]);
  }
  const left: string[] = [];
  const right: string[] = [];
  pts.forEach(([px, py, pa], i) => {
    const hw = (base / 2) * (1 - i / (SEG + 2));
    const nx = Math.cos(pa + Math.PI / 2) * hw;
    const ny = Math.sin(pa + Math.PI / 2) * hw;
    left.push(`${(px + nx).toFixed(2)},${(py + ny).toFixed(2)}`);
    right.unshift(`${(px - nx).toFixed(2)},${(py - ny).toFixed(2)}`);
  });
  return `M${left.join(" L")} L${right.join(" L")} Z`;
}

function Cone({ at, value, label }: { at: number; value: number; label: string }) {
  const reduce = useReducedMotion();
  const target = Math.min(1, Math.max(0, (value - (at - 12)) / 12));
  const s = useSpring(0, { stiffness: 40, damping: 14 });
  useEffect(() => {
    if (reduce) s.jump(target);
    else s.set(target);
  }, [target, s, reduce]);
  const d = useTransform(s, (b) => conePath(b * 1.75));
  const fill = useTransform(s, [0, 0.5, 1], ["#3a302a", "#b3200e", "#ffc23d"]);
  return (
    <figure className="flex flex-col items-center">
      <svg viewBox="-70 -140 140 160" className="h-auto w-full max-w-[150px] overflow-visible" aria-hidden>
        <rect x="-44" y="0" width="88" height="14" fill="#1c1714" />
        <motion.path d={d} style={{ fill }} />
      </svg>
      <figcaption className="mt-3 text-center text-[0.85rem]">
        <span className="num block text-heat">{at}%</span>
        <span className="text-ash">{label}</span>
      </figcaption>
    </figure>
  );
}

export function WitnessCones({ pct }: { pct: number }) {
  return (
    <div className="grid grid-cols-3 gap-4" role="img" aria-label={`Witness cones: ${pct.toFixed(1)}% of blocks sold; the auction cone slumps at 99%.`}>
      <Cone at={33} value={pct} label="a third" />
      <Cone at={66} value={pct} label="two thirds" />
      <Cone at={99} value={pct} label="auction" />
    </div>
  );
}
