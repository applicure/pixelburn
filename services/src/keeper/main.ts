// Keeper process: `pnpm --filter @mpb/services keeper`.
// DRY-RUN BY DEFAULT. Transactions are only sent when KEEPER_LIVE=1.
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { RpcChainReader } from "../chain/accounts.js";
import { createLogger } from "../lib/log.js";
import { heartbeat } from "../lib/heartbeat.js";
import { loadKeypair, NoProgramActions, SdkKeeperActions } from "./actions.js";
import { Keeper } from "./keeper.js";

const cfg = loadConfig();
const log = createLogger("keeper", cfg.LOG_LEVEL);
const hb = process.env.HEARTBEAT_FILE || "/tmp/keeper.heartbeat";
heartbeat(hb);
setInterval(() => heartbeat(hb), 30_000).unref();
const conn = new Connection(cfg.rpcUrl, "confirmed");
const payer = loadKeypair(cfg.KEEPER_KEYPAIR);
const chain = cfg.PROGRAM_ID ? new RpcChainReader(conn, cfg.PROGRAM_ID, cfg.TOKEN_MINT) : null;

log.info(`cluster=${cfg.SOLANA_CLUSTER} mode=${cfg.KEEPER_LIVE ? "LIVE" : "dry-run"} keeper=${payer?.publicKey.toBase58() ?? "(none)"} program=${cfg.PROGRAM_ID ?? "(unset)"} jito=${cfg.JITO_ENABLED ? "on" : "off"}`);

const keeper = new Keeper(conn, payer, cfg.PROGRAM_ID ? new SdkKeeperActions(conn, new PublicKey(cfg.PROGRAM_ID)) : new NoProgramActions(), chain, {
  live: cfg.KEEPER_LIVE,
  tokenMint: cfg.TOKEN_MINT,
  crankIntervalMs: cfg.KEEPER_CRANK_INTERVAL_MS,
  buybackIntervalMs: cfg.KEEPER_BUYBACK_INTERVAL_MS,
  buybackJitterMs: cfg.KEEPER_BUYBACK_JITTER_MS,
  maxChunkLamports: cfg.KEEPER_BUYBACK_MAX_CHUNK_LAMPORTS,
  minChunkLamports: cfg.KEEPER_BUYBACK_MIN_CHUNK_LAMPORTS,
  maxPerRunLamports: cfg.KEEPER_BUYBACK_MAX_PER_RUN_LAMPORTS,
  reserveLamports: cfg.KEEPER_VAULT_RESERVE_LAMPORTS,
  slippageBps: cfg.KEEPER_BUYBACK_SLIPPAGE_BPS,
  maxPriceImpactPct: cfg.KEEPER_BUYBACK_MAX_PRICE_IMPACT_PCT,
  jupiterApiUrl: cfg.JUPITER_API_URL,
  jito: { enabled: cfg.JITO_ENABLED, url: cfg.JITO_BLOCK_ENGINE_URL, tipLamports: cfg.JITO_TIP_LAMPORTS },
  chunkDelayMs: { min: 5_000, jitter: 25_000 },
}, log);

if (chain) {
  // Pre-check buyback chunks against the same min-out rule the program enforces.
  chain.fetchConfig().then((c) => {
    if (c) keeper.onchainSlippageBps = c.buybackMaxSlippageBps;
  }).catch((e) => log.warn(`config read failed: ${(e as Error).message}`));
}
keeper.start();
const stop = () => {
  keeper.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
