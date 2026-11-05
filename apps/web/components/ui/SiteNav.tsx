"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconClose, IconMenu, Mark, Wordmark } from "./icons";
import { useLive } from "@/lib/store";
import { BRAND } from "@/lib/config";

const LINKS = [
  { href: "/canvas", label: "Canvas" },
  { href: "/burns", label: "Burns" },
  { href: "/auction", label: "Auction" },
];

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const sold = useLive((s) => s.stats?.soldBlocks ?? null);
  const pct = sold === null ? null : sold / 100;
  const onCanvas = pathname.startsWith("/canvas");

  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={`fixed inset-x-0 top-0 z-50 ${onCanvas ? "" : "material"}`}>
      <div
        className={`flex h-14 items-center gap-4 px-4 sm:px-6 ${onCanvas ? "bg-soot/80 backdrop-blur-md" : "bg-soot/70 backdrop-blur-xl"}`}
        style={{ WebkitBackdropFilter: "blur(18px) saturate(140%)" }}
      >
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label={`${BRAND.name}, home`}>
          <Mark unit={2} />
          <Wordmark unit={1} />
        </Link>

        {pct !== null && (
          <Link
            href="/canvas"
            className="ml-1 hidden items-center gap-2 border border-char px-2 py-1 text-[0.72rem] text-ash hover:text-heat md:flex"
            title="Share of the 10,000 blocks already sold"
          >
            <span className="relative block h-1.5 w-16 bg-char">
              <span className="absolute inset-y-0 left-0 bg-flame" style={{ width: `${pct}%` }} />
            </span>
            <span className="num">{pct === 0 ? "all blocks open" : `${pct.toFixed(2)}% sold`}</span>
          </Link>
        )}

        <nav aria-label="Main" className="ml-auto hidden items-center gap-1 sm:flex">
          {LINKS.map((l) => {
            const active = pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`relative px-3 py-2 text-[0.95rem] font-medium transition-colors ${active ? "text-heat" : "text-ash hover:text-heat"}`}
              >
                {l.label}
                {active && <span className="absolute inset-x-3 -bottom-0.5 h-[2px] bg-flame" />}
              </Link>
            );
          })}
          <Link href="/canvas?select=1" className="btn-fire ml-3 !py-2.5 text-[0.95rem]">
            Buy pixels
          </Link>
        </nav>

        <button
          className="ml-auto grid h-10 w-10 place-items-center sm:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <IconClose /> : <IconMenu />}
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.nav
            aria-label="Main"
            className="fixed inset-x-0 bottom-0 top-14 flex flex-col bg-soot px-4 pb-8 pt-6 sm:hidden"
            initial={reduce ? { opacity: 0 } : { clipPath: "inset(0 0 100% 0)" }}
            animate={reduce ? { opacity: 1 } : { clipPath: "inset(0 0 0% 0)" }}
            exit={reduce ? { opacity: 0 } : { clipPath: "inset(0 0 100% 0)" }}
            transition={{ type: "spring", bounce: 0, duration: 0.45 }}
          >
            {[{ href: "/", label: "Home" }, ...LINKS].map((l, i) => (
              <motion.div
                key={l.href}
                initial={reduce ? false : { y: 24, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.06 + i * 0.05, type: "spring", bounce: 0, duration: 0.5 }}
              >
                <Link
                  href={l.href}
                  className="block border-b border-char py-4 font-display text-5xl font-black [font-variation-settings:'wdth'_130]"
                >
                  {l.label}
                </Link>
              </motion.div>
            ))}
            <Link href="/canvas?select=1" className="btn-fire mt-auto justify-center text-xl">
              Buy pixels
            </Link>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
