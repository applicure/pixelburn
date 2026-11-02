import { registerSecret } from "./lib/redact.js";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_API_URL: optStr, // e.g. https://api.pixelburn.applicure.io ; defaults to http://localhost:PORT
  PUBLIC_BASE_URL: optStr, // legacy alias of PUBLIC_API_URL
  CORS_ORIGINS: optStr, // comma-separated allowed origins, or *
  WEB_ORIGIN: optStr, // legacy alias of CORS_ORIGINS
  TRUST_PROXY: bool,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().default("postgres://mpb:mpb@127.0.0.1:54329/mpb"),

  SOLANA_CLUSTER: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  SOLANA_RPC: optStr, // full https RPC URL incl. key (QuickNode). SECRET: never logged.
  SOLANA_RPC_HELIUS_KEY: optStr, // Helius API key: websockets (+ HTTP fallback). SECRET.
  RPC_URL: optStr, // optional override of the HTTP RPC
  WS_URL: optStr, // optional override of the websocket RPC
  PROGRAM_ID: optStr,
  TOKEN_MINT: optStr,
  TOKEN_DECIMALS: z.coerce.number().int().default(6),

  ADMIN_TOKEN: optStr,
  HELIUS_WEBHOOK_SECRET: optStr,

  // Indexer
  INDEXER_ENABLED: bool, // run indexer inside the API process
  INDEXER_BACKFILL_INTERVAL_MS: z.coerce.number().int().default(60_000),
  INDEXER_DROP_AFTER_SECS: z.coerce.number().int().default(180),

  // Storage
  IRYS_KEY: optStr,
  IRYS_NETWORK: z.enum(["devnet", "mainnet"]).default("devnet"),
  IRYS_RPC_URL: optStr,
  IRYS_GATEWAY: z.string().default("https://gateway.irys.xyz"),
  ARWEAVE_GATEWAY: z.string().default("https://arweave.net"),
  DATA_DIR: z.string().default("./var"),

  // Moderation
  BLOCKLIST_FILE: z.string().default("./data/blocklist.txt"),
  DRAINER_LIST_FILE: z.string().default("./data/drainers.txt"),
  DRAINER_LIST_URL: optStr,
  AUTO_APPROVE: bool,
  /** Hosts the moderation worker/composer may fetch ad images from (SSRF guard). PUBLIC_BASE_URL's host is always allowed. */
  IMAGE_HOSTS: z.string().default("arweave.net,gateway.irys.xyz,devnet.irys.xyz,node1.irys.xyz,node2.irys.xyz"),

  // Pricing
  HERMES_URL: z.string().default("https://hermes.pyth.network"),
  HERMES_API_KEY: optStr, // Hermes now answers 401 without `Authorization: Bearer <key>`
  SOL_USD_FALLBACK: z.coerce.number().optional(), // DEV ONLY: SOL/USD when no live source answers; ignored in production
  PYTH_SOL_USD_ACCOUNT: optStr, // override of the sponsored Pyth PriceUpdateV2 account (default from @mpb/sdk)
  SOL_PRICE_MAX_AGE_SECS: z.coerce.number().int().default(120), // reject older on-chain prices (program default 120 s)
  TOKEN_PRICE_SOURCE: z.enum(["auto", "onchain", "static"]).default("auto"), // auto = onchain when PROGRAM_ID is set
  /** SOL per WHOLE token, used when TOKEN_PRICE_SOURCE=static (both spot and ema). */
  TOKEN_PRICE_SOL_STATIC: z.coerce.number().default(0.0000125),
  TOKEN_SUPPLY_STATIC: z.string().default("1000000000000000"), // base units, used when TOKEN_MINT unset

  // Keeper
  KEEPER_KEYPAIR: optStr,
  KEEPER_LIVE: bool,
  KEEPER_CRANK_INTERVAL_MS: z.coerce.number().int().default(45_000), // chain: crank every 30-60 s (EMA moves <= 2%/crank)
  KEEPER_BUYBACK_INTERVAL_MS: z.coerce.number().int().default(15 * 60_000),
  KEEPER_BUYBACK_JITTER_MS: z.coerce.number().int().default(5 * 60_000),
  KEEPER_BUYBACK_MAX_CHUNK_LAMPORTS: z.coerce.bigint().default(2_000_000_000n),
  KEEPER_BUYBACK_MIN_CHUNK_LAMPORTS: z.coerce.bigint().default(50_000_000n),
  KEEPER_BUYBACK_MAX_PER_RUN_LAMPORTS: z.coerce.bigint().default(10_000_000_000n),
  KEEPER_BUYBACK_SLIPPAGE_BPS: z.coerce.number().int().default(100),
  KEEPER_BUYBACK_MAX_PRICE_IMPACT_PCT: z.coerce.number().default(1.0),
  KEEPER_VAULT_RESERVE_LAMPORTS: z.coerce.bigint().default(10_000_000n),
  JUPITER_API_URL: z.string().default("https://lite-api.jup.ag/swap/v1"),
  JITO_ENABLED: bool,
  JITO_BLOCK_ENGINE_URL: z.string().default("https://mainnet.block-engine.jito.wtf/api/v1/bundles"),
  JITO_TIP_LAMPORTS: z.coerce.number().int().default(10_000),

  // Rate limits (requests per minute per IP)
  RATE_LIMIT_UPLOADS_PER_MIN: z.coerce.number().int().default(10),
  RATE_LIMIT_QUOTE_PER_MIN: z.coerce.number().int().default(120),
});

