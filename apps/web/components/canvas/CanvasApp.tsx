"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BRAND, GRID } from "@/lib/config";
import { useLaunchState } from "@/lib/launchState";
import { fmtCompact, fmtInt, fmtSol, fmtUsd, tokensToWhole } from "@/lib/format";
import { bitGet, isRectFree } from "@/lib/quote";
import { onLiveEvent, useLive } from "@/lib/store";
import type { Ad, Rect } from "@/lib/types";
import { useQuote } from "@/lib/useQuote";
import { normTokenStatus } from "@/lib/tokenStatus";
import { Viewport, type ViewportHandle, type View } from "./Viewport";
import { Minimap, type MinimapHandle } from "./Minimap";
import { AdTooltip } from "./AdTooltip";
import { LeaveConfirm } from "./LeaveConfirm";
import { PurchaseSheet } from "./PurchaseSheet";
import { useWalletBridge, WalletLayer } from "./Wallet";
import { IconHand, IconMap, IconMinus, IconPlus, IconSelect } from "@/components/ui/icons";

function findFree(occ: Uint8Array, w: number, h: number): Rect | null {
  // spiral-ish search from the centre outward so the suggestion is somewhere visible
  const cands: Rect[] = [];
  for (let y = 0; y + h <= GRID; y++) for (let x = 0; x + w <= GRID; x++) cands.push({ x, y, w, h });
  cands.sort((a, b) => Math.hypot(a.x + w / 2 - 50, a.y + h / 2 - 50) - Math.hypot(b.x + w / 2 - 50, b.y + h / 2 - 50));
  return cands.find((r) => isRectFree(occ, r)) ?? null;
}

