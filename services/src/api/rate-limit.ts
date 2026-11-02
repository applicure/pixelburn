import type { Context, MiddlewareHandler } from "hono";

/** Fixed-window in-memory limiter keyed by client IP. Single-instance only (see NOTES). */
export function rateLimit(opts: { perMinute: number; key: string; clientIp: (c: Context) => string }): MiddlewareHandler {
  const hits = new Map<string, { windowStart: number; n: number }>();
  const windowMs = 60_000;
  let lastSweep = Date.now();
  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (now - v.windowStart >= windowMs) hits.delete(k);
      lastSweep = now;
    }
    const id = `${opts.key}:${opts.clientIp(c)}`;
    let e = hits.get(id);
    if (!e || now - e.windowStart >= windowMs) {
      e = { windowStart: now, n: 0 };
      hits.set(id, e);
    }
    e.n++;
    const remaining = Math.max(0, opts.perMinute - e.n);
    c.header("RateLimit-Limit", String(opts.perMinute));
    c.header("RateLimit-Remaining", String(remaining));
    if (e.n > opts.perMinute) {
      const retry = Math.ceil((e.windowStart + windowMs - now) / 1000);
      c.header("Retry-After", String(retry));
      return c.json({ error: "rate_limited", retryAfter: retry }, 429);
    }
    await next();
  };
}
