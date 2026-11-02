"use client";
import { BRAND, CLUSTER } from "@/lib/config";
import { explorerTx, fmtCompact, fmtSol, shortAddr, timeAgo, tokensToWhole } from "@/lib/format";
import type { FeedItem } from "@/lib/types";
import { AdThumb } from "./AdThumb";
import { IconFlame } from "./icons";

export function FeedRow({ item, now }: { item: FeedItem; now: number }) {
  const when = <time className="num shrink-0 text-[0.75rem] text-ash" dateTime={new Date(item.ts).toISOString()}>{timeAgo(item.ts, now)}</time>;
  if (item.type === "buyback")
    return (
      <div className="flex items-center gap-3 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center bg-flame text-soot" aria-hidden>
          <IconFlame size={18} />
        </span>
        <p className="min-w-0 flex-1 text-[0.95rem] leading-snug">
          <span className="font-semibold text-flame">Buyback.</span> <span className="num">{fmtSol(item.lamportsIn, 2)}</span> SOL bought{" "}
          <span className="num text-cone">{fmtCompact(tokensToWhole(item.tokensBurned))}</span> {BRAND.ticker}, burned.{" "}
          <a href={explorerTx(item.sig, CLUSTER)} target="_blank" rel="noreferrer" className="link-cobalt text-[0.8rem]">tx</a>
        </p>
        {when}
      </div>
    );
  if (item.type === "bid")
    return (
      <div className="flex items-center gap-3 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center border border-cone text-cone" aria-hidden>
          <IconFlame size={18} />
        </span>
        <p className="min-w-0 flex-1 text-[0.95rem]">
          <span className="num">{shortAddr(item.bidder)}</span> bid <span className="num text-cone">{fmtSol(item.lamports, 1)} SOL</span> in the final auction.
        </p>
        {when}
      </div>
    );
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center bg-char">
        <AdThumb rect={item} size={30} />
      </span>
      <p className="min-w-0 flex-1 text-[0.95rem] leading-snug">
        <span className="font-semibold">{item.title}</span> took{" "}
        <span className="num text-[0.85rem]">{item.w}×{item.h}</span> blocks at{" "}
        <span className="num text-[0.85rem]">{item.x},{item.y}</span>
        {item.payMode === "token" ? (
          <>
            {" "}and burned <span className="num text-cone">{fmtCompact(tokensToWhole(item.tokensBurned))}</span> {BRAND.ticker}
          </>
        ) : (
          <>
            {" "}for <span className="num">{fmtSol(item.lamports, 2)}</span> SOL
          </>
        )}
      </p>
      {when}
    </div>
  );
}
