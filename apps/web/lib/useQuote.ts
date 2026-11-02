"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { PayMode, Quote } from "./types";

/**
 * Binding quote from /api/quote that refreshes when it expires. Debounced (selection drags
 * change w/h quickly), keeps the last good quote on errors, and backs off on 429.
 */
export function useQuote(w: number, h: number, mode: PayMode, enabled = true, autoRefresh = true) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [retryAt, setRetryAt] = useState(0);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || w < 1 || h < 1) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const q = await api.getQuote(w, h, mode);
      if (id === seq.current) {
        setQuote(q);
        setError(null);
      }
    } catch (e) {
      if (id !== seq.current) return;
      const status = (e as { status?: number }).status;
      if (status === 429) {
        setRetryAt(Date.now() + 6000);
        setError((prev) => prev ?? "Prices are busy, retrying in a few seconds.");
      } else setError(e instanceof Error ? e.message : "Quote unavailable");
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [w, h, mode, enabled]);

  // debounce size/mode changes
  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [enabled]);

  // refresh at expiry (when asked to), or after a 429 backoff
  useEffect(() => {
    const at = Math.max(retryAt, autoRefresh ? quote?.expiresAt ?? 0 : 0);
    if (!at) return;
    const t = setTimeout(refresh, Math.max(0, at - Date.now()));
    return () => clearTimeout(t);
  }, [quote, retryAt, refresh, autoRefresh]);

  const msLeft = quote ? Math.max(0, quote.expiresAt - now) : 0;
  return { quote, error, loading, msLeft, refresh };
}
