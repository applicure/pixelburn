import { LAMPORTS_PER_SOL, TOKEN_DECIMALS } from "./config";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtInt = (n: number) => nf0.format(n);
export const fmtUsd = (n: number, dp = 0) =>
  "$" + (dp ? new Intl.NumberFormat("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(n) : nf0.format(n));
export const lamportsToSol = (l: string | bigint | number) => Number(BigInt(l)) / LAMPORTS_PER_SOL;
export const fmtSol = (l: string | bigint | number, dp = 2) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(lamportsToSol(l));
export const tokensToWhole = (t: string | bigint | number) => Number(BigInt(t)) / 10 ** TOKEN_DECIMALS;
export const fmtTokens = (t: string | bigint | number) => nf0.format(Math.round(tokensToWhole(t)));
export const fmtCompact = (n: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const fmtPct = (n: number, dp = 1) => `${n.toFixed(dp)}%`;
export const fmt2 = (n: number) => nf2.format(n);
export const shortAddr = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export function timeAgo(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function linkHost(link: string) {
  try {
    return new URL(link).host.replace(/^www\./, "");
  } catch {
    return link;
  }
}

export function explorerTx(sig: string, cluster = "devnet") {
  return `https://explorer.solana.com/tx/${sig}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
}
export function explorerAddr(addr: string, cluster = "devnet") {
  return `https://explorer.solana.com/address/${addr}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
}
