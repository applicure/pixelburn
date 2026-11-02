import { QUOTE_TTL_SECS, TOKEN_DISCOUNT_BPS } from "../constants.js";
import { buyPriceQ as sdkBuyPriceQ, quoteLamports as sdkQuoteLamports, quoteTokensExact } from "@mpb/sdk";
import { microToUsd, quoteUsd, tokenUsdPerToken } from "../lib/quote-math.js";
import { TokenPricingUnavailable, type SolPriceSource, type TokenPrice, type TokenPriceSource } from "./prices.js";

/**
 * Whether paying in $PIXEL is possible right now, from the SDK's tokenPricingStatus (the same gate
 * buy_with_token applies). SDK reasons are mapped camelCase -> snake_case generically, so new
 * on-chain reasons (e.g. hourlyCap -> hourly_cap) flow through without a services change.
 * "unknown" = the token price could not be read at all.
 */
export type TokenPaymentStatus = "ok" | "not_seeded" | "warming_up" | "stale" | "deviation" | "hourly_cap" | "unknown" | (string & {});

export const toSnake = (reason: string) => reason.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** SDK reason -> API status. capExhausted is surfaced as "hourly_cap" (the hourly token-paid block cap). */
export const toPaymentStatus = (reason: string): TokenPaymentStatus => (reason === "capExhausted" ? "hourly_cap" : toSnake(reason));

export interface QuoteDto {
  tokenPaymentStatus: TokenPaymentStatus;
  /** Human-readable explanation when tokenPaymentStatus != "ok". */
  tokenPaymentDetail: string | null;
  /** Which price set the token charge (min of spot, fast EMA, slow 4h EMA); null unless status ok. */
  tokenPricedBy: "spot" | "ema" | "slow_ema" | null;
  /** Token-paid blocks still available this hour (on-chain bucket), when known. */
  tokenBlocksAvailable: number | null;
  usd: number;
  usdMicro: string;
  lamports?: string;
  tokens?: string;
  solPriceUsd: number;
  tokenPriceUsd: number | null;
  discountBps: number;
  expiresAt: number;
}

export class QuoteService {
  constructor(
    private readonly sol: SolPriceSource,
    private readonly token: TokenPriceSource,
    private readonly decimals: number,
  ) {}

  async quote(w: number, h: number, mode: "sol" | "token", nowSecs = Math.floor(Date.now() / 1000)): Promise<QuoteDto> {
    const usdMicro = quoteUsd(w, h);
    const sol = await this.sol.get();
    const solFixed = { price: sol.rawPrice, expo: sol.expo };
    const base = {
      usd: microToUsd(usdMicro),
      usdMicro: usdMicro.toString(),
      solPriceUsd: sol.price,
      discountBps: Number(TOKEN_DISCOUNT_BPS),
      expiresAt: nowSecs + QUOTE_TTL_SECS,
    };
    // Token status/price for this exact size (the hourly cap depends on w*h). Never fails a SOL quote.
    let t: TokenPrice | null = null;
    try {
      t = await this.token.get(w * h);
    } catch {
      t = null;
    }
    const slow = t ? (t.slow ?? t.ema) : 0n;
    let tokenPriceUsd: number | null = null;
    try {
      if (t) tokenPriceUsd = tokenUsdPerToken(sdkBuyPriceQ(t.spot, t.ema, slow), sol.price, this.decimals);
    } catch {
      tokenPriceUsd = null; // EMA not seeded
    }
    const status: TokenPaymentStatus = !t ? "unknown" : t.unavailable ? toPaymentStatus(t.unavailable.reason) : "ok";
    const tokenInfo = {
      tokenPriceUsd,
      tokenPaymentStatus: status,
      tokenPaymentDetail: !t ? "token price unavailable" : (t.unavailable?.detail ?? null),
      tokenPricedBy: status === "ok" && t?.pricedBy ? (toSnake(t.pricedBy) as QuoteDto["tokenPricedBy"]) : null,
      tokenBlocksAvailable: t?.blocksAvailable ?? null,
    };
    if (mode === "sol") {
      // Chain-identical (SDK) math: ceil(usd * 10^(3-expo) / price).
      return { ...base, ...tokenInfo, lamports: sdkQuoteLamports(usdMicro, solFixed).toString() };
    }
    if (!t) throw new Error("token price unavailable");
    if (t.unavailable) throw new TokenPricingUnavailable(status, t.unavailable.detail);
    // discount -> lamports at SOL/USD -> tokens at min(spot, fast EMA, slow EMA), exactly as buy_with_token.
    return { ...base, ...tokenInfo, tokens: quoteTokensExact(usdMicro, solFixed, t.spot, t.ema, slow).toString() };
  }
}
