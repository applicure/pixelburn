import { PROGRAM_IDS } from "@mpb/sdk";
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
  PUBLIC_API_URL: optStr, // e.g. https://api.pixelframe.tech ; defaults to http://localhost:PORT
  PUBLIC_API_URL_ALIASES: optStr, // comma list of former API origins: stored /files/ URIs on them keep resolving (docs/domain-cutover.md)
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
  TOKEN_SUPPLY_STATIC: z.string().optional(), // legacy alias of TOKEN_INITIAL_SUPPLY
  TOKEN_INITIAL_SUPPLY: z.string().regex(/^\d+$/).optional(), // base units at launch (pump.fun: 1e9 tokens x 1e6)

  // Keeper
  KEEPER_KEYPAIR: optStr,
  KEEPER_LIVE: bool,
  KEEPER_BUYBACK_ENABLED: z.string().optional().transform((v) => v === undefined || v === "" ? true : v === "1" || v === "true"),
  KEEPER_OUTSTANDING_GRACE_SECS: z.coerce.number().int().default(900),
  KEEPER_BUYBACK_MAX_SPOT_OVER_EMA_PCT: z.coerce.number().default(10), // program pauses token payments at 15%
  KEEPER_BUYBACK_MAX_RUN_PRICE_MOVE_PCT: z.coerce.number().default(5),
  KEEPER_BUYBACK_MAX_QUOTE_FRACTION_BPS: z.coerce.number().int().default(50), // one buy <= 0.5% of effective quote reserves (~1% impact)
  KEEPER_CRANK_INTERVAL_MS: z.coerce.number().int().default(45_000), // chain: crank every 30-60 s (EMA moves <= 2%/crank)
  KEEPER_BUYBACK_INTERVAL_MS: z.coerce.number().int().default(15 * 60_000),
  KEEPER_BUYBACK_JITTER_MS: z.coerce.number().int().default(5 * 60_000),
  KEEPER_LOOKUP_TABLE: optStr, // keeper-owned ALT for the atomic buyback tx (found/created automatically if unset)
  KEEPER_BUYBACK_FIRST_DELAY_MS: z.coerce.number().int().default(90_000), // first run soon after (re)start
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
  publicBaseUrlAliases: string[];
  rpcUrl: string;
  wsUrl: string;
  /** Labelled same-cluster RPCs the indexer may ask when the primary lacks a tx's history. */
  historyRpcFallbacks: { label: string; url: string }[];
  corsOrigins: string[];
};

export function heliusUrls(cluster: "devnet" | "mainnet-beta", key: string) {
  const host = cluster === "mainnet-beta" ? "mainnet.helius-rpc.com" : "devnet.helius-rpc.com";
  return { http: `https://${host}/?api-key=${key}`, ws: `wss://${host}/?api-key=${key}` };
}

/**
 * Refuses env that mixes clusters. A wrong PROGRAM_ID is otherwise only noticed as "no config account" at runtime, and a wrong
 * IRYS_NETWORK would store mainnet ads on Irys devnet, which is pruned, or spend real SOL from a devnet deployment.
 */
export function assertClusterConsistent(e: { SOLANA_CLUSTER: "devnet" | "mainnet-beta"; PROGRAM_ID?: string; IRYS_KEY?: string; IRYS_NETWORK: string }) {
  const other = e.SOLANA_CLUSTER === "mainnet-beta" ? "devnet" : "mainnet-beta";
  if (e.PROGRAM_ID === PROGRAM_IDS[other].toBase58()) {
    throw new Error(`PROGRAM_ID is the ${other} program but SOLANA_CLUSTER=${e.SOLANA_CLUSTER}`);
  }
  const wantIrys = e.SOLANA_CLUSTER === "mainnet-beta" ? "mainnet" : "devnet";
  if (e.IRYS_KEY && e.IRYS_NETWORK !== wantIrys) {
    throw new Error(`IRYS_NETWORK=${e.IRYS_NETWORK} with SOLANA_CLUSTER=${e.SOLANA_CLUSTER}: set IRYS_NETWORK=${wantIrys}`);
  }
}

/**
 * RPC precedence: RPC_URL override > SOLANA_RPC (QuickNode) > Helius (from key + cluster) > public cluster RPC.
 * WS precedence:  WS_URL override  > Helius websocket > derived from the HTTP RPC.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Empty values (e.g. `LOG_LEVEL=` copied from .env.example) mean "unset".
  const parsed = EnvSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "")));
  assertClusterConsistent(parsed);
  const helius = parsed.SOLANA_RPC_HELIUS_KEY ? heliusUrls(parsed.SOLANA_CLUSTER, parsed.SOLANA_RPC_HELIUS_KEY) : null;
  const publicRpc = parsed.SOLANA_CLUSTER === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
  const rpcUrl = parsed.RPC_URL ?? parsed.SOLANA_RPC ?? helius?.http ?? publicRpc;
  // Second providers for transaction HISTORY (indexer retries a null getTransaction there before halting).
  // Same cluster only: devnet never gets a mainnet URL (SOLANA_RPC/QuickNode is mainnet-only here).
  const candidates: { label: string; url: string | undefined }[] =
    parsed.SOLANA_CLUSTER === "mainnet-beta"
      ? [
          { label: "helius-mainnet", url: helius?.http },
          { label: "quicknode", url: parsed.SOLANA_RPC },
          { label: "public-mainnet", url: publicRpc },
        ]
      : [
          { label: "helius-devnet", url: helius?.http },
          { label: "public-devnet", url: publicRpc },
        ];
  const historyRpcFallbacks = candidates.filter((c): c is { label: string; url: string } => !!c.url && c.url !== rpcUrl);
  const wsUrl = parsed.WS_URL ?? helius?.ws ?? rpcUrl.replace(/^http/, "ws");
  const cfg: Config = {
    ...parsed,
    publicBaseUrl: (parsed.PUBLIC_API_URL ?? parsed.PUBLIC_BASE_URL ?? `http://localhost:${parsed.PORT}`).replace(/\/$/, ""),
    rpcUrl,
    wsUrl,
    historyRpcFallbacks,
    publicBaseUrlAliases: (parsed.PUBLIC_API_URL_ALIASES ?? "").split(",").map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin),
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
