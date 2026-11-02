// Keeper process: `pnpm --filter @mpb/services keeper`.
// DRY-RUN BY DEFAULT. Transactions are only sent when KEEPER_LIVE=1.
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { RpcChainReader } from "../chain/accounts.js";
import { createLogger } from "../lib/log.js";
import { heartbeat } from "../lib/heartbeat.js";
import { loadKeypair, NoProgramActions, SdkKeeperActions } from "./actions.js";
import { Keeper } from "./keeper.js";
import { JupiterRoute, PumpCurveRoute, PumpSwapPoolRoute, type SwapRoute } from "./routes.js";

const cfg = loadConfig();
const log = createLogger("keeper", cfg.LOG_LEVEL);
const hb = process.env.HEARTBEAT_FILE || "/tmp/keeper.heartbeat";
heartbeat(hb);
setInterval(() => heartbeat(hb), 30_000).unref();
const conn = new Connection(cfg.rpcUrl, "confirmed");
const payer = loadKeypair(cfg.KEEPER_KEYPAIR);
const chain = cfg.PROGRAM_ID ? new RpcChainReader(conn, cfg.PROGRAM_ID, cfg.TOKEN_MINT) : null;

log.info(`cluster=${cfg.SOLANA_CLUSTER} mode=${cfg.KEEPER_LIVE ? "LIVE" : "dry-run"} buyback=${cfg.KEEPER_BUYBACK_ENABLED ? "on" : "off"} keeper=${payer?.publicKey.toBase58() ?? "(none)"} program=${cfg.PROGRAM_ID ?? "(unset)"} jito=${cfg.JITO_ENABLED ? "on" : "off"}`);

// Buy routes are resolved from the CURRENT Config on every buyback run, so a price-source switch
// (curve -> PumpSwap pool after graduation) is picked up without a restart.
let lastRoutes = "";
const resolveRoutes = async (): Promise<SwapRoute[]> => {
  const c = await chain?.fetchConfig();
  if (!c) return [];
  const slip = cfg.KEEPER_BUYBACK_SLIPPAGE_BPS;
  const routes: SwapRoute[] = [];
  if (c.priceSource.kind === "bondingCurve") routes.push(new PumpCurveRoute(conn, c.tokenMint, c.tokenProgram, slip, log, cfg.KEEPER_BUYBACK_MAX_QUOTE_FRACTION_BPS));
  else routes.push(new PumpSwapPoolRoute(conn, c.priceSource.pool, slip, log, cfg.KEEPER_BUYBACK_MAX_QUOTE_FRACTION_BPS));
  routes.push(new JupiterRoute(conn, cfg.JUPITER_API_URL, c.tokenMint.toBase58(), slip, log));
  const names = routes.map((r) => r.name).join(" -> ");
  if (names !== lastRoutes) log.info(`buyback routes: ${(lastRoutes = names)}`);
  return routes;
};
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
  simulateInDryRun: !!payer,
  buybackEnabled: cfg.KEEPER_BUYBACK_ENABLED,
  maxSpotOverEmaPct: cfg.KEEPER_BUYBACK_MAX_SPOT_OVER_EMA_PCT,
  maxRunPriceMovePct: cfg.KEEPER_BUYBACK_MAX_RUN_PRICE_MOVE_PCT,
  outstandingGraceSecs: cfg.KEEPER_OUTSTANDING_GRACE_SECS,
}, log, undefined, resolveRoutes);

if (chain) {
  // Pre-check buyback chunks against the same min-out rule the program enforces.
  chain.fetchConfig().then((c) => {
    if (!c) return log.warn("pixel Config not found; buybacks disabled");
    keeper.onchainSlippageBps = c.buybackMaxSlippageBps;
    if (cfg.TOKEN_MINT && cfg.TOKEN_MINT !== c.tokenMint.toBase58()) log.warn(`TOKEN_MINT env differs from Config.token_mint; using the on-chain mint`);
    void resolveRoutes();
  }).catch((e) => log.warn(`config read failed: ${(e as Error).message}`));
}
keeper.start();
const stop = () => {
  keeper.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
