"use client";
/** Live final-auction view. Loaded on demand so the wallet stack (web3.js) only ships when bidding is possible. */
import { useEffect, useState } from "react";
import { BRAND, CLUSTER, LAMPORTS_PER_SOL, USE_MOCK } from "@/lib/config";
import { explorerTx, fmtInt, fmtSol, shortAddr, timeAgo } from "@/lib/format";
import { chain } from "@/lib/chain";
import { minNextBid } from "@mpb/sdk/quote";
import type { AuctionState } from "@/lib/types";
import { Odometer } from "@/components/ui/Odometer";
import { WalletChip, WalletLayer, useWalletBridge } from "@/components/canvas/Wallet";
import { LotMap } from "./LotMap";

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Live({ a }: { a: AuctionState }) {
  const now = useNow();
  const left = Math.max(0, (a.endsAt ?? now) - now);
  const hh = Math.floor(left / 3.6e6), mm = Math.floor((left % 3.6e6) / 6e4), ss = Math.floor((left % 6e4) / 1000);
  const high = a.highBid ? BigInt(a.highBid) : 0n;
  const min = minNextBid(high);
  const wallet = useWalletBridge();
  const [bid, setBid] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<{ sig: string; lamports: bigint } | null>(null);
  const bidL = BigInt(Math.round((Number(bid) || 0) * LAMPORTS_PER_SOL));
  const tooLow = bid !== "" && bidL < min;
  return (
    <>
      <section className="relative overflow-hidden pb-16 pt-16 sm:pt-24" aria-labelledby="auc-title">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_60%_at_50%_110%,rgba(255,91,20,.45),rgba(179,32,14,.18)_45%,transparent_75%)]" />
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
          <h1 id="auc-title" className="font-black text-[clamp(2.6rem,7vw,6rem)] [font-variation-settings:'wdth'_120]">
            The final firing is live.
          </h1>
          <p className="mt-4 max-w-[50ch] text-heat/85">
            {fmtInt(a.blocks)} blocks, one lot. The highest bid when the clock hits zero wins, and all of it goes to buying back and burning {BRAND.ticker}.
          </p>
          <div className="mt-10 grid gap-10 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <p className="text-[0.9rem] text-ash">Time left</p>
              <p className="mt-2 text-[clamp(3.4rem,11vw,9rem)] font-medium leading-none tracking-tight text-heat" aria-live="off">
                <Odometer value={`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`} />
              </p>
              <div className="mt-10 grid gap-px bg-char sm:grid-cols-2">
                <div className="bg-soot py-4 pr-4">
                  <p className="text-[0.85rem] text-ash">High bid</p>
                  <p className="mt-1 text-[2.4rem] leading-none text-cone">
                    <Odometer value={fmtSol(high, 2)} /> <span className="text-base text-ash">SOL</span>
                  </p>
                  <p className="num mt-1 text-[0.75rem] text-ash">by {a.highBidder ? shortAddr(a.highBidder) : "nobody yet"}</p>
                </div>
                <div className="bg-soot py-4 pr-4 sm:pl-4">
                  <p className="text-[0.85rem] text-ash">Bids so far</p>
                  <p className="mt-1 text-[2.4rem] leading-none">{a.bids.length}</p>
                </div>
              </div>
            </div>
            <form
              className="self-start bg-kiln p-5 ring-1 ring-char lg:col-span-5"
              onSubmit={async (e) => {
                e.preventDefault();
                if (tooLow || !bid) return setMsg(`Bid at least ${fmtSol(min, 2)} SOL.`);
                if (!wallet.address) return wallet.openPicker();
                setBusy(true);
                setMsg(USE_MOCK ? "Demo mode: simulating your bid…" : "Approve the bid in your wallet…");
                try {
                  const r = await chain.bid(bidL, wallet.signer, wallet.connection);
                  setPlaced({ sig: r.signature, lamports: bidL });
                  setMsg(null);
                  setBid("");
                } catch (err) {
                  setMsg((err instanceof Error && err.message) || (err as { error?: { message?: string } })?.error?.message || "The bid didn't go through. Nothing was charged.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label htmlFor="bid" className="text-[0.95rem] font-semibold">
                Your bid
              </label>
              <div className="mt-2 flex items-center border border-char bg-soot focus-within:border-cone">
                <input
                  id="bid"
                  inputMode="decimal"
                  value={bid}
                  onChange={(e) => setBid(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder={fmtSol(min, 2)}
                  aria-invalid={tooLow}
                  aria-describedby="bid-help"
                  className="num w-full bg-transparent px-3 py-3 text-xl text-heat outline-none"
                />
                <span className="px-3 text-ash">SOL</span>
              </div>
              <p id="bid-help" className={`mt-2 text-[0.82rem] ${tooLow ? "text-flame" : "text-ash"}`}>
                Minimum {fmtSol(min, 2)} SOL. If you&apos;re outbid, your SOL comes back automatically.
              </p>
              <div className="mt-4 space-y-3">
                <WalletChip />
                <button className="btn-fire w-full justify-center text-lg" disabled={busy}>
                  {!wallet.address ? "Connect wallet to bid" : busy ? "Placing bid…" : `Bid ${bid ? `${bid} SOL` : ""}`.trim()}
                </button>
              </div>
              {placed && (
                <p className="mt-3 border border-cone/60 bg-cone/10 px-3 py-2 text-[0.88rem]" role="status">
                  You&apos;re the high bidder at <span className="num">{fmtSol(placed.lamports, 2)}</span> SOL.{" "}
                  {USE_MOCK ? "(Demo: nothing was sent.)" : (
                    <a className="link-cobalt" href={explorerTx(placed.sig, CLUSTER)} target="_blank" rel="noreferrer">View transaction</a>
                  )}
                </p>
              )}
              {msg && (
                <p className="mt-3 text-[0.85rem] text-heat/85" role="status">
                  {msg}
                </p>
              )}
            </form>
          </div>
        </div>
      </section>
      <section className="border-t border-char py-16" aria-labelledby="bids-title">
        <div className="mx-auto grid max-w-[1400px] gap-12 px-4 sm:px-6 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <h2 id="bids-title" className="font-black text-[clamp(2rem,4.4vw,3.4rem)] [font-variation-settings:'wdth'_96]">
              Bids
            </h2>
            <ol className="mt-6 divide-y divide-char border-y border-char">
              {a.bids.map((b, i) => (
                <li key={b.ts} className="grid grid-cols-[1fr_auto_auto] items-baseline gap-4 py-3">
                  <span className="num text-[0.85rem]">{shortAddr(b.bidder)}</span>
                  <span className={`num ${i === 0 ? "text-cone" : "text-heat/80"}`}>{fmtSol(b.lamports, 2)} SOL</span>
                  <span className="num text-[0.75rem] text-ash">{timeAgo(b.ts, now)}</span>
                </li>
              ))}
            </ol>
          </div>
          <figure className="lg:col-span-6">
            <LotMap />
            <figcaption className="mt-3 text-[0.85rem] text-ash">The lot: every highlighted block goes to the winner.</figcaption>
          </figure>
        </div>
      </section>
    </>
  );
}


export default function LiveAuction({ a }: { a: AuctionState }) {
  return (
    <WalletLayer>
      <Live a={a} />
    </WalletLayer>
  );
}
