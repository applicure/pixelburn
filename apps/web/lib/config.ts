/**
 * Single place for names and protocol constants (SPEC: "keep in ONE config constant per package").
 * Mirrors @mpb/sdk constants; when the SDK lands these should be re-exported from it.
 */
export const BRAND = {
  name: "Pixel Frame",
  shortName: "Pixel Frame",
  ticker: "$PXL",
  tickerBare: "PXL",
  x: "https://x.com/PixelFrameSol",
  xHandle: "@PixelFrameSol",
  ca: "AtdDZmDYXUML7enbwEtVHuwVG6NHgdgBNctKfDLJpump",
} as const;

export const SECURITY_CONTACT = "team@pixelframe.tech";

/** Public origin of this site: metadataBase and absolute OG/Twitter URLs. Build-time (NEXT_PUBLIC_*), see docs/domain-cutover.md. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://pixelframe.tech";

export const GRID = 100; // blocks per side
export const BLOCK_PX = 10; // pixels per block side
export const CANVAS_PX = GRID * BLOCK_PX; // 1000
export const TOTAL_BLOCKS = GRID * GRID; // 10_000
export const PRICE_PER_BLOCK_USD_MICRO = 100_000_000n; // $100 per block, $1 per pixel
export const PRICE_PER_BLOCK_USD = 100;
export const TREASURY_BPS = 5000;
export const TOKEN_DISCOUNT_BPS = 1000;
export const AUCTION_THRESHOLD_BLOCKS = 9_900;
export const AUCTION_DURATION_SECS = 72 * 3600;
export const TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const QUOTE_TTL_MS = 30_000;

export const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "";
export const USE_MOCK = !API_URL;
/** Client env, with NEXT_PUBLIC_API_URL and NEXT_PUBLIC_SITE_URL. RPC itself is proxied same-origin via /api/rpc (server env SOLANA_RPC). */
export const CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet") as "devnet" | "mainnet-beta";
/** Same-origin JSON-RPC proxy. web3.js needs an absolute URL. */
// The `cluster` hint matters: wallet adapters derive the wallet-standard chain from the endpoint URL
// (/\bdevnet\b/ → solana:devnet, anything else → mainnet). Without it devnet wallets are refused. The route ignores it.
const RPC_PATH = `/api/rpc${CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`}`;
export const rpcEndpoint = () => (typeof window === "undefined" ? `http://localhost:3000${RPC_PATH}` : `${window.location.origin}${RPC_PATH}`);

export const HISTORY_2005 = {
  founder: "Alex Tew",
  launched: "26 Aug 2005",
  soldOut: "11 Jan 2006",
  raisedUsd: 1_037_100,
  ebayUsd: 38_100,
  ebayPixels: 1_000,
} as const;
