"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo } from "motion/react";
import { api } from "@/lib/api";
import { mulberry32 } from "@/lib/adArt";
import { chain, TokenPaymentUnavailable, type BuyStep } from "@/lib/chain";
import { isChunkLoadError, SKEW_MESSAGE } from "@/lib/skew";
import { normTokenStatus, SLOW_EMA_HINT, tokenStatusCopy } from "@/lib/tokenStatus";
import { BRAND, QUOTE_TTL_MS, USE_MOCK } from "@/lib/config";
import { fmtInt, fmtSol, fmtTokens, fmtUsd, fmt2, explorerTx, tokensToWhole, fmtCompact } from "@/lib/format";
import type { PayMode, Rect } from "@/lib/types";
import { useQuote } from "@/lib/useQuote";
import { ImageCropper } from "./ImageCropper";
import { WalletChip, useWalletBridge } from "./Wallet";
import { renderShareCard } from "./shareCard";
import { Odometer } from "@/components/ui/Odometer";
import { IconCheck, IconClose, IconDownload, IconShare } from "@/components/ui/icons";

type Phase = "form" | "working" | "success";
const STEP_LABEL: Record<BuyStep | "upload", string> = {
  upload: "Uploading your image to Arweave",
  building: "Building the transaction",
  signing: "Approve it in your wallet",
  confirming: "Confirming on Solana",
  done: "Done",
};

/** Wallet-adapter errors often have an empty message; the real cause sits in `.error`. Never show a blank error. */
function describeError(e: unknown, fallback: string) {
  if (isChunkLoadError(e)) return SKEW_MESSAGE;
  const err = e as { message?: string; name?: string; error?: { message?: string } } | null;
  const msg = err?.message || err?.error?.message;
  if (msg && msg !== "null") return msg;
  if (err?.name === "WalletSignTransactionError" || err?.name === "WalletSendTransactionError")
    return "Your wallet didn't sign or send the transaction. Nothing was charged. Check that your wallet is on the right network and try again.";
  return fallback;
}

function validLink(s: string) {
  if (!s) return "Add the https link people land on when they click your ad.";
  if (s.length > 200) return "Links can be at most 200 characters.";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return "Links must start with https://";
    if (!u.hostname.includes(".")) return "That doesn't look like a full web address.";
  } catch {
    return "That doesn't look like a web address. Start it with https://";
  }
  return null;
}

function Countdown({ ms }: { ms: number }) {
  const r = 9, c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, ms / QUOTE_TTL_MS));
  return (
    <span className="flex items-center gap-2 text-[0.8rem] text-ash">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="-rotate-90">
        <circle cx="11" cy="11" r={r} fill="none" stroke="#1c1714" strokeWidth="2.5" />
        <circle cx="11" cy="11" r={r} fill="none" stroke="#ffc23d" strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - f)} style={{ transition: "stroke-dashoffset .25s linear" }} />
      </svg>
      <span>
        Refreshes in <span className="num text-heat">{Math.ceil(ms / 1000)}s</span>
      </span>
    </span>
  );
}

function Embers() {
  const parts = useMemo(() => {
    const r = mulberry32(7);
    return Array.from({ length: 46 }, (_, i) => ({ i, x: r() * 100, d: 0.6 + r() * 1.6, s: 3 + r() * 6, delay: r() * 0.5, drift: (r() - 0.5) * 80 }));
  }, []);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {parts.map((p) => (
        <motion.span
          key={p.i}
          className="absolute bottom-0 block"
          style={{ left: `${p.x}%`, width: p.s, height: p.s, background: p.i % 3 ? "#ff6400" : "#ffc23d" }}
          initial={{ y: 0, opacity: 1 }}
          animate={{ y: -520 - p.s * 20, x: p.drift, opacity: 0 }}
          transition={{ duration: p.d + 1, delay: p.delay, ease: [0.16, 1, 0.3, 1] }}
        />
      ))}
    </div>
  );
}

