// Wires config -> concrete implementations. Shared by server, seed and tests.
import { EventEmitter } from "node:events";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Config } from "./config.js";
import { createDb, type DbHandle } from "./db/client.js";
import { RpcChainReader, type ChainReader } from "./chain/accounts.js";
import { SdkEventParser, type EventParser } from "./chain/events.js";
import { fetchSolUsd, PROGRAM_ID as SDK_PROGRAM_ID, pythPriceFeedAccount } from "@mpb/sdk";
import { Composer } from "./composer/composer.js";
import {
  FileAndUrlDrainerList,
  HttpImageFetcher,
  LocalFirstFetcher,
  noopNsfw,
  SetBlocklist,
  type ImageFetcher,
  type NsfwChecker,
} from "./moderation/checks.js";
import { ModerationService } from "./moderation/service.js";
import {
  cached,
  HermesSolPrice,
  PythOnchainSolPrice,
  StaticSolPrice,
  OnchainTokenPrice,
  StaticTokenPrice,
  type SolPriceSource,
  type TokenPriceSource,
} from "./pricing/prices.js";
import { QuoteService } from "./pricing/quote.js";
import { IrysStorage, LocalStorage, makeImageUrlResolver, type Storage } from "./uploads/storage.js";
import { createLogger, type Logger } from "./lib/log.js";

export interface Overrides {
  sol?: SolPriceSource;
  token?: TokenPriceSource;
  chain?: ChainReader | null;
  fetcher?: ImageFetcher;
  nsfw?: NsfwChecker;
  log?: Logger;
  db?: DbHandle;
}

/**
 * SOL/USD source: Hermes only when HERMES_API_KEY is set (Hermes now 401s without one), otherwise
 * the on-chain Pyth sponsored feed account via RPC. SOL_USD_FALLBACK is honoured only outside
 * production (and only if the live source fails).
 */
export function makeSolPriceSource(cfg: Config, conn: Connection, log: Logger): SolPriceSource {
  const prod = cfg.NODE_ENV === "production";
  if (prod && cfg.SOL_USD_FALLBACK !== undefined) log.warn("SOL_USD_FALLBACK is ignored in production");
  const fallback = prod ? undefined : cfg.SOL_USD_FALLBACK;
  if (cfg.HERMES_API_KEY) return new HermesSolPrice(cfg.HERMES_URL, log, fallback, 5_000, 60, cfg.HERMES_API_KEY);
  const account = cfg.PYTH_SOL_USD_ACCOUNT ? new PublicKey(cfg.PYTH_SOL_USD_ACCOUNT) : pythPriceFeedAccount();
  const onchain = new PythOnchainSolPrice(() => fetchSolUsd(conn, account), cfg.SOL_PRICE_MAX_AGE_SECS);
  if (fallback === undefined) return onchain;
  return {
    async get() {
      try {
        return await onchain.get();
      } catch (e) {
        log.warn(`on-chain SOL/USD unavailable (${(e as Error).message}); using SOL_USD_FALLBACK (dev only)`);
        return new StaticSolPrice(fallback).get().then((v) => ({ ...v, stale: true }));
      }
    },
  };
}

export async function buildContext(cfg: Config, o: Overrides = {}) {
  const log = o.log ?? createLogger("services");
  const handle = o.db ?? createDb(cfg.DATABASE_URL);
  const db = handle.db;
  const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed", wsEndpoint: cfg.wsUrl });
  const rpcChain = new RpcChainReader(conn, cfg.PROGRAM_ID, cfg.TOKEN_MINT);
  const chain: ChainReader | null = o.chain !== undefined ? o.chain : cfg.PROGRAM_ID ? rpcChain : null;
  const decoder: EventParser = new SdkEventParser(cfg.PROGRAM_ID ?? SDK_PROGRAM_ID.toBase58());

  const dataDir = path.resolve(cfg.DATA_DIR);
  const localFiles = new LocalStorage(path.join(dataDir, "files"), cfg.publicBaseUrl);
  const storage: Storage = cfg.IRYS_KEY
    ? new IrysStorage(cfg.IRYS_KEY, cfg.IRYS_NETWORK, cfg.IRYS_RPC_URL ?? cfg.rpcUrl, log)
    : localFiles;
  const resolveImageUrl = makeImageUrlResolver(cfg.ARWEAVE_GATEWAY, cfg.publicBaseUrl);

  const allowedHosts = [...cfg.IMAGE_HOSTS.split(",").map((s) => s.trim()).filter(Boolean), new URL(cfg.publicBaseUrl).host];
  const fetcher = o.fetcher ?? new LocalFirstFetcher(cfg.publicBaseUrl, (n) => localFiles.read(n), new HttpImageFetcher(allowedHosts));

  const composer = new Composer(db, fetcher, resolveImageUrl, path.join(dataDir, "cache"), log);
  const moderation = new ModerationService({
    db,
    chain,
    composer,
    autoApprove: cfg.AUTO_APPROVE,
    log,
    checks: {
      blocklist: await SetBlocklist.fromFile(path.resolve(cfg.BLOCKLIST_FILE)),
      drainers: await FileAndUrlDrainerList.create(path.resolve(cfg.DRAINER_LIST_FILE), cfg.DRAINER_LIST_URL, log),
      nsfw: o.nsfw ?? noopNsfw,
      fetcher,
      resolveImageUrl,
    },
  });

  const sol = o.sol ?? makeSolPriceSource(cfg, conn, log);
  // Production never invents a token price: without a program (auto mode) token payments report
  // tokenPaymentStatus "unknown" instead of a made-up static quote.
  const token: TokenPriceSource =
    o.token ??
    (cfg.TOKEN_PRICE_SOURCE !== "static" && chain
      ? new OnchainTokenPrice(chain)
      : cfg.TOKEN_PRICE_SOURCE === "static" || cfg.NODE_ENV !== "production"
        ? new StaticTokenPrice(cfg.TOKEN_PRICE_SOL_STATIC, cfg.TOKEN_DECIMALS)
        : { get: async () => { throw new Error("token price unavailable: PROGRAM_ID not configured"); } });
  const quotes = new QuoteService(sol, token, cfg.TOKEN_DECIMALS);
  const tokenSupply = cached(async () => (chain ? chain.fetchTokenSupply() : null), 60_000);

  return {
    cfg,
    log,
    handle,
    db,
    conn,
    chain,
    decoder,
    storage,
    localFiles,
    resolveImageUrl,
    composer,
    moderation,
    quotes,
    bus: new EventEmitter().setMaxListeners(10_000),
    stats: { sol, token, decimals: cfg.TOKEN_DECIMALS, tokenSupply, staticInitialSupply: BigInt(cfg.TOKEN_INITIAL_SUPPLY ?? cfg.TOKEN_SUPPLY_STATIC ?? "1000000000000000") },
  };
}

export type ServicesContext = Awaited<ReturnType<typeof buildContext>>;
