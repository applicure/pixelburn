"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { AdShare } from "./types";

/** How long a buyer waits on the indexer before being offered the site link instead of the ad's own. */
const PATIENCE_MS = 45_000;

/**
 * Follows one ad through the indexer and moderation. A purchase confirms before the indexer has seen it, and until it has,
 * /ad/<id> is a 404: so nothing may offer that link while this returns share = null.
 * `signature` guards against reading the wrong ad: the id came from a separate read, and an ad of another tx is not this purchase.
 */
export function useAdShare(adId: number | null, signature?: string) {
  const [share, setShare] = useState<AdShare | null>(null);
  const [gaveUp, setGaveUp] = useState(adId === null);

  useEffect(() => {
    if (adId === null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    let found = false;
    const started = Date.now();
    const tick = async () => {
      attempt++;
      try {
        const s = await api.getAdShare(adId);
        if (stop) return;
        if (s && (!signature || s.signature === signature)) {
          found = true;
          setShare(s);
          setGaveUp(false);
        } else if (Date.now() - started > PATIENCE_MS) setGaveUp(true);
      } catch {
        if (!stop && Date.now() - started > PATIENCE_MS) setGaveUp(true);
      }
      if (stop) return;
      // quick while waiting for the indexer; then slowly, to pick up approval while the panel is open
      timer = setTimeout(tick, found ? 30_000 : Math.min(8000, 1000 + attempt * 1000));
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [adId, signature]);

  return { share, gaveUp };
}
