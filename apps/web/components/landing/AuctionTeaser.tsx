"use client";
import Link from "next/link";
import { BRAND, HISTORY_2005 } from "@/lib/config";
import { fmtInt, fmtUsd } from "@/lib/format";
import { useLive } from "@/lib/store";
import { WitnessCones } from "@/components/ui/WitnessCones";

export function AuctionTeaser() {
  const stats = useLive((s) => s.stats);
  const pct = stats ? (stats.soldBlocks / stats.totalBlocks) * 100 : 0;
  const toGo = stats ? Math.max(0, 9900 - stats.soldBlocks) : null;
  return (
    <section className="relative overflow-hidden border-t border-char bg-[radial-gradient(80%_60%_at_70%_110%,rgba(179,32,14,.35),transparent_70%)] py-24 sm:py-32" aria-labelledby="auction-title">
      <div className="mx-auto grid max-w-[1400px] items-center gap-14 px-4 sm:px-6 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <h2 id="auction-title" className="font-black text-[clamp(2.4rem,6vw,5.2rem)] [font-variation-settings:'wdth'_104]">
            The last 1% is the final firing.
          </h2>
          <p className="mt-6 max-w-[46ch] text-heat/85">
            When 9,900 blocks are sold, fixed prices stop. Every block still free becomes one lot, auctioned for 72 hours
            in SOL. The whole winning bid goes to buyback, so all of it ends up as burned {BRAND.ticker}.
          </p>
          <p className="mt-4 max-w-[46ch] text-[0.95rem] text-ash">
            In January 2006 the last 1,000 pixels of the original went to an eBay auction for {fmtUsd(HISTORY_2005.ebayUsd)}.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-5">
            <Link href="/auction" className="btn-line">
              See the auction
            </Link>
            {toGo !== null && (
              <p className="text-[0.92rem] text-ash">
                <span className="num text-heat">{fmtInt(toGo)}</span> blocks until it opens
              </p>
            )}
          </div>
        </div>
        <div className="lg:col-span-5 lg:col-start-8">
          <WitnessCones pct={pct} />
        </div>
      </div>
    </section>
  );
}