export function PurchaseSheet({ rect, open, onClose, onPurchased }: { rect: Rect | null; open: boolean; onClose(): void; onPurchased(r: Rect): void }) {
  const reduce = useReducedMotion();
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const f = () => setMobile(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  const drag = useDragControls();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 80);
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", k);
      prev?.focus?.();
    };
  }, [open, onClose]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    // project the flick (Apple's decay projection) and dismiss if it would land past a third
    const projected = info.offset.y + ((info.velocity.y / 1000) * 0.998) / (1 - 0.998);
    if (projected > (panel.current?.offsetHeight ?? 600) / 3) onClose();
  };

  return (
    <AnimatePresence>
      {open && rect && (
        <>
          <motion.div
            className="fixed inset-0 z-[60] bg-soot/50 md:bg-soot/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sheet-title"
            className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[calc(100svh-4rem)] flex-col overflow-hidden rounded-t-[20px] bg-kiln shadow-[0_-30px_80px_-20px_rgba(0,0,0,.9)] ring-1 ring-char md:bottom-0 md:left-auto md:right-0 md:top-14 md:max-h-none md:w-[460px] md:rounded-none"
            initial={reduce ? { opacity: 0 } : mobile ? { y: "100%" } : { x: "100%" }}
            animate={reduce ? { opacity: 1 } : mobile ? { y: 0 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : mobile ? { y: "100%" } : { x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 320, mass: 0.9 }}
            drag={mobile && !reduce ? "y" : false}
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.05, bottom: 0.9 }}
            onDragEnd={onDragEnd}
          >
            {mobile && (
              <div className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-3" onPointerDown={(e) => drag.start(e)} aria-hidden>
                <span className="block h-1.5 w-12 rounded-full bg-char" />
              </div>
            )}
            <SheetBody key={`${rect.x}-${rect.y}-${rect.w}-${rect.h}`} rect={rect} onClose={onClose} onPurchased={onPurchased} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function SheetBody({ rect, onClose, onPurchased }: { rect: Rect; onClose(): void; onPurchased(r: Rect): void }) {
  const wallet = useWalletBridge();
  const [chosen, setMode] = useState<PayMode>("sol");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("https://");
  const [touched, setTouched] = useState({ title: false, link: false });
  const [phase, setPhase] = useState<Phase>("form");
  const [step, setStep] = useState<BuyStep | "upload">("upload");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sig: string; burned: bigint; card: string | null } | null>(null);
  // the SOL quote always runs: it carries the $PXL payment status for this exact size
  const solQ = useQuote(rect.w, rect.h, "sol", phase === "form");
  const tokenStatus = normTokenStatus(solQ.quote?.tokenPaymentStatus);
  const tokenOk = tokenStatus === "ok";
  const mode: PayMode = chosen === "token" && tokenOk ? "token" : "sol";
  const tokQ = useQuote(rect.w, rect.h, "token", phase === "form" && tokenOk && chosen === "token");
  const { quote, msLeft, error: quoteErr } = mode === "sol" ? solQ : tokQ;
  const tokenNote = tokenStatusCopy(tokenStatus, rect.w * rect.h, solQ.quote?.tokenBlocksAvailable ?? null);
  const slowEma = mode === "token" && (tokQ.quote?.tokenPricedBy ?? solQ.quote?.tokenPricedBy) === "slow_ema";
  const usd = rect.w * rect.h * 100;
  const linkErr = validLink(link === "https://" ? "" : link);
  const titleErr = !title.trim() ? "Give your ad a title. It shows when people hover." : null;
  const ready = !!blob && !linkErr && !titleErr && !!wallet.address && !!quote;

  const submit = async () => {
    setTouched({ title: true, link: true });
    if (!ready || !blob || !quote) return;
    setError(null);
    setPhase("working");
    try {
      setStep("upload");
      const up = await api.upload(blob, rect.w, rect.h);
      const res = await chain.buy(
        {
          owner: wallet.address!,
          rect,
          title: title.trim(),
          link,
          imageUri: up.uri,
          imageSha256: up.sha256,
          payMode: mode,
          maxLamports: quote.lamports ? (BigInt(quote.lamports) * 101n) / 100n : undefined,
          maxTokens: quote.tokens ? (BigInt(quote.tokens) * 101n) / 100n : undefined,
          previewUrl: dataUrl ?? up.previewUrl,
        },
        wallet.signer,
        wallet.connection,
        setStep,
      );
      // SOL buys burn later via buyback: estimate half the payment at the quoted token price
      const burned = res.tokensBurned || (mode === "sol" ? BigInt(Math.round((usd / 2 / Math.max(1e-12, quote.tokenPriceUsd)) * 1e6)) : 0n);
      const card = await renderShareCard({
        image: dataUrl,
        burned: fmtCompact(tokensToWhole(burned)),
        ...rect,
        title: title.trim(),
        tokenMode: mode === "token",
      });
      setResult({ sig: res.signature, burned, card });
      setPhase("success");
      onPurchased(rect);
    } catch (e) {
      if (e instanceof TokenPaymentUnavailable) setMode("sol");
      setError(describeError(e, "The purchase did not go through. Nothing was charged."));
      setPhase("form");
    }
  };

  if (phase === "success" && result) {
    const shareText = `My ad on ${BRAND.name} burned ${fmtCompact(tokensToWhole(result.burned))} ${BRAND.ticker}.`;
    return (
      <div className="relative flex-1 overflow-y-auto px-5 pb-8 pt-4 sm:px-7" data-lenis-prevent>
        <Embers />
        <div className="flex justify-end">
          <button className="grid h-10 w-10 place-items-center text-ash hover:text-heat" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <span className="grid h-12 w-12 place-items-center bg-cone text-soot" aria-hidden>
          <IconCheck size={26} />
        </span>
        <h2 id="sheet-title" className="mt-5 font-display text-[2.6rem] font-black leading-[0.9] [font-variation-settings:'wdth'_120]" data-autofocus tabIndex={-1}>
          You&apos;re on the billboard.
        </h2>
        <p className="mt-3 text-heat/85">
          {mode === "token" ? (
            <>
              Your payment burned <span className="num text-cone">{fmtTokens(result.burned)}</span> {BRAND.ticker} in the same transaction.
            </>
          ) : (
            <>
              Half your SOL is in the buyback vault. At today&apos;s price it will burn about{" "}
              <span className="num text-cone">{fmtTokens(result.burned)}</span> {BRAND.ticker}.
            </>
          )}{" "}
          Your ad shows once it passes moderation.
        </p>
        <p className="mt-6 text-[clamp(2.4rem,9vw,3.4rem)] leading-none text-cone">
          <Odometer value={fmtInt(Math.round(tokensToWhole(result.burned)))} />
        </p>
        <p className="mt-1 text-[0.85rem] text-ash">{BRAND.ticker} {mode === "token" ? "burned" : "to be burned"}</p>
        {result.card && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.card} alt={shareText} className="mt-7 w-full ring-1 ring-char" />
        )}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <a className="btn-fire justify-center" href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">
            <IconShare size={18} /> Share on X
          </a>
          {result.card && (
            <a className="btn-line justify-center" href={result.card} download={`pixel-frame-${rect.x}-${rect.y}.png`}>
              <IconDownload size={18} /> Save card
            </a>
          )}
        </div>
        <p className="mt-5 text-[0.82rem] text-ash">
          {USE_MOCK ? "Demo purchase, nothing was sent on-chain." : <a className="link-cobalt" href={explorerTx(result.sig)} target="_blank" rel="noreferrer">View the transaction</a>}
        </p>
      </div>
    );
  }

  const working = phase === "working";
  const steps: (BuyStep | "upload")[] = ["upload", "building", "signing", "confirming"];

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-3 sm:px-7 md:pt-6">
        <div>
          <h2 id="sheet-title" className="font-display text-[2rem] font-black leading-[0.95] [font-variation-settings:'wdth'_115]">
            Buy {rect.w}×{rect.h} blocks
          </h2>
          <p className="num mt-1 text-[0.7rem] text-ash sm:text-[0.78rem]">
            Position {rect.x}, {rect.y} · {fmtInt(rect.w * rect.h * 100)} px · {fmtUsd(usd)}
          </p>
        </div>
        <button className="grid h-10 w-10 shrink-0 place-items-center text-ash hover:text-heat" onClick={onClose} aria-label="Close" data-autofocus>
          <IconClose />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 pb-6 pt-5 sm:px-7" data-lenis-prevent>
        <fieldset disabled={working} className="min-w-0 space-y-6">
          <div>
            <p className="mb-2 text-[0.9rem] font-medium">Image</p>
            <ImageCropper
              w={rect.w}
              h={rect.h}
              onChange={(b, d) => {
                setBlob(b);
                setDataUrl(d);
              }}
            />
          </div>
          <div>
            <label htmlFor="ad-title" className="flex justify-between text-[0.9rem] font-medium">
              Title <span className="num text-[0.75rem] font-normal text-ash">{title.length}/64</span>
            </label>
            <input
              id="ad-title"
              value={title}
              maxLength={64}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, title: true }))}
              aria-invalid={touched.title && !!titleErr}
              aria-describedby="ad-title-err"
              placeholder="What people see on hover"
              className="mt-2 w-full border border-char bg-soot px-3 py-3 text-heat placeholder:text-ash/70 focus:border-cone focus:outline-none"
            />
            {touched.title && titleErr && <p id="ad-title-err" className="mt-1.5 text-[0.82rem] text-flame">{titleErr}</p>}
          </div>
          <div>
            <label htmlFor="ad-link" className="text-[0.9rem] font-medium">
              Link
            </label>
            <input
              id="ad-link"
              type="url"
              inputMode="url"
              value={link}
              maxLength={200}
              onChange={(e) => setLink(e.target.value.trim())}
              onBlur={() => setTouched((t) => ({ ...t, link: true }))}
              aria-invalid={touched.link && !!linkErr}
              aria-describedby="ad-link-err"
              className="num mt-2 w-full border border-char bg-soot px-3 py-3 text-[0.85rem] text-heat focus:border-cone focus:outline-none"
            />
            {touched.link && linkErr && <p id="ad-link-err" className="mt-1.5 text-[0.82rem] text-flame">{linkErr}</p>}
          </div>

          <details className="group border-t border-char pt-4">
            <summary className="cursor-pointer list-none text-[0.9rem] font-medium marker:hidden">
              How this price is made <span className="text-ash group-open:hidden">(show)</span>
            </summary>
            <dl className="num mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-[0.75rem] text-ash">
              <dt>{fmtInt(rect.w * rect.h * 100)} px at $1</dt>
              <dd className="text-heat/85">{fmtUsd(usd)}</dd>
              {mode === "token" ? (
                <>
                  <dt>10% off for paying in {BRAND.ticker}</dt>
                  <dd className="text-cone">−{fmtUsd(usd * 0.1)}</dd>
                  <dt>{BRAND.ticker} price, lowest of spot and averages</dt>
                  <dd className="text-heat/85">${(quote?.tokenPriceUsd ?? 0).toFixed(6)}</dd>
                </>
              ) : (
                <>
                  <dt>SOL price, Pyth oracle</dt>
                  <dd className="text-heat/85">${fmt2(quote?.solPriceUsd ?? 0)}</dd>
                </>
              )}
            </dl>
            <p className="mt-3 text-[0.82rem] text-heat/80">
              {mode === "sol"
                ? "Half goes to the treasury. Half goes to the buyback vault, which buys and burns."
                : `Every ${BRAND.ticker} you pay is burned in this transaction.`}
            </p>
          </details>
        </fieldset>
      </div>

      <div className="shrink-0 border-t border-char bg-kiln px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-7">
        {working ? (
          <ol className="space-y-2" aria-live="assertive">
            {steps.map((s) => {
              const i = steps.indexOf(s), cur = steps.indexOf(step as BuyStep);
              const state = step === "done" || i < cur ? "done" : i === cur ? "now" : "todo";
              return (
                <li key={s} className={`flex items-center gap-3 text-[0.92rem] ${state === "todo" ? "text-ash/60" : "text-heat"}`}>
                  <span className={`grid h-5 w-5 place-items-center ${state === "done" ? "bg-cone text-soot" : state === "now" ? "bg-flame" : "border border-char"}`} aria-hidden>
                    {state === "done" ? <IconCheck size={14} /> : state === "now" ? <span className="block h-2 w-2 animate-pulse bg-soot" /> : null}
                  </span>
                  {STEP_LABEL[s]}
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="space-y-3">
            <div role="radiogroup" aria-label="Pay with" className="relative grid grid-cols-2 border border-char p-0.5">
              {(["sol", "token"] as PayMode[]).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={mode === m}
                  disabled={m === "token" && !tokenOk}
                  aria-describedby={m === "token" && tokenNote ? "token-note" : undefined}
                  onClick={() => setMode(m)}
                  className={`relative z-10 py-2 text-[0.9rem] font-semibold transition-colors disabled:cursor-not-allowed disabled:text-ash/50 disabled:line-through disabled:decoration-1 ${mode === m ? "text-soot" : "text-ash hover:text-heat"}`}
                >
                  {mode === m && <motion.span layoutId="paymode" className="absolute inset-0 -z-10 bg-flame" transition={{ type: "spring", bounce: 0.15, duration: 0.4 }} />}
                  {m === "sol" ? "Pay in SOL" : `${BRAND.ticker}, 10% off`}
                </button>
              ))}
            </div>
            {tokenNote && (
              <div id="token-note" role="status" className="flex gap-2.5 bg-soot px-3 py-2.5 text-[0.8rem] leading-snug ring-1 ring-char">
                <span className="mt-1 block h-2 w-2 shrink-0 bg-cone" aria-hidden />
                <p>
                  <span className="font-semibold text-heat">{tokenNote.title}.</span> <span className="text-heat/75">{tokenNote.body}</span>
                </p>
              </div>
            )}
            {slowEma && (
              <p className="flex gap-2.5 text-[0.78rem] leading-snug text-heat/75" role="note">
                <span className="mt-1 block h-2 w-2 shrink-0 border border-cone" aria-hidden />
                {SLOW_EMA_HINT}
              </p>
            )}
            <div className="flex items-end justify-between gap-3" aria-live="polite">
              <div className="min-w-0">
                <p className="num text-[0.72rem] text-ash">
                  You pay {fmtUsd(mode === "token" ? usd * 0.9 : usd)}
                  {mode === "token" && <span className="text-cone"> (save {fmtUsd(usd * 0.1)})</span>}
                </p>
                <p className="mt-1 text-[1.85rem] leading-none text-heat">
                  {mode === "sol" ? (
                    <>
                      <Odometer value={quote?.lamports ? fmtSol(quote.lamports, 4) : "0.0000"} />
                      <span className="ml-1.5 text-[0.85rem] text-ash">SOL</span>
                    </>
                  ) : (
                    <>
                      <Odometer value={quote?.tokens ? fmtTokens(quote.tokens) : "0"} className="text-cone" />
                      <span className="ml-1.5 text-[0.85rem] text-ash">{BRAND.ticker}</span>
                    </>
                  )}
                </p>
              </div>
              {quote && <Countdown ms={msLeft} />}
            </div>
            {quoteErr && <p className="text-[0.82rem] text-flame">{quoteErr}</p>}
            {error && (
              <p className="border border-cherry bg-cherry/20 px-3 py-2 text-[0.85rem]" role="alert">
                {error}
              </p>
            )}
            <WalletChip />
            <button className="btn-fire w-full justify-center text-[1.02rem] sm:text-lg" onClick={submit} disabled={!wallet.address || !quote}>
              {mode === "sol" ? `Buy for ${quote?.lamports ? fmtSol(quote.lamports, 3) : "…"} SOL` : `Burn ${quote?.tokens ? fmtCompact(tokensToWhole(quote.tokens)) : "…"} ${BRAND.ticker} and buy`}
            </button>
            {!blob && wallet.address && <p className="text-center text-[0.8rem] text-ash">Add an image to continue.</p>}
          </div>
        )}
      </div>
    </>
  );
}
