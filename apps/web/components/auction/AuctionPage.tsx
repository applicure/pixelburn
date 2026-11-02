"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { AUCTION_THRESHOLD_BLOCKS, BRAND, HISTORY_2005, USE_MOCK } from "@/lib/config";
import { api } from "@/lib/api";
import { fmtInt, fmtUsd } from "@/lib/format";
import { useLive } from "@/lib/store";
import { useAsync } from "@/lib/useAsync";
import { Odometer } from "@/components/ui/Odometer";
import { WitnessCones } from "@/components/ui/WitnessCones";
import { KineticHeading } from "@/components/ui/KineticHeading";
import { LotMap } from "./LotMap";

const LiveAuction = dynamic(() => import("./LiveAuction"), { ssr: false, loading: () => <div className="min-h-[80svh]" /> });

function Pending() {
  const stats = useLive((s) => s.stats);
  const sold = stats?.soldBlocks ?? 0;
  const pct = (sold / 100);
  const toGo = Math.max(0, AUCTION_THRESHOLD_BLOCKS - sold);
  return (
    <>
      <section className="relative overflow-hidden pb-20 pt-16 sm:pt-24" aria-labelledby="auc-title">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_75%_100%,rgba(179,32,14,.35),transparent_70%)]" />
        <div className="mx-auto grid max-w-[1400px] items-end gap-12 px-4 sm:px-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <KineticHeading as="h1" lines={["The final", "firing hasn't", "started."]} className="font-black text-[clamp(2.8rem,8.6vw,7.4rem)] leading-[0.9]" rest={100} />
            <p className="mt-6 max-w-[50ch] text-heat/85">
              It opens the moment {fmtInt(AUCTION_THRESHOLD_BLOCKS)} of the 10,000 blocks are sold. Then fixed prices stop and
              every block still free is sold as one lot, to the highest SOL bid after 72 hours.
            </p>
          </div>
          <div className="lg:col-span-5">
            <WitnessCones pct={pct} />
          </div>
        </div>
      </section>

      <section className="border-t border-char py-16" aria-labelledby="progress-title">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
          <h2 id="progress-title" className="sr-only">Progress to the auction</h2>
          <div className="grid gap-px bg-char sm:grid-cols-3">
            <div className="bg-soot py-5 pr-6">
              <p className="text-[clamp(2.4rem,5.5vw,4.2rem)] font-medium leading-none">
                <Odometer value={fmtInt(toGo)} />
              </p>
              <p className="mt-3 text-[0.9rem] text-ash">blocks left to sell before it opens</p>
            </div>
            <div className="bg-soot py-5 pr-6 sm:pl-6">
              <p className="text-[clamp(2.4rem,5.5vw,4.2rem)] font-medium leading-none">
                <Odometer value={pct.toFixed(2)} />
                <span className="num text-[0.45em] text-ash">%</span>
              </p>
              <p className="mt-3 text-[0.9rem] text-ash">sold of the 99% that triggers it</p>
            </div>
            <div className="bg-soot py-5 pr-6 sm:pl-6">
              <p className="text-[clamp(2.4rem,5.5vw,4.2rem)] font-medium leading-none text-cone">72h</p>
              <p className="mt-3 text-[0.9rem] text-ash">of bidding once it starts</p>
            </div>
          </div>
          <div className="relative mt-8 h-4 bg-char" aria-hidden>
            <div className="absolute inset-y-0 left-0 bg-[linear-gradient(90deg,#b3200e,#ff5b14_70%,#ffc23d)]" style={{ width: `${(sold / AUCTION_THRESHOLD_BLOCKS) * 100}%` }} />
          </div>
          <p className="mt-2 flex justify-between text-[0.8rem] text-ash">
            <span className="num">{fmtInt(sold)} sold</span>
            <span className="num">{fmtInt(AUCTION_THRESHOLD_BLOCKS)}: auction opens</span>
          </p>
        </div>
      </section>

      <section className="border-t border-char py-16 sm:py-24" aria-labelledby="rules-title">
        <div className="mx-auto grid max-w-[1400px] gap-12 px-4 sm:px-6 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 id="rules-title" className="font-black text-[clamp(2rem,5vw,3.8rem)] [font-variation-settings:'wdth'_96]">
              How it runs
            </h2>
            <ol className="mt-8 space-y-6">
              {[
                ["Sales stop at 9,900 blocks", "The program refuses new fixed-price purchases and anyone can start the auction."],
                ["72 hours of SOL bids", "Each bid must beat the last. The previous high bidder is refunded in the same transaction."],
                ["The whole bid burns", `The winning SOL goes 100% to the buyback vault and comes out the other side as burned ${BRAND.ticker}.`],
                ["The winner fills the gaps", "One ad covers every remaining block, wherever they are on the wall."],
              ].map(([h, p], i) => (
                <li key={h} className="grid grid-cols-[2.5rem_1fr] gap-3">
                  <span className="num pt-1 text-[0.9rem] text-cone">{i + 1}</span>
                  <div>
                    <h3 className="font-display text-[1.3rem] font-extrabold leading-tight [font-variation-settings:'wdth'_110]">{h}</h3>
                    <p className="mt-1 text-heat/80">{p}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-10 border-l-2 border-cone pl-4 text-[0.95rem] text-heat/80">
              In January 2006 the original sold its last 1,000 pixels on eBay for {fmtUsd(HISTORY_2005.ebayUsd)}. This time
              the money doesn&apos;t go to anyone. It goes into the fire.
            </p>
          </div>
          <figure className="lg:col-span-6 lg:col-start-7">
            <LotMap />
            <figcaption className="mt-3 text-[0.85rem] text-ash">
              The lot, today: every highlighted block is still free. It shrinks with every sale.{" "}
              <Link className="link-cobalt" href="/canvas?select=1">Buy a block before it&apos;s auctioned</Link>
            </figcaption>
          </figure>
        </div>
      </section>
    </>
  );
}

export function AuctionPage() {
  const params = useSearchParams();
  const preview = USE_MOCK && params.get("preview") === "live";
  const state = useAsync(() => (preview ? import("@/lib/mock").then((m) => m.mockWorld().previewAuction()) : api.getAuction()), [preview]);
  return (
    <main id="main" className="pt-14">
      {state.data && state.data.status !== "pending" ? (
        <LiveAuction a={state.data} />
      ) : (
        <Pending />
      )}
      {USE_MOCK && (
        <p className="mx-auto max-w-[1400px] px-4 pb-10 text-[0.8rem] text-ash sm:px-6">
          Demo data.{" "}
          {preview ? (
            <Link className="link-cobalt" href="/auction">See the not-started state</Link>
          ) : (
            <Link className="link-cobalt" href="/auction?preview=live">Preview the live auction design</Link>
          )}
        </p>
      )}
    </main>
  );
}
