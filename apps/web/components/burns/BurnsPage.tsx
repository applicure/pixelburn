"use client";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { api, type BuybackItem } from "@/lib/api";
import { BRAND, CLUSTER, TOKEN_DECIMALS, USE_MOCK, rpcEndpoint } from "@/lib/config";
import { explorerAddr, explorerTx, fmtCompact, fmtInt, fmtSol, fmtUsd, lamportsToSol, shortAddr, timeAgo, tokensToWhole } from "@/lib/format";
import { useLive } from "@/lib/store";
import { useAsync } from "@/lib/useAsync";
import { Odometer } from "@/components/ui/Odometer";
import { KineticHeading } from "@/components/ui/KineticHeading";
import { BurnChart } from "./BurnChart";

type Addr = { label: string; value: string | null; note: string };
const ADDR_NOTES: Addr[] = [
  { label: "Program", value: null, note: "The billboard program. Holds the canvas bitmap and every ad record." },
  { label: "Treasury", value: null, note: "Receives 50% of SOL purchases." },
  { label: "Buyback vault", value: null, note: `A program account. The program spends its SOL only on buying ${BRAND.ticker} and burning it.` },
  { label: `${BRAND.ticker} mint`, value: null, note: "Supply shrinks with every burn." },
];

/** Program + PDAs come from @mpb/sdk; treasury and mint are read from the config account via /api/rpc. */
function useAddresses() {
  const [addrs, setAddrs] = useState<Addr[]>(ADDR_NOTES);
  useEffect(() => {
    let live = true;
    (async () => {
      const sdk = await import("@mpb/sdk");
      const base = [sdk.PROGRAM_ID.toBase58(), null, sdk.buybackVaultPda().toBase58(), null];
      if (live) setAddrs(ADDR_NOTES.map((a, i) => ({ ...a, value: base[i] })));
      try {
        const { Connection } = await import("@solana/web3.js");
        const cfg = await sdk.fetchConfig(new Connection(rpcEndpoint(), { commitment: "confirmed", disableRetryOnRateLimit: true }));
        if (live) setAddrs(ADDR_NOTES.map((a, i) => ({ ...a, value: [base[0], cfg.treasury.toBase58(), base[2], cfg.tokenMint.toBase58()][i] })));
      } catch {
        // RPC not configured or program not deployed on this cluster: keep the derived ones
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return addrs;
}

function Bar({ parts }: { parts: { v: number; c: string; label: string }[] }) {
  const reduce = useReducedMotion();
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  return (
    <div className="flex h-10 w-full gap-[2px]" role="img" aria-label={parts.map((p) => `${p.label} ${((p.v / total) * 100).toFixed(1)}%`).join(", ")}>
      {parts.map((p) => (
        <motion.div
          key={p.label}
          className="h-full"
          style={{ background: p.c }}
          initial={reduce ? false : { width: 0 }}
          whileInView={{ width: `${(p.v / total) * 100}%` }}
          viewport={{ once: true }}
          transition={{ type: "spring", bounce: 0, duration: 1.1 }}
        />
      ))}
    </div>
  );
}

export function BurnsPage() {
  const stats = useLive((s) => s.stats);
  const liveFeed = useLive((s) => s.feed);
  const history = useAsync(() => api.getFeed(500), []);
  const board = useAsync(() => api.getLeaderboard(), []);
  const addrs = useAddresses();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // merge the long history with anything that streamed in since
  const merged = (() => {
    const m = new Map<string, (typeof liveFeed)[number]>();
    for (const f of history.data ?? []) m.set(f.sig, f);
    for (const f of liveFeed) m.set(f.sig, f);
    return [...m.values()].sort((a, b) => b.ts - a.ts);
  })();
  // buyback table: paged from /api/buybacks, with anything that streamed in since on top
  const [pages, setPages] = useState<{ items: BuybackItem[]; next: string | null; loading: boolean }>({ items: [], next: null, loading: true });
  useEffect(() => {
    let live = true;
    api.getBuybacks(null, 25).then(
      (r) => live && setPages({ items: r.items, next: r.nextCursor, loading: false }),
      () => live && setPages((p) => ({ ...p, loading: false })),
    );
    return () => {
      live = false;
    };
  }, []);
  const loadMore = async () => {
    if (!pages.next) return;
    setPages((p) => ({ ...p, loading: true }));
    const r = await api.getBuybacks(pages.next, 50).catch(() => null);
    setPages((p) => (r ? { items: [...p.items, ...r.items], next: r.nextCursor, loading: false } : { ...p, loading: false }));
  };
  const buybacks = (() => {
    const seen = new Set(pages.items.map((b) => b.sig));
    const fresh = liveFeed.filter((f): f is BuybackItem => f.type === "buyback" && !seen.has(f.sig) && f.ts > (pages.items[0]?.ts ?? 0));
    return [...fresh, ...pages.items];
  })();
  const supply0 = 1_000_000_000;
  const burned = stats ? tokensToWhole(stats.tokensBurned) : 0;
  const raised = stats ? BigInt(stats.lamportsRaised) : 0n;
  const toT = stats ? BigInt(stats.lamportsToTreasury) : 0n;
  const toB = stats ? BigInt(stats.lamportsToBuyback) : 0n;
  const spent = stats ? BigInt(stats.lamportsSpentBuyback) : 0n;
  const waiting = toB > spent ? toB - spent : 0n;

  return (
    <main id="main" className="pt-14">
      {/* headline numbers */}
      <section className="relative overflow-hidden pb-16 pt-16 sm:pt-24" aria-labelledby="burns-title">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[120%] bg-[radial-gradient(70%_60%_at_20%_0%,rgba(255,100,0,.22),transparent_70%)]" />
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
          <KineticHeading as="h1" lines={["Burned,", "on the record."]} className="font-black text-[clamp(2.4rem,9.4vw,8.5rem)] leading-[0.92]" rest={96} />
          <p className="mt-6 max-w-[52ch] text-heat/85">
            Every token below is gone for good. Two ways in: buyers who pay in {BRAND.ticker} burn it directly, and the
            buyback vault spends half of every SOL purchase on {BRAND.ticker} and burns that too.
          </p>
          {stats && burned === 0 ? (
            <div className="mt-12 border-y border-char py-8">
              <p className="font-display text-[clamp(2rem,5vw,3.6rem)] font-black leading-none [font-variation-settings:'wdth'_70]">
                Nothing burned yet.
              </p>
              <p className="mt-3 text-heat/80">
                All {fmtInt(supply0)} {BRAND.ticker} are still in circulation. The record starts with the first purchase.
              </p>
            </div>
          ) : (
          <div className="mt-12 grid gap-px bg-char sm:grid-cols-3">
            <div className="bg-soot py-5 pr-6">
              <p className="text-[clamp(2.2rem,4.2vw,3.9rem)] font-medium leading-none text-cone">
                <Odometer value={fmtInt(Math.round(burned))} />
              </p>
              <p className="mt-3 text-[0.9rem] text-ash">{BRAND.ticker} burned by the billboard</p>
            </div>
            <div className="bg-soot py-5 pr-6 sm:pl-6">
              <p className="text-[clamp(2.2rem,4.2vw,3.9rem)] font-medium leading-none">
                <Odometer value={(stats?.burnedPct ?? 0).toFixed(3)} />
                <span className="num text-[0.45em] text-ash">%</span>
              </p>
              <p className="mt-3 text-[0.9rem] text-ash">of the 1B starting supply, by the billboard</p>
            </div>
            <div className="bg-soot py-5 pr-6 sm:pl-6">
              <p className="text-[clamp(2.2rem,4.2vw,3.9rem)] font-medium leading-none">
                <Odometer value={stats ? fmtCompact(tokensToWhole(stats.tokensBurnedBuyback)) : "0"} />
              </p>
              <p className="mt-3 text-[0.9rem] text-ash">
                of it via buybacks, {stats ? fmtCompact(tokensToWhole(stats.tokensBurnedDirect)) : "0"} paid in {BRAND.ticker}
              </p>
            </div>
          </div>
          )}
          <div className="mt-6">
            <Bar
              parts={[
                { v: stats ? tokensToWhole(stats.tokensBurnedBuyback) : 0, c: "#ff6400", label: "burned via buyback" },
                { v: stats ? tokensToWhole(stats.tokensBurnedDirect) : 0, c: "#ffc23d", label: "burned directly" },
                { v: supply0 - burned, c: "#1c1714", label: "not burned by the billboard" },
              ]}
            />
            <p className="mt-2 text-[0.8rem] text-ash">
              Full bar is the starting supply of {fmtInt(supply0)} {BRAND.ticker} ({TOKEN_DECIMALS} decimals). Coloured: burned by this
              billboard only.
            </p>
            {stats && (BigInt(stats.tokensBurnedExternal ?? "0") > 0n || BigInt(stats.supplyReduction ?? "0") > 0n) && (
              <dl className="mt-5 grid max-w-3xl gap-x-8 gap-y-2 border-t border-char pt-4 text-[0.85rem] sm:grid-cols-[1fr_auto]">
                {stats.tokensBurnedExternal && BigInt(stats.tokensBurnedExternal) > 0n && (
                  <>
                    <dt className="text-ash">+ burned by others (pump.fun&apos;s own buy-and-burn, not this billboard)</dt>
                    <dd className="num text-heat/80">{fmtCompact(tokensToWhole(stats.tokensBurnedExternal))}</dd>
                  </>
                )}
                {stats.supplyReduction && BigInt(stats.supplyReduction) > 0n && (
                  <>
                    <dt className="text-ash">Total supply reduction (incl. pump.fun&apos;s own buy-and-burn)</dt>
                    <dd className="num text-heat/80">
                      {fmtCompact(tokensToWhole(stats.supplyReduction))}
                      {stats.supplyReductionPct !== undefined && ` (${stats.supplyReductionPct.toFixed(2)}%)`}
                    </dd>
                  </>
                )}
                <dt className="text-ash">On-chain supply now</dt>
                <dd className="num text-heat/80">{fmtCompact(tokensToWhole(stats.tokenSupply))}</dd>
                <dd className="text-[0.78rem] text-ash sm:col-span-2">
                  Shown for transparency. The figures above count only burns made by this billboard; burns by pump.fun&apos;s own
                  mechanisms are not ours and are never added to them.
                </dd>
              </dl>
            )}
            {stats && burned === 0 && (
              <p className="mt-6 flex max-w-[62ch] gap-2.5 text-[0.95rem] text-heat/85">
                <span className="mt-2 block h-2 w-2 shrink-0 animate-[flicker_2s_infinite] bg-flame" aria-hidden />
                How it starts: the first {BRAND.ticker}-paid block burns in its own transaction; the first SOL purchase
                fills the buyback vault for the next buyback. Every one will be listed here with its transaction.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* firing curve */}
      <section className="border-t border-char py-16 sm:py-24" aria-labelledby="curve-title">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
          <h2 id="curve-title" className="font-black text-[clamp(2rem,5vw,3.8rem)] [font-variation-settings:'wdth'_96]">
            The firing curve
          </h2>
          <p className="mb-8 mt-3 max-w-[52ch] text-heat/80">Cumulative {BRAND.ticker} burned. Steps up are buybacks landing; the slope between them is people paying in {BRAND.ticker}.</p>
          {!stats || history.loading ? (
            <div className="h-[360px] animate-pulse bg-char/40" aria-label="Loading chart" />
          ) : burned === 0 ? (
            <EmptyCurve />
          ) : (
            <BurnChart feed={merged} stats={stats} now={now} />
          )}
        </div>
      </section>

      {/* treasury */}
      <section className="border-t border-char py-16 sm:py-24" aria-labelledby="treasury-title">
        <div className="mx-auto grid max-w-[1400px] gap-12 px-4 sm:px-6 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 id="treasury-title" className="font-black text-[clamp(2rem,5vw,3.8rem)] [font-variation-settings:'wdth'_96]">
              Where the SOL sits
            </h2>
            <p className="mt-3 max-w-[46ch] text-heat/80">Read from the canvas account on-chain. Anyone can check these numbers against the addresses below.</p>
          </div>
          <div className="lg:col-span-7">
            <Bar
              parts={[
                { v: lamportsToSol(toT), c: "#2b47e8", label: "treasury" },
                { v: lamportsToSol(spent), c: "#ff6400", label: "spent on buyback" },
                { v: lamportsToSol(waiting), c: "#b3200e", label: "waiting in the buyback vault" },
              ]}
            />
            <dl className="mt-6 divide-y divide-char border-y border-char">
              {[
                ["SOL raised from purchases", fmtSol(raised, 2), "text-heat"],
                ["Sent to the treasury, 50%", fmtSol(toT, 2), "text-cobalt-hi"],
                ["Sent to the buyback vault, 50%", fmtSol(toB, 2), "text-heat"],
                ["Spent on buybacks so far", fmtSol(spent, 2), "text-flame"],
                ["Waiting in the vault for the next buyback", fmtSol(waiting, 2), "text-[#ff8a6a]"],
                ["Dollars raised, all payment types", fmtUsd(stats?.usdRaised ?? 0), "text-heat"],
              ].map(([k, v, c]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-[0.95rem] text-heat/85">{k}</dt>
                  <dd className={`num text-[1.05rem] ${c}`}>{v}{k.startsWith("Dollars") ? "" : " SOL"}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mt-10 font-display text-[1.2rem] font-extrabold [font-variation-settings:'wdth'_110]">Addresses</h3>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {addrs.map((a) => (
                <li key={a.label} className="border border-char p-3">
                  <p className="text-[0.9rem] font-semibold">{a.label}</p>
                  {a.value ? (
                    <a className="link-cobalt num break-all text-[0.75rem]" href={explorerAddr(a.value, CLUSTER)} target="_blank" rel="noreferrer">
                      {a.value}
                    </a>
                  ) : (
                    <p className="num text-[0.75rem] text-ash">Published at deploy</p>
                  )}
                  <p className="mt-1 text-[0.8rem] text-ash">{a.note}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* buybacks + leaderboard */}
      <section className="border-t border-char py-16 sm:py-24">
        <div className="mx-auto grid max-w-[1400px] gap-16 px-4 sm:px-6 lg:grid-cols-12">
          <div className="lg:col-span-6" aria-labelledby="bb-title">
            <h2 id="bb-title" className="font-black text-[clamp(2rem,4.4vw,3.4rem)] [font-variation-settings:'wdth'_96]">
              Buybacks
            </h2>
            <table className="mt-6 w-full text-left text-[0.9rem]">
              <caption className="sr-only">Buyback and burn transactions, newest first</caption>
              <thead className="text-[0.78rem] text-ash">
                <tr className="border-b border-char">
                  <th className="py-2 font-normal">When</th>
                  <th className="py-2 text-right font-normal">SOL in</th>
                  <th className="py-2 text-right font-normal">{BRAND.ticker} burned</th>
                  <th className="hidden py-2 text-right font-normal sm:table-cell">Avg price</th>
                  <th className="py-2 text-right font-normal">Tx</th>
                </tr>
              </thead>
              <tbody className="num divide-y divide-char text-[0.82rem]">
                {buybacks.map((b) =>
                  b.type === "buyback" ? (
                    <tr key={b.sig}>
                      <td className="py-2.5 text-ash">{timeAgo(b.ts, now)}</td>
                      <td className="py-2.5 text-right">{fmtSol(b.lamportsIn, 2)}</td>
                      <td className="py-2.5 text-right text-cone">{fmtCompact(tokensToWhole(b.tokensBurned))}</td>
                      <td className="hidden py-2.5 text-right text-ash sm:table-cell">
                        {(lamportsToSol(b.lamportsIn) / Math.max(1, tokensToWhole(b.tokensBurned))).toExponential(2)} SOL
                      </td>
                      <td className="py-2.5 text-right">
                        <a className="link-cobalt" href={explorerTx(b.sig, CLUSTER)} target="_blank" rel="noreferrer" aria-label={`Buyback transaction ${shortAddr(b.sig)}`}>
                          {shortAddr(b.sig)}
                        </a>
                      </td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
            {!pages.loading && buybacks.length === 0 && (
              <div className="border-b border-char py-8">
                <p className="text-heat/85">No buybacks yet.</p>
                <p className="mt-1 max-w-[52ch] text-[0.88rem] text-ash">
                  Half of every SOL purchase lands in the buyback vault. When it holds enough, it buys {BRAND.ticker} on the market and
                  burns it, and the transaction shows up here.
                </p>
              </div>
            )}
            {pages.next && (
              <button className="btn-line mt-5" onClick={loadMore} disabled={pages.loading}>
                {pages.loading ? "Loading…" : "Load older buybacks"}
              </button>
            )}
          </div>

          <div className="lg:col-span-6" aria-labelledby="lb-title">
            <h2 id="lb-title" className="font-black text-[clamp(2rem,4.4vw,3.4rem)] [font-variation-settings:'wdth'_96]">
              Biggest holders of the wall
            </h2>
            {board.error && <p className="mt-4 text-flame">{board.error}</p>}
            {board.data && board.data.length === 0 && (
              <div className="mt-6 border-y border-char py-8">
                <p className="flex items-baseline gap-3 text-heat/85">
                  <span className="num text-cone">1</span> The top spot is open.
                </p>
                <p className="mt-1 max-w-[46ch] text-[0.88rem] text-ash">Nobody holds any of the wall yet. Whoever buys first leads this list.</p>
                <a href="/canvas?select=1&w=1&h=1" className="btn-line mt-5">Claim the first block</a>
              </div>
            )}
            <ol className="mt-6 divide-y divide-char border-y border-char">
              {(board.data ?? []).slice(0, 15).map((r, i) => {
                const top = board.data?.[0]?.blocks ?? 1;
                return (
                  <li key={r.owner} className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 py-2.5">
                    <span className={`num text-[0.85rem] ${i < 3 ? "text-cone" : "text-ash"}`}>{i + 1}</span>
                    <div className="min-w-0">
                      <a className="num text-[0.85rem] hover:text-cobalt-hi" href={explorerAddr(r.owner, CLUSTER)} target="_blank" rel="noreferrer">
                        {shortAddr(r.owner)}
                      </a>
                      <div className="mt-1 h-1 bg-char">
                        <div className="h-full bg-flame" style={{ width: `${(r.blocks / top) * 100}%` }} />
                      </div>
                    </div>
                    <div className="num text-right text-[0.78rem]">
                      <p>{fmtInt(r.blocks)} blocks</p>
                      <p className="text-ash">{fmtCompact(tokensToWhole(r.tokensBurned))} burned</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            {USE_MOCK && <p className="mt-4 text-[0.8rem] text-ash">Demo data. Burn attribution includes each buyer&apos;s share of buybacks their SOL funded, at today&apos;s price.</p>}
          </div>
        </div>
      </section>
    </main>
  );
}

/** The firing curve before anything has burned: the axis is there, the line waits at zero. */
function EmptyCurve() {
  return (
    <figure className="relative h-[300px] sm:h-[360px]" aria-label="No burns yet: the curve starts at the first purchase">
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden>
        {[20, 40, 60, 80].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="#1c1714" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1="0" x2="100" y1="96" y2="96" stroke="#9a9087" strokeWidth="1.5" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute bottom-[4%] right-0 block h-3 w-3 -translate-y-1/2 translate-x-1/2 animate-[flicker_2s_infinite] bg-flame shadow-[0_0_18px_4px_rgba(255,100,0,.55)]" aria-hidden />
      <figcaption className="absolute left-0 top-[18%] max-w-[34ch]">
        <p className="font-display text-[clamp(1.5rem,3vw,2.2rem)] font-black leading-none [font-variation-settings:'wdth'_100]">The curve starts at zero.</p>
        <p className="mt-2 text-[0.92rem] text-ash">It climbs with the first {BRAND.ticker}-paid block and steps up with every buyback.</p>
      </figcaption>
    </figure>
  );
}
