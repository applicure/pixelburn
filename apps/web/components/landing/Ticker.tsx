"use client";
import { useLive } from "@/lib/store";
import { BRAND } from "@/lib/config";
import { fmtCompact, fmtSol, tokensToWhole } from "@/lib/format";
import type { FeedItem } from "@/lib/types";

function line(f: FeedItem) {
  if (f.type === "buyback") return `Buyback: ${fmtSol(f.lamportsIn, 1)} SOL, ${fmtCompact(tokensToWhole(f.tokensBurned))} ${BRAND.ticker} burned`;
  if (f.type === "bid") return `Auction bid: ${fmtSol(f.lamports, 1)} SOL`;
  return f.payMode === "token"
    ? `${f.title} took ${f.w}×${f.h}, burned ${fmtCompact(tokensToWhole(f.tokensBurned))} ${BRAND.ticker}`
    : `${f.title} took ${f.w}×${f.h} for ${fmtSol(f.lamports, 2)} SOL`;
}

/** Firing-log marquee. Decorative duplicate of the feed (the accessible feed lives below). */
export function Ticker() {
  const feed = useLive((s) => s.feed);
  const items = feed.slice(0, 14);
  if (!items.length) return <div className="h-11 border-y border-char" aria-hidden />;
  const row = (dup: boolean) =>
    items.map((f) => (
      <span key={(dup ? "b" : "a") + f.sig} className="flex shrink-0 items-center gap-3 pr-10">
        <span className={`inline-block h-2 w-2 ${f.type === "buyback" ? "bg-flame" : f.type === "bid" ? "bg-cone" : "bg-heat/70"}`} />
        <span className={f.type === "buyback" ? "text-flame" : "text-heat/85"}>{line(f)}</span>
      </span>
    ));
  return (
    <div className="relative h-11 overflow-hidden border-y border-char text-[0.85rem]" aria-hidden>
      <div className="ticker-track absolute inset-y-0 left-0 flex w-max items-center">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
