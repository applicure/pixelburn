"use client";
import { useEffect, useState } from "react";
import { isChunkLoadError } from "@/lib/skew";

/**
 * If a lazily loaded chunk fails because the site was redeployed under an open tab, offer a reload instead of
 * failing silently. No auto-reload: someone may be halfway through the purchase sheet.
 */
export function SkewGuard() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => isChunkLoadError(e.reason) && setStale(true);
    const onError = (e: ErrorEvent) => isChunkLoadError(e.error ?? { message: e.message }) && setStale(true);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
  if (!stale) return null;
  return (
    <div role="status" className="fixed inset-x-3 bottom-3 z-[90] flex flex-wrap items-center gap-3 bg-soot px-4 py-3 ring-1 ring-cone/60 sm:inset-x-auto sm:right-5 sm:max-w-md">
      <span className="block h-2 w-2 shrink-0 bg-cone" aria-hidden />
      <p className="min-w-0 flex-1 text-[0.9rem] text-heat/90">The site was just updated. Reload to get the latest version.</p>
      <button className="btn-fire !py-2 text-[0.95rem]" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