export type Config = z.infer<typeof EnvSchema> & {
  publicBaseUrl: string;
  rpcUrl: string;
  wsUrl: string;
  corsOrigins: string[];
};

export function heliusUrls(cluster: "devnet" | "mainnet-beta", key: string) {
  const host = cluster === "mainnet-beta" ? "mainnet.helius-rpc.com" : "devnet.helius-rpc.com";
  return { http: `https://${host}/?api-key=${key}`, ws: `wss://${host}/?api-key=${key}` };
}

/**
 * RPC precedence: RPC_URL override > SOLANA_RPC (QuickNode) > Helius (from key + cluster) > public cluster RPC.
 * WS precedence:  WS_URL override  > Helius websocket > derived from the HTTP RPC.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Empty values (e.g. `LOG_LEVEL=` copied from .env.example) mean "unset".
  const parsed = EnvSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "")));
  const helius = parsed.SOLANA_RPC_HELIUS_KEY ? heliusUrls(parsed.SOLANA_CLUSTER, parsed.SOLANA_RPC_HELIUS_KEY) : null;
  const publicRpc = parsed.SOLANA_CLUSTER === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
  const rpcUrl = parsed.RPC_URL ?? parsed.SOLANA_RPC ?? helius?.http ?? publicRpc;
  const wsUrl = parsed.WS_URL ?? helius?.ws ?? rpcUrl.replace(/^http/, "ws");
  const cfg: Config = {
    ...parsed,
    publicBaseUrl: (parsed.PUBLIC_API_URL ?? parsed.PUBLIC_BASE_URL ?? `http://localhost:${parsed.PORT}`).replace(/\/$/, ""),
    rpcUrl,
    wsUrl,
    corsOrigins: (parsed.CORS_ORIGINS ?? parsed.WEB_ORIGIN ?? "http://localhost:3000").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean),
  };
  registerConfigSecrets(cfg);
  return cfg;
}

/** Everything that must never appear in logs or error responses. */
export function registerConfigSecrets(cfg: Config) {
  const dbPass = (() => {
    try {
      return decodeURIComponent(new URL(cfg.DATABASE_URL).password) || undefined;
    } catch {
      return undefined;
    }
  })();
  for (const s of [
    cfg.SOLANA_RPC, cfg.SOLANA_RPC_HELIUS_KEY, cfg.RPC_URL, cfg.WS_URL, cfg.rpcUrl, cfg.wsUrl, cfg.DATABASE_URL, dbPass,
    cfg.ADMIN_TOKEN, cfg.HELIUS_WEBHOOK_SECRET, cfg.IRYS_KEY, cfg.KEEPER_KEYPAIR, cfg.HERMES_API_KEY, cfg.IRYS_RPC_URL,
  ]) {
    registerSecret(s);
  }
}
