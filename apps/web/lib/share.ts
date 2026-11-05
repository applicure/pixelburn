/** Share links and post text. Everything said here must be true of this exact purchase: see NOTES "Copy policy". */
import { API_URL, BRAND, CLUSTER, SITE_URL, TOKEN_DECIMALS } from "./config";
import { fmtInt, fmtUsd, lamportsToSol } from "./format";
import type { AdShare, AdPayMode } from "./types";

/** The figures a post is made from: from the indexed ad, or the on-chain account until the indexer catches up. */
export interface ShareFacts {
  x: number;
  y: number;
  w: number;
  h: number;
  blockCount: number;
  payMode: AdPayMode;
  usd: number;
  lamports: string;
  tokens: string;
  /** False while `tokens` is only the quote: then the text says "about". */
  exact: boolean;
}

export const factsFromShare = (s: AdShare): ShareFacts => ({
  x: s.x,
  y: s.y,
  w: s.w,
  h: s.h,
  blockCount: s.blockCount,
  payMode: s.payMode,
  usd: s.usd,
  lamports: s.lamports,
  tokens: s.tokensBurned,
  exact: true,
});

/**
 * The ad page. Approved links carry the card version: X caches a preview per page URL, so someone who posted the review
 * card and shares again after approval gets a URL X has not seen, and with it the real card. The page's canonical stays clean.
 */
export function adPageUrl(share: Pick<AdShare, "id" | "status" | "cardVersion">) {
  return `${SITE_URL}/ad/${share.id}${share.status === "approved" ? `?v=${share.cardVersion}` : ""}`;
}

/** Versioned so that the URL changes with approval state: X caches images by URL. */
export const cardImageUrl = (id: number, version: string) => `${API_URL}/api/ads/${id}/card.png?v=${version}`;

