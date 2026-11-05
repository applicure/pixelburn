"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND, SITE_URL, USE_MOCK } from "@/lib/config";
import { useBuybacksLive } from "@/lib/usePhase";
import { adPageUrl, cardImageUrl, factsFromShare, shareBody, VARIANT_COUNT, X_LIMIT, xIntentUrl, xLength, type ShareFacts } from "@/lib/share";
import { useAdShare } from "@/lib/useAdShare";
import { IconCheck, IconCopy, IconDownload, IconLink, IconShare, IconX } from "@/components/ui/icons";

function dataUrlToBlob(u: string) {
  const [head, body] = u.split(",");
  const bytes = Uint8Array.from(atob(body!), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: /:(.*?);/.exec(head!)?.[1] ?? "image/png" });
}

/**
 * The share panel. Knows nothing about how it was opened: right after a purchase it gets the buyer's local card and the on-chain
 * figures, and a returning owner gets neither and reads everything from the API.
 */
export function SharePanel({
  adId,
  signature,
  facts: given,
  localCard,
  fileStem,
  showPreview = true,
  pinned = false,
  children,
}: {
  adId: number | null;
  /** The purchase being shared. Protects against showing another ad's link if the id read went wrong. */
  signature?: string;
  /** Figures until the indexer has the ad. */
  facts?: ShareFacts | null;
  /** The buyer's own card as a data URL: it may show their unapproved image. Otherwise the public card is used. */
  localCard?: string | null;
  fileStem: string;
  showPreview?: boolean;
  /** Fill a sheet: scrolling body, with the post button always in reach. One tap should not need a scroll first. */
  pinned?: boolean;
  children?: React.ReactNode;
}) {
  const { share, gaveUp } = useAdShare(adId, signature);
  const facts = share ? factsFromShare(share) : given ?? null;
  const live = useBuybacksLive();
  const [variant, setVariant] = useState(0);
  const [edited, setEdited] = useState<string | null>(null);
  const body = edited ?? (facts ? shareBody(facts, variant, share?.cluster, live) : "");
  // Never the ad's own URL before the API confirms it exists: until then /ad/<id> is a 404, and people would post a dead link.
  const link = share ? adPageUrl(share) : gaveUp ? `${SITE_URL}/canvas` : null;
  const canPost = !!body && !!link;
  const count = xLength(body, link ?? "x");
  const over = count > X_LIMIT;

  // The file for download and native share. Fetched up front: navigator.share must run inside the tap, with no await before it.
  const version = share?.cardVersion;
  const [remote, setRemote] = useState<Blob | null>(null);
  useEffect(() => {
    if (USE_MOCK || localCard || !version || adId === null) return;
    let stop = false;
    fetch(cardImageUrl(adId, version))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => !stop && setRemote(b))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [localCard, version, adId]);
  const blob = useMemo(() => (localCard ? dataUrlToBlob(localCard) : remote), [localCard, remote]);
  const file = useMemo(() => (blob ? new File([blob], `${fileStem}.png`, { type: "image/png" }) : null), [blob, fileStem]);
  const previewUrl = useMemo(() => localCard ?? (!USE_MOCK && adId !== null && version ? cardImageUrl(adId, version) : null), [localCard, adId, version]);

  // Read after mount: the panel is client-only, but this keeps the first render and tests honest about capability.
  const [nativeShare, setNativeShare] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNativeShare(typeof navigator.share === "function");
  }, []);

  const [done, setDone] = useState<null | "text" | "link" | "error">(null);
  const clear = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (clear.current && clearTimeout(clear.current)), []);
  const flash = (d: "text" | "link" | "error") => {
    setDone(d);
    if (clear.current) clearTimeout(clear.current);
    clear.current = setTimeout(() => setDone(null), 2200);
  };
  const copy = async (value: string, what: "text" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      flash(what);
    } catch {
      flash("error");
    }
  };
  const full = link ? `${body}\n\n${link}` : body;
  const linkReady = !!share;

  const nativeSend = async () => {
    const payload: ShareData = { title: BRAND.name, text: body, ...(link ? { url: link } : {}) };
    const withFile = file && navigator.canShare?.({ ...payload, files: [file] }) ? { ...payload, files: [file] } : payload;
    try {
      await navigator.share(withFile);
    } catch (e) {
      // closing the share sheet is not an error
      if ((e as Error).name !== "AbortError") flash("error");
    }
  };

  const download = () => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileStem}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const status = share?.status;
  const postLabel = over ? "Too long for X" : !body || link ? "Post on X" : "Getting link…";
  const post = (
    <div className="flex gap-2">
      {canPost && !over ? (
        <a className="btn-fire min-w-0 flex-1 justify-center whitespace-nowrap px-3" href={xIntentUrl(body, link)} target="_blank" rel="noopener noreferrer">
          <IconX size={17} className="shrink-0" /> {postLabel}
        </a>
      ) : (
        <button type="button" className="btn-fire min-w-0 flex-1 justify-center whitespace-nowrap px-3" disabled>
          <IconX size={17} className="shrink-0" /> {postLabel}
        </button>
      )}
      {nativeShare && (
        <button type="button" aria-label="Share" className="btn-line shrink-0 justify-center px-4 disabled:opacity-50" onClick={nativeSend} disabled={!canPost}>
          <IconShare size={18} className="shrink-0" /> <span className="hidden min-[360px]:inline">Share</span>
        </button>
      )}
    </div>
  );

  const panel = (
    <section aria-label="Share your ad" className="mt-6 border-t border-char pt-5">
      <h3 className="font-display text-[1.25rem] font-extrabold leading-none [font-variation-settings:'wdth'_110]">Tell people</h3>
      {showPreview && previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={`Your ${BRAND.name} share card`} width={1200} height={630} className="mt-4 h-auto w-full ring-1 ring-char" />
      )}

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <label htmlFor="share-text" className="text-[0.9rem] font-medium">
          Your post
        </label>
        <button
          type="button"
          className="text-[0.8rem] text-ash underline decoration-char underline-offset-4 hover:text-heat"
          onClick={() => {
            setEdited(null);
            setVariant((v) => (v + 1) % VARIANT_COUNT);
          }}
        >
          Other wording
        </button>
      </div>
      <textarea
        id="share-text"
        rows={5}
        value={body}
        onChange={(e) => setEdited(e.target.value)}
        aria-describedby="share-count"
        className="mt-2 w-full resize-y border border-char bg-soot px-3 py-2.5 text-[0.95rem] leading-snug text-heat [field-sizing:content] focus:border-cone focus:outline-none"
      />
      <p className="mt-1 flex items-start justify-between gap-3 text-[0.78rem]">
        <span className="num min-w-0 break-all text-heat/80" aria-live="polite">
          {linkReady ? (
            link!.replace(/^https:\/\//, "")
          ) : gaveUp ? (
            <span className="font-[family-name:var(--font-schibsted)] text-ash">Your ad&apos;s own link isn&apos;t ready yet, so this links to the wall for now. It switches when the link is live.</span>
          ) : (
            <span className="font-[family-name:var(--font-schibsted)] text-ash">Getting your ad&apos;s link ready…</span>
          )}
        </span>
        <span id="share-count" className={`num shrink-0 ${over ? "text-flame" : "text-ash"}`}>
          {count}/{X_LIMIT}
        </span>
      </p>

      {!pinned && <div className="mt-3">{post}</div>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className="btn-line justify-center whitespace-nowrap px-2 disabled:opacity-50" onClick={() => copy(full, "text")} disabled={!body}>
          {done === "text" ? <IconCheck size={18} /> : <IconCopy size={18} />} {done === "text" ? "Copied" : "Copy text"}
        </button>
        <button type="button" className="btn-line justify-center whitespace-nowrap px-2 disabled:opacity-50" onClick={() => link && copy(link, "link")} disabled={!link}>
          {done === "link" ? <IconCheck size={18} /> : <IconLink size={18} />} {done === "link" ? "Copied" : "Copy link"}
        </button>
        <button type="button" className="btn-line col-span-2 justify-center disabled:opacity-50" onClick={download} disabled={!blob}>
          <IconDownload size={18} /> Download card
        </button>
      </div>
      <p className="sr-only" role="status">
        {done === "text" ? "Text copied" : done === "link" ? "Link copied" : ""}
      </p>
      {done === "error" && (
        <p className="mt-2 text-[0.82rem] text-flame" role="alert">
          That didn&apos;t work in this browser. You can select the text above and copy it by hand.
        </p>
      )}
      <p className="mt-3 text-[0.8rem] leading-snug text-ash">
        {status === "approved"
          ? "On X, your link shows this ad's card with your image."
          : status === "rejected"
            ? "This ad didn't pass moderation, so your link shows your spot and figures only."
            : "Until your ad is approved, your link shows a review card with your spot and figures. Your image and title appear on it after approval, though X can keep showing the old preview on a post already made."}
      </p>
    </section>
  );

  if (!pinned) return panel;
  return (
    <>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4 sm:px-7" data-lenis-prevent>
        {children}
        {panel}
      </div>
      <div className="relative shrink-0 border-t border-char bg-kiln px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-7">{post}</div>
    </>
  );
}
