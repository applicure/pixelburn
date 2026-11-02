"use client";
import { useEffect, useRef } from "react";

/**
 * Display line set in Anybody where width is temperature. Letters ignite from
 * condensed/cone-hot to their rest width with a pure-CSS stagger (so it paints
 * before hydration and never blocks LCP); afterwards, on fine pointers, letters
 * near the cursor heat up and widen.
 */
export function KineticHeading({
  lines,
  as: Tag = "h1",
  className = "",
  delay = 0,
  rest = 112,
}: {
  lines: string[];
  as?: "h1" | "h2";
  className?: string;
  delay?: number;
  rest?: number;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const total = lines.join("").length;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const letters = [...el.querySelectorAll<HTMLSpanElement>("[data-l]")];
    const heat = new Float32Array(letters.length);
    let px = -9999, py = -9999, raf = 0, rects: DOMRect[] = [], age = 0, active = false;
    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      if (!active) {
        active = true;
        raf = requestAnimationFrame(tick);
      }
    };
    const tick = (now: number) => {
      if (now - age > 400) {
        rects = letters.map((l) => l.getBoundingClientRect());
        age = now;
      }
      let moving = false;
      for (let i = 0; i < letters.length; i++) {
        const r = rects[i];
        const d = Math.hypot(r.left + r.width / 2 - px, r.top + r.height / 2 - py);
        const target = Math.max(0, 1 - d / 220);
        heat[i] += (target - heat[i]) * 0.12;
        if (Math.abs(target - heat[i]) > 0.002) moving = true;
        const l = letters[i];
        l.style.fontVariationSettings = `"wdth" ${(rest + (150 - rest) * heat[i]).toFixed(1)}`;
        l.style.color = heat[i] > 0.02 ? `color-mix(in oklab, var(--color-cone) ${(heat[i] * 80).toFixed(0)}%, var(--color-heat))` : "";
      }
      if (moving) raf = requestAnimationFrame(tick);
      else active = false;
    };
    // start reacting only after the ignition finishes, so inline styles don't fight the CSS animation
    const start = setTimeout(() => window.addEventListener("pointermove", onMove, { passive: true }), (delay + total * 0.028 + 0.9) * 1000);
    return () => {
      clearTimeout(start);
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [delay, rest, total]);

  let k = 0;
  return (
    <Tag ref={ref} className={className} aria-label={lines.join(" ")}>
      {lines.map((line, li) => (
        <span key={li} className="block whitespace-nowrap" aria-hidden>
          {[...line].map((ch, ci) => {
            const i = k++;
            return (
              <span
                key={ci}
                data-l
                className="ignite inline-block"
                style={{ fontVariationSettings: `"wdth" ${rest}`, ["--d" as string]: `${(delay + i * 0.028).toFixed(3)}s`, ["--rest" as string]: rest }}
              >
                {ch === " " ? " " : ch}
              </span>
            );
          })}
        </span>
      ))}
    </Tag>
  );
}
