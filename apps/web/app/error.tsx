"use client";
import Link from "next/link";
import { isChunkLoadError } from "@/lib/skew";

/** Route-level error boundary: keeps the nav, explains what happened, offers the right recovery. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const skew = isChunkLoadError(error);
  return (
    <main id="main" className="grid min-h-[100svh] place-items-center px-4 pt-14">
      <div className="max-w-xl">
        <p className="num text-cone">{skew ? "Updated" : "Error"}</p>
        <h1 className="mt-3 font-black text-[clamp(2.4rem,8vw,5rem)] [font-variation-settings:'wdth'_110]">
          {skew ? "A new version just went live." : "This part of the page broke."}
        </h1>
        <p className="mt-4 text-heat/80">
          {skew
            ? "The site was updated while this tab was open, so a piece of it couldn't load. Reload to get the latest version. Nothing was bought or charged."
            : "Something failed while showing this page. Try again; if it keeps happening, reload. Nothing was bought or charged."}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <button className="btn-fire" onClick={() => (skew ? window.location.reload() : reset())}>
            {skew ? "Reload" : "Try again"}
          </button>
          <Link href="/" className="btn-line">
            Back to the billboard
          </Link>
        </div>
        {error.digest && <p className="num mt-6 text-[0.75rem] text-ash">ref {error.digest}</p>}
      </div>
    </main>
  );
}
