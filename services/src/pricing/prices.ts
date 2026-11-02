import { PYTH_SOL_USD_FEED_ID } from "../constants.js";
import type { ChainReader } from "../chain/accounts.js";
import { solPerTokenToQ } from "../lib/quote-math.js";
import type { Logger } from "../lib/log.js";

export interface SolPrice {
  /** Raw Pyth price and exponent (price * 10^expo USD). Used for chain-identical math. */
  rawPrice: bigint;
  expo: number;
  /** micro-USD per SOL (display / convenience) */
  priceMicro: bigint;
  emaMicro: bigint;
  price: number;
  publishTime: number;
  stale: boolean;
}

export interface SolPriceSource {
  get(): Promise<SolPrice>;
}

/** Thrown when the program would currently refuse token payments. */
export class TokenPricingUnavailable extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

export interface TokenPrice {
  /** Set when token payments are currently refused on-chain (quote informative only). */
  unavailable?: { reason: string; detail: string };
  /** slow (4h) EMA q; defaults to ema when absent */
  slow?: bigint;
  pricedBy?: "spot" | "ema" | "slowEma";
  blocksAvailable?: number;
  /** q: lamports per token base unit * 1e18 */
  spot: bigint;
  ema: bigint;
  source: string;
}

export interface TokenPriceSource {
  /** `blocks` (w*h) lets on-chain sources check the hourly token-paid block cap. */
  get(blocks?: number): Promise<TokenPrice>;
}

/** Scale Pyth's (price, expo) to micro-USD. */
export function pythToMicro(price: string | number | bigint, expo: number): bigint {
  const p = BigInt(price);
  const shift = expo + 6;
  return shift >= 0 ? p * 10n ** BigInt(shift) : p / 10n ** BigInt(-shift);
}

/** Pyth Hermes SOL/USD with a short cache. */
export class HermesSolPrice implements SolPriceSource {
  private cache: { at: number; v: SolPrice } | null = null;
  constructor(
    private readonly hermesUrl: string,
    private readonly log: Logger,
    private readonly fallbackUsd?: number,
    private readonly ttlMs = 5_000,
    private readonly maxAgeSecs = 60,
    private readonly apiKey?: string,
  ) {}
  async get(): Promise<SolPrice> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.v;
    try {
      const url = `${this.hermesUrl.replace(/\/$/, "")}/v2/updates/price/latest?ids[]=0x${PYTH_SOL_USD_FEED_ID}&parsed=true&encoding=base64`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      });
      if (!res.ok) throw new Error(`hermes HTTP ${res.status}`);
      const body = (await res.json()) as {
        parsed: { price: { price: string; expo: number; publish_time: number }; ema_price: { price: string; expo: number } }[];
      };
      const p = body.parsed[0];
      if (!p) throw new Error("hermes: empty response");
      const priceMicro = pythToMicro(p.price.price, p.price.expo);
      const v: SolPrice = {
        rawPrice: BigInt(p.price.price),
        expo: p.price.expo,
        priceMicro,
        emaMicro: pythToMicro(p.ema_price.price, p.ema_price.expo),
        price: Number(priceMicro) / 1e6,
        publishTime: p.price.publish_time,
        stale: Date.now() / 1000 - p.price.publish_time > this.maxAgeSecs,
      };
      this.cache = { at: Date.now(), v };
      return v;
    } catch (e) {
      if (this.cache) {
        this.log.warn(`hermes failed, serving cached price: ${(e as Error).message}`);
        return { ...this.cache.v, stale: true };
      }
      if (this.fallbackUsd) {
        const m = BigInt(Math.round(this.fallbackUsd * 1e6));
        return { rawPrice: m, expo: -6, priceMicro: m, emaMicro: m, price: this.fallbackUsd, publishTime: Math.floor(Date.now() / 1000), stale: true };
      }
      throw e;
    }
  }
}

/**
 * SOL/USD from the on-chain Pyth sponsored PriceUpdateV2 feed account (the same account the
 * program reads in buy_with_sol / buy_with_token). No API key needed; works on devnet and mainnet.
 * Throws if the price is older than `maxAgeSecs` (the program would reject it too).
 */
export class PythOnchainSolPrice implements SolPriceSource {
  private cache: { at: number; v: SolPrice } | null = null;
  constructor(
    private readonly read: () => Promise<{ price: bigint; expo: number; publishTime: number; verified: boolean }>,
    private readonly maxAgeSecs: number,
    private readonly ttlMs = 2_000,
  ) {}
  async get(): Promise<SolPrice> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.v;
    const p = await this.read();
    if (!p.verified) throw new Error("Pyth price update is not fully verified");
    const age = Math.floor(Date.now() / 1000) - p.publishTime;
    if (age > this.maxAgeSecs) throw new Error(`on-chain SOL/USD is ${age}s old (max ${this.maxAgeSecs}s)`);
    const priceMicro = pythToMicro(p.price, p.expo);
    const v: SolPrice = {
      rawPrice: p.price, expo: p.expo, priceMicro, emaMicro: priceMicro, price: Number(priceMicro) / 1e6,
      publishTime: p.publishTime, stale: false,
    };
    this.cache = { at: Date.now(), v };
    return v;
  }
}

export class StaticSolPrice implements SolPriceSource {
  constructor(private readonly usd: number) {}
  async get(): Promise<SolPrice> {
    const m = BigInt(Math.round(this.usd * 1e6));
    return { rawPrice: m, expo: -6, priceMicro: m, emaMicro: m, price: this.usd, publishTime: Math.floor(Date.now() / 1000), stale: false };
  }
}

/** Configurable static token price (dev / pre-launch). spot == ema. */
export class StaticTokenPrice implements TokenPriceSource {
  private readonly fixed: bigint;
  constructor(solPerToken: number, decimals: number) {
    this.fixed = solPerTokenToQ(solPerToken, decimals);
  }
  async get(): Promise<TokenPrice> {
    return { spot: this.fixed, ema: this.fixed, source: "static" };
  }
}

/** Reads curve/pool reserves and the on-chain EMA from Config. */
export class OnchainTokenPrice implements TokenPriceSource {
  private cache = new Map<string, { at: number; v: TokenPrice }>();
  constructor(
    private readonly chain: ChainReader,
    private readonly ttlMs = 3_000,
  ) {}
  async get(blocks?: number): Promise<TokenPrice> {
    const key = String(blocks ?? "");
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v;
    const r = await this.chain.fetchTokenPrice(blocks);
    if (!r) throw new Error("token price unavailable on-chain (config/curve not found)");
    const v: TokenPrice = { ...r, source: "onchain" };
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, { at: Date.now(), v });
    return v;
  }
}

/** Small TTL cache helper for on-chain reads (token supply etc.). */
export function cached<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let at = 0;
  let v: T | undefined;
  let inflight: Promise<T> | null = null;
  return async () => {
    if (v !== undefined && Date.now() - at < ttlMs) return v;
    if (inflight) return inflight;
    inflight = fn()
      .then((r) => {
        v = r;
        at = Date.now();
        return r;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