/** Every digit of a base-unit amount, without trailing zeros: 12,345,678.9012 */
export function exactTokens(baseUnits: string) {
  const s = BigInt(baseUnits).toString().padStart(TOKEN_DECIMALS + 1, "0");
  const whole = s.slice(0, -TOKEN_DECIMALS);
  const frac = s.slice(-TOKEN_DECIMALS).replace(/0+$/, "");
  return `${BigInt(whole).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

const sizeWords = (f: ShareFacts) => (f.blockCount === 1 ? "a block" : `${f.w}×${f.h} blocks`);

type Variant = (f: ShareFacts) => string;

/** Index 0 is the default. No price talk, no predictions, nothing "guaranteed": only what this transaction did. */
const solShare = (f: ShareFacts) => lamportsToSol(BigInt(f.lamports) / 2n).toLocaleString("en-US", { maximumFractionDigits: 3 });
const SOL_VARIANTS_LATER: Variant[] = [
  (f) => `I just put ${sizeWords(f)} on ${BRAND.name} ${BRAND.xHandle} for ${fmtUsd(f.usd)}. Half goes to the buyback vault, buybacks coming soon.`,
  (f) => `${fmtUsd(f.usd)} for ${sizeWords(f)} of a million-pixel wall on Solana. Half funds the ${BRAND.name} treasury, half goes to the buyback vault. Buybacks coming soon.`,
  (f) => `Half of what I paid for my ${BRAND.name} blocks is now in the buyback vault, ${solShare(f)} SOL of it. Buybacks coming soon.`,
];
const SOL_VARIANTS_LIVE: Variant[] = [
  (f) => `I just put ${sizeWords(f)} on ${BRAND.name} ${BRAND.xHandle} for ${fmtUsd(f.usd)}. Half goes to the ${BRAND.ticker} buyback, which buys and burns over time.`,
  (f) => `${fmtUsd(f.usd)} for ${sizeWords(f)} of a million-pixel wall on Solana. Half funds the ${BRAND.name} treasury, half goes to ${BRAND.ticker} buyback and burn.`,
  (f) => `Half of what I paid for my ${BRAND.name} blocks is now in the ${BRAND.ticker} buyback vault, waiting to burn. ${solShare(f)} SOL of it.`,
];
const TOKEN_VARIANTS: Variant[] = [
  (f) => `I just burned ${amount(f)} ${BRAND.ticker} to put ${sizeWords(f)} on ${BRAND.name} ${BRAND.xHandle}. Gone in the same transaction.`,
  (f) => `${amount(f)} ${BRAND.ticker} destroyed. That was the price of my ${sizeWords(f).replace(/^a /, "")} on ${BRAND.name}, a million-pixel wall on Solana.`,
  (f) => `My ad on ${BRAND.name} cost ${amount(f)} ${BRAND.ticker}, and every token of it burned in the purchase.`,
];
const amount = (f: ShareFacts) => `${f.exact ? "" : "about "}${f.exact ? exactTokens(f.tokens) : fmtInt(Math.round(Number(BigInt(f.tokens)) / 10 ** TOKEN_DECIMALS))}`;

export const VARIANT_COUNT = SOL_VARIANTS_LATER.length;

export function shareBody(f: ShareFacts, variant = 0, cluster: string = CLUSTER, live = false) {
  const list = f.payMode === "token" ? TOKEN_VARIANTS : live ? SOL_VARIANTS_LIVE : SOL_VARIANTS_LATER;
  const text = list[variant % list.length]!(f);
  return cluster === "mainnet-beta" ? text : `${text} (Test network, no real money.)`;
}

/** X counts every link as 23 characters. */
export const X_LIMIT = 280;
export const xLength = (body: string, link: string | null) => [...body].length + (link ? 1 + 23 : 0);

export const xIntentUrl = (body: string, link: string | null) =>
  `https://x.com/intent/post?text=${encodeURIComponent(body)}${link ? `&url=${encodeURIComponent(link)}` : ""}`;

/** The same headline the card carries. Nothing here claims a burn that has not happened. */
export function burnHeadline(f: Pick<ShareFacts, "payMode" | "usd" | "lamports" | "tokens">, live = false) {
  const sol = lamportsToSol(f.lamports);
  const solText = sol.toLocaleString("en-US", { minimumFractionDigits: sol >= 100 ? 1 : sol >= 1 ? 2 : 3, maximumFractionDigits: sol >= 100 ? 1 : sol >= 1 ? 2 : 3 });
  if (f.payMode === "token") return { label: `${BRAND.ticker} BURNED`, figure: compactTokens(f.tokens), sub: "every token paid, destroyed in the purchase" };
  if (!live && f.payMode === "auction") return { label: "TO THE BUYBACK VAULT", figure: `${solText} SOL`, sub: "all of the winning bid, buybacks coming soon" };
  if (!live) return { label: "TO THE BUYBACK VAULT", figure: fmtUsd(Math.round(f.usd / 2)), sub: `half of ${solText} SOL paid, buybacks coming soon` };
  if (f.payMode === "auction") return { label: `TO ${BRAND.ticker} BUYBACK AND BURN`, figure: `${solText} SOL`, sub: "all of the winning bid" };
  return { label: `TO ${BRAND.ticker} BUYBACK AND BURN`, figure: fmtUsd(Math.round(f.usd / 2)), sub: `half of ${solText} SOL paid, buys and burns later` };
}

export function compactTokens(baseUnits: string) {
  const whole = Number(BigInt(baseUnits)) / 10 ** TOKEN_DECIMALS;
  if (whole >= 1e9) return `${(whole / 1e9).toFixed(2)}B`;
  if (whole >= 1e6) return `${(whole / 1e6).toFixed(2)}M`;
  if (whole >= 1) return fmtInt(Math.floor(whole));
  return whole > 0 ? whole.toFixed(2) : "0";
}

/** Same rule as services/src/card/render.ts adBox: whole-number upscales keep every pixel square. */
export function adBox(wBlocks: number, hBlocks: number) {
  const pw = wBlocks * 10, ph = hBlocks * 10;
  const wide = pw / ph >= 2.5;
  const raw = Math.min((wide ? 1108 : 490) / pw, (wide ? 214 : 490) / ph);
  const k = raw >= 1 ? Math.floor(raw) : raw;
  return { iw: Math.max(1, Math.round(pw * k)), ih: Math.max(1, Math.round(ph * k)), exact: raw >= 1, wide };
}