function SelectionBar({ sel, onBuy, onClear }: { sel: Rect; onBuy(): void; onClear(): void }) {
  const occ = useLive((s) => s.occupancy);
  const free = isRectFree(occ, sel);
  const sol = useQuote(sel.w, sel.h, "sol", free);
  const tokenOk = normTokenStatus(sol.quote?.tokenPaymentStatus) === "ok";
  const tok = useQuote(sel.w, sel.h, "token", free && tokenOk);
  const usd = sel.w * sel.h * 100;
  const launching = useLaunchState() === "soon";
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-soot/90 p-3 pl-4 shadow-[0_20px_60px_-10px_rgba(0,0,0,.9)] ring-1 ring-char backdrop-blur-md sm:flex-nowrap">
      <div className="min-w-0">
        <p className="font-display text-[1.3rem] font-black leading-none [font-variation-settings:'wdth'_115]">
          {sel.w}×{sel.h} <span className="text-[0.95rem] font-semibold text-ash">blocks</span>
        </p>
        <p className="num mt-1 text-[0.7rem] text-ash">
          Position {sel.x}, {sel.y} · {fmtInt(sel.w * sel.h * 100)} px
        </p>
      </div>
      {free ? (
        <dl className="num grid grid-cols-3 gap-x-5 text-[0.95rem]">
          <div>
            <dt className="text-[0.66rem] text-ash">USD</dt>
            <dd>{fmtUsd(usd)}</dd>
          </div>
          <div>
            <dt className="text-[0.66rem] text-cobalt-hi">SOL</dt>
            <dd>{sol.quote?.lamports ? fmtSol(sol.quote.lamports, 3) : "…"}</dd>
          </div>
          <div>
            <dt className="text-[0.66rem] text-flame">{BRAND.ticker} −10%</dt>
            <dd className={tokenOk ? "text-cone" : "text-ash"}>
              {!tokenOk ? (sol.quote ? "SOL only now" : "…") : tok.quote?.tokens ? fmtCompact(tokensToWhole(tok.quote.tokens)) : "…"}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-[0.92rem] text-flame" role="alert">
          Part of this is already sold. Drag over free blocks only.
        </p>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button className="px-3 py-2 text-[0.9rem] text-ash hover:text-heat" onClick={onClear}>
          Clear
        </button>
        <button className="btn-fire" onClick={onBuy} disabled={!free || launching}>
          {launching ? "Opens at launch" : "Buy these blocks"}
        </button>
      </div>
    </div>
  );
}

function Inner() {
  const params = useSearchParams();
  const reduce = useReducedMotion() ?? false;
  const ads = useLive((s) => s.ads);
  const occupancy = useLive((s) => s.occupancy);
  const canvasVersion = useLive((s) => s.canvasVersion);
  const stats = useLive((s) => s.stats);
  const ready = useLive((s) => s.ready);
  const [mode, setMode] = useState<"explore" | "select">(params.get("select") ? "select" : "explore");
  const [sel, setSel] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ ad: Ad | null; x: number; y: number }>({ ad: null, x: 0, y: 0 });
  const [leaving, setLeaving] = useState<Ad | null>(null);
  const [sheet, setSheet] = useState(false);
  const [sheetRect, setSheetRect] = useState<Rect | null>(null);
  const openSheet = (r: Rect) => {
    setSheetRect({ ...r });
    setSheet(true);
  };
  const [flash, setFlash] = useState<Rect | null>(null);
  const [zoom, setZoom] = useState(1);
  const [mini, setMini] = useState(true);
  const [status, setStatus] = useState("");
  const vp = useRef<ViewportHandle>(null);
  const mm = useRef<MinimapHandle>(null);
  const sizedFromUrl = useRef(false);
  const wallet = useWalletBridge();
  // /canvas?spot=x,y,w,h from an ad page: where that ad sits, approved or not
  const spot = useMemo<Rect | null>(() => {
    const m = /^(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})$/.exec(params.get("spot") ?? "");
    if (!m) return null;
    const [x, y, w, h] = m.slice(1).map(Number) as [number, number, number, number];
    return w >= 1 && h >= 1 && x + w <= GRID && y + h <= GRID ? { x, y, w, h } : null;
  }, [params]);
  useEffect(() => {
    if (!spot || !ready) return;
    const t = setTimeout(() => {
      const v = vp.current;
      if (!v) return;
      const { w, h } = v.size();
      // big enough to find, without zooming a large ad past the screen
      const s = Math.max(v.getView().s, Math.min(8, (0.35 * Math.min(w, h)) / (Math.max(spot.w, spot.h) * 10)));
      v.centerOn(spot.x + spot.w / 2, spot.y + spot.h / 2, s);
    }, 200);
    return () => clearTimeout(t);
  }, [spot, ready]);

  // ?w=&h= from the landing converter: preselect a free spot of that size
  useEffect(() => {
    if (sizedFromUrl.current || !ready) return;
    const w = Number(params.get("w")), h = Number(params.get("h"));
    sizedFromUrl.current = true;
    if (w >= 1 && h >= 1 && w <= GRID && h <= GRID) {
      const r = findFree(occupancy, w, h);
      if (r) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSel(r);
        setMode("select");
        setTimeout(() => vp.current?.centerOn(r.x + r.w / 2, r.y + r.h / 2, Math.max(vp.current.getView().s, 2.4)), 200);
      }
    }
  }, [ready, occupancy, params]);

  useEffect(
    () =>
      onLiveEvent((f) => {
        if (f.type !== "purchase") return;
        setFlash({ x: f.x, y: f.y, w: f.w, h: f.h });
        setStatus(`${f.title} just bought ${f.w} by ${f.h} blocks at ${f.x}, ${f.y}.`);
      }),
    [],
  );

  const onView = useCallback((v: View, w: number, h: number) => {
    mm.current?.draw(v, w, h);
    setZoom((z) => (Math.abs(z - v.s) > 0.01 ? v.s : z));
  }, []);

  const onSelect = useCallback((r: Rect | null, done: boolean) => {
    setSel(r);
    if (done && r) {
      setCursor(null);
    }
  }, []);

  const onHover = useCallback((ad: Ad | null, x: number, y: number) => setHover({ ad, x, y }), []);
  const onActivate = useCallback((ad: Ad) => setLeaving(ad), []);
  const jump = useCallback((bx: number, by: number) => vp.current?.centerOn(bx, by), []);

  const describe = useCallback(
    (c: { x: number; y: number }, r: Rect | null) => {
      if (r && (r.w > 1 || r.h > 1)) return `Selection ${r.w} by ${r.h} at ${r.x}, ${r.y}, ${fmtUsd(r.w * r.h * 100)}, ${isRectFree(occupancy, r) ? "free" : "overlaps sold blocks"}.`;
      const sold = bitGet(occupancy, c.y * GRID + c.x);
      const ad = ads.find((a) => c.x >= a.x && c.x < a.x + a.w && c.y >= a.y && c.y < a.y + a.h);
      return `Block ${c.x}, ${c.y}: ${ad ? `${ad.title}, links to ${ad.link}` : sold ? "sold, awaiting moderation" : "free, $100"}.`;
    },
    [ads, occupancy],
  );

  // keyboard: arrows move a block cursor, shift grows the selection
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "CANVAS") return;
    const k = e.key;
    if (k === "+" || k === "=") return vp.current?.zoomBy(1.5);
    if (k === "-" || k === "_") return vp.current?.zoomBy(1 / 1.5);
    if (k === "0") return vp.current?.fit();
    if (k === "s" || k === "S") {
      setMode((m) => (m === "explore" ? "select" : "explore"));
      return;
    }
    if (k === "Escape") {
      setSel(null);
      return;
    }
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (d[k]) {
      e.preventDefault();
      const c = cursor ?? { x: 50, y: 50 };
      if (e.shiftKey) {
        const base = sel ?? { x: c.x, y: c.y, w: 1, h: 1 };
        const nr = {
          ...base,
          w: Math.max(1, Math.min(GRID - base.x, base.w + d[k][0])),
          h: Math.max(1, Math.min(GRID - base.y, base.h + d[k][1])),
        };
        setMode("select");
        setSel(nr);
        setStatus(describe(c, nr));
        return;
      }
      const n = { x: Math.max(0, Math.min(GRID - 1, c.x + d[k][0])), y: Math.max(0, Math.min(GRID - 1, c.y + d[k][1])) };
      setCursor(n);
      if (mode === "select") setSel({ x: n.x, y: n.y, w: sel?.w ?? 1, h: sel?.h ?? 1 });
      vp.current?.centerOn(n.x, n.y, Math.max(vp.current.getView().s, 2));
      setStatus(describe(n, mode === "select" ? { x: n.x, y: n.y, w: sel?.w ?? 1, h: sel?.h ?? 1 } : null));
      return;
    }
    if (k === "Enter") {
      if (sel && isRectFree(occupancy, sel)) openSheet(sel);
      else if (cursor) {
        const ad = ads.find((a) => cursor.x >= a.x && cursor.x < a.x + a.w && cursor.y >= a.y && cursor.y < a.y + a.h);
        if (ad) setLeaving(ad);
      }
    }
  };

  const pct = stats ? (stats.soldBlocks / stats.totalBlocks) * 100 : 0;
  const closeSheet = useCallback(() => setSheet(false), []);
  const closeLeave = useCallback(() => setLeaving(null), []);
  const onPurchased = useCallback((r: Rect) => {
    setSel(null);
    setFlash({ ...r });
  }, []);

  const hint = useMemo(
    () =>
      mode === "select"
        ? "Drag across free blocks to select. Two fingers or space-drag to pan."
        : "Drag to pan, scroll or pinch to zoom, click an ad to visit it.",
    [mode],
  );

  return (
    <div className="fixed inset-0 overflow-hidden bg-kiln" onKeyDown={onKey}>
      <h1 className="sr-only">The billboard, 1000 by 1000 pixels</h1>
      <Viewport
        ref={vp}
        mode={mode}
        ads={ads}
        occupancy={occupancy}
        canvasVersion={canvasVersion}
        selection={sel}
        cursor={cursor}
        flash={flash}
        spot={spot}
        onSelect={onSelect}
        onHover={onHover}
        onActivate={onActivate}
        onView={onView}
        reduceMotion={reduce}
      />
      <p id="canvas-status" className="sr-only" aria-live="polite">
        {status}
      </p>

      {/* mode switch */}
      <div className="absolute left-3 top-[4.25rem] flex items-center gap-3 sm:left-5">
        <div role="radiogroup" aria-label="Canvas mode" className="relative flex bg-soot/85 p-1 ring-1 ring-char backdrop-blur-md">
          {([
            ["explore", "Explore", IconHand],
            ["select", "Select blocks", IconSelect],
          ] as const).map(([m, label, Icon]) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                if (m === "explore") setSel(null);
              }}
              className={`relative z-10 flex items-center gap-2 px-3 py-2 text-[0.9rem] font-medium transition-colors ${mode === m ? "text-soot" : "text-ash hover:text-heat"}`}
            >
              {mode === m && <motion.span layoutId="mode" className="absolute inset-0 -z-10 bg-heat" transition={{ type: "spring", bounce: 0, duration: 0.35 }} />}
              <Icon size={18} />
              <span className={m === "select" ? "" : "hidden sm:inline"}>{label}</span>
            </button>
          ))}
        </div>
        <p className="hidden bg-soot/70 px-2 py-1 text-[0.82rem] text-ash backdrop-blur lg:block">{hint}</p>
      </div>

      {/* stats + zoom */}
      <div className="absolute right-3 top-[4.25rem] flex flex-col items-end gap-2 sm:right-5">
        <div className="bg-soot/85 px-3 py-2 text-right ring-1 ring-char backdrop-blur-md">
          <p className="num text-[0.95rem] leading-none">{pct === 0 ? "0" : `${pct.toFixed(2)}%`}</p>
          <p className="mt-1 text-[0.7rem] text-ash">{pct === 0 ? "sold yet" : "sold"}</p>
        </div>
        <div className="flex flex-col bg-soot/85 ring-1 ring-char backdrop-blur-md">
          <button className="grid h-10 w-10 place-items-center hover:bg-char" onClick={() => vp.current?.zoomBy(1.6)} aria-label="Zoom in">
            <IconPlus size={18} />
          </button>
          <button className="num h-8 w-10 text-[0.65rem] text-ash hover:text-heat" onClick={() => vp.current?.fit()} aria-label="Fit the whole billboard">
            {Math.round(zoom * 100)}%
          </button>
          <button className="grid h-10 w-10 place-items-center hover:bg-char" onClick={() => vp.current?.zoomBy(1 / 1.6)} aria-label="Zoom out">
            <IconMinus size={18} />
          </button>
        </div>
      </div>

      {/* minimap */}
      <div className="absolute bottom-3 left-3 sm:bottom-5 sm:left-5">
        <button
          className="mb-2 flex items-center gap-2 bg-soot/85 px-2.5 py-1.5 text-[0.78rem] text-ash ring-1 ring-char hover:text-heat"
          onClick={() => setMini((m) => !m)}
          aria-expanded={mini}
        >
          <IconMap size={16} /> {mini ? "Hide map" : "Map"}
        </button>
        <AnimatePresence initial={false}>
          {mini && (
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, originX: 0, originY: 1 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              className="bg-soot p-1.5 ring-1 ring-char"
            >
              <Minimap ref={mm} onJump={jump} size={typeof window !== "undefined" && window.innerWidth < 640 ? 92 : 148} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* selection bar */}
      <AnimatePresence>
        {sel && !sheet && (
          <motion.div
            className="absolute bottom-3 left-3 right-3 sm:bottom-5 sm:left-auto sm:right-5 sm:w-auto"
            initial={reduce ? { opacity: 0 } : { y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 30, opacity: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.35 }}
          >
            <SelectionBar sel={sel} onBuy={() => openSheet(sel)} onClear={() => setSel(null)} />
          </motion.div>
        )}
      </AnimatePresence>
      {stats && stats.soldBlocks === 0 && !sel && !sheet && (
        <div className="pointer-events-none absolute left-3 right-[4.75rem] top-[8.25rem] bg-soot/90 px-4 py-3 ring-1 ring-cone/50 backdrop-blur-md sm:left-1/2 sm:right-auto sm:top-[5rem] sm:w-[26rem] sm:-translate-x-1/2 sm:text-center">
          <p className="font-display text-[1.15rem] font-extrabold leading-tight [font-variation-settings:'wdth'_110]">Every block is open.</p>
          <p className="mt-1 text-[0.85rem] text-heat/80">Nobody has bought yet. Pick any spot: the first ad on the wall is yours for $100 a block.</p>
        </div>
      )}
      {mode === "select" && !sel && (
        <p className="pointer-events-none absolute bottom-5 right-5 hidden max-w-xs bg-soot/85 px-3 py-2 text-[0.85rem] text-heat/85 ring-1 ring-char sm:block">
          {hint}
        </p>
      )}

      <AdTooltip ad={sheet || leaving ? null : hover.ad} x={hover.x} y={hover.y} mine={!!wallet.address && hover.ad?.owner === wallet.address} />
      <LeaveConfirm ad={leaving} onClose={closeLeave} mine={!!wallet.address && leaving?.owner === wallet.address} />
      <PurchaseSheet rect={sheetRect} open={sheet} onClose={closeSheet} onPurchased={onPurchased} />
    </div>
  );
}

export function CanvasApp() {
  return (
    <WalletLayer>
      <Inner />
    </WalletLayer>
  );
}
