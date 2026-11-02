"use client";
import { motion, useReducedMotion } from "motion/react";

/**
 * Mechanical counter: each digit is a drum that steps one pitch and settles
 * with a single overshoot (damping ~0.7), like a kiln controller readout.
 */
export function Odometer({ value, className = "" }: { value: string; className?: string }) {
  const reduce = useReducedMotion();
  const chars = [...value];
  return (
    <span className={`num inline-flex leading-none ${className}`} aria-label={value} role="text">
      {chars.map((ch, i) => {
        const key = chars.length - i; // stable from the right so drums don't remount when digits are added
        if (!/[0-9]/.test(ch))
          return (
            <span key={`s${key}`} aria-hidden className="inline-block">
              {ch}
            </span>
          );
        const d = +ch;
        return (
          <span key={`d${key}`} aria-hidden className="relative inline-block h-[1em] overflow-hidden [mask-image:linear-gradient(transparent,#000_18%,#000_82%,transparent)]" style={{ width: "0.9ch" }}>
            <motion.span
              className="absolute left-0 top-0 flex flex-col"
              initial={false}
              animate={{ y: `${-d}em` }}
              transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 210, damping: 19, mass: 0.9 }}
            >
              {"0123456789".split("").map((n) => (
                <span key={n} className="block h-[1em] leading-none">
                  {n}
                </span>
              ))}
            </motion.span>
          </span>
        );
      })}
    </span>
  );
}
