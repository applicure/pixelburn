/**
 * Same-origin Solana JSON-RPC proxy. The upstream URL (SOLANA_RPC, may carry an API key)
 * stays on the server. Guards: same-origin only, one call per request (no batches),
 * method allow-list, 32 KB body cap, per-IP rate limit, upstream timeout.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 32 * 1024;
const READ_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
]);
const WRITE_METHODS = new Set(["sendTransaction", "simulateTransaction"]);

// ---- per-IP fixed-window limiter (per process; fine for a single container) ----
const RATE = Number(process.env.RPC_RATE_PER_MIN || 120);
const SEND_RATE = Number(process.env.RPC_SEND_PER_MIN || 12);
type Bucket = { start: number; all: number; send: number };
const buckets = new Map<string, Bucket>();
function limited(ip: string, isSend: boolean) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start >= 60_000) {
    b = { start: now, all: 0, send: 0 };
    buckets.set(ip, b);
  }
  b.all++;
  if (isSend) b.send++;
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.start >= 60_000) buckets.delete(k);
  const over = b.all > RATE || (isSend && b.send > SEND_RATE);
  return over ? Math.ceil((b.start + 60_000 - now) / 1000) : 0;
}

function clientIp(req: NextRequest) {
  // Traefik sets X-Forwarded-For / X-Real-Ip; take the first hop.
  return req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function sameOrigin(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const rpcError = (status: number, code: number, message: string, id: unknown = null, extra: HeadersInit = {}) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "cache-control": "no-store", ...extra } });

async function readCapped(req: NextRequest): Promise<string | null> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return rpcError(403, -32003, "Cross-origin RPC requests are not allowed");
  const upstream = process.env.SOLANA_RPC;
  if (!upstream) return rpcError(503, -32004, "RPC is not configured on this server");

  const text = await readCapped(req);
  if (text === null) return rpcError(413, -32600, "Request body exceeds 32 KB");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error");
  }
  if (Array.isArray(body)) return rpcError(400, -32600, "Batch requests are not supported; send one call per request");
  if (!body || typeof body !== "object") return rpcError(400, -32600, "Invalid request");
  const { jsonrpc, method, params, id } = body as { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };
  if (jsonrpc !== "2.0" || typeof method !== "string") return rpcError(400, -32600, "Invalid request", id ?? null);
  if (params !== undefined && !Array.isArray(params)) return rpcError(400, -32602, "params must be an array", id ?? null);
  const isSend = WRITE_METHODS.has(method);
  if (!isSend && !READ_METHODS.has(method)) return rpcError(403, -32601, `Method ${method} is not allowed`, id ?? null);

  const retry = limited(clientIp(req), isSend);
  if (retry) return rpcError(429, -32005, "Too many requests, slow down", id ?? null, { "retry-after": String(retry) });

  try {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // re-serialise only the vetted fields
      body: JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, method, params: params ?? [] }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const out = await res.text();
    return new Response(out, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json", "cache-control": "no-store" },
    });
  } catch {
    return rpcError(502, -32005, "Upstream RPC unavailable", id ?? null);
  }
}

export function GET() {
  return rpcError(405, -32600, "Use POST", null, { allow: "POST" });
}
