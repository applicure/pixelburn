/**
 * $PXL payment availability. Sources: /api/quote `tokenPaymentStatus` (snake_case, services) and the SDK's
 * `TokenPricingUnavailableError.reason` (camelCase). Both map to one honest message for the UI.
 * Unknown values are treated as unavailable (services passes new on-chain reasons through).
 */
import { BRAND } from "./config";

export type TokenStatus =
  | "ok"
  | "not_seeded"
  | "warming_up"
  | "stale"
  | "deviation"
  | "hourly_cap"
  | "source_unavailable"
  | "unknown"
  | (string & {});

const CAMEL: Record<string, TokenStatus> = {
  notSeeded: "not_seeded",
  warmingUp: "warming_up",
  stale: "stale",
  deviation: "deviation",
  capExhausted: "hourly_cap",
  sourceUnavailable: "source_unavailable",
};
export const normTokenStatus = (s: string | null | undefined): TokenStatus => (!s ? "ok" : CAMEL[s] ?? s);

export function tokenStatusCopy(status: TokenStatus, blocks: number, blocksAvailable: number | null): { title: string; body: string } | null {
  const T = BRAND.ticker;
  switch (status) {
    case "ok":
      return null;
    case "not_seeded":
      return { title: `${T} payments aren't open yet`, body: `The token price feed hasn't been seeded. Pay in SOL for now.` };
    case "warming_up":
      return { title: `${T} pricing is warming up`, body: `After launch the on-chain price average needs about 10 minutes of data. Pay in SOL now, or check back shortly.` };
    case "stale":
      return { title: `${T} price is out of date`, body: `The on-chain price hasn't updated recently, so token payments wait until it does. SOL works right now.` };
    case "deviation":
      return {
        title: `${T} just spiked`,
        body: `The price jumped more than 15% above its recent average. Token payments pause until it settles, so nobody overpays in a spike. SOL works right now.`,
      };
    case "source_unavailable":
      return {
        title: `${T} is moving to its DEX pool`,
        body: `It's migrating from the launch curve to PumpSwap. Token payments reopen about 15 minutes after the move; SOL works right now.`,
      };
    case "hourly_cap": {
      const left = blocksAvailable ?? 0;
      return left > 0
        ? {
            title: `Only ${left} token-paid block${left === 1 ? "" : "s"} left this hour`,
            body: `This ad is ${blocks} blocks. Pay in SOL, or split it into ads of up to ${left} blocks. The allowance refills continuously.`,
          }
        : { title: `This hour's ${T} allowance is used up`, body: `Up to 1,000 blocks an hour can be paid in ${T}. Pay in SOL, or wait a few minutes: it refills continuously.` };
    }
    default:
      return { title: `${T} payments are unavailable right now`, body: `The token price couldn't be read. Pay in SOL instead.` };
  }
}

export const SLOW_EMA_HINT = `Priced by the 4-hour average, which lags a recent rally: you'll burn more ${BRAND.ticker} than the spot price implies. SOL may cost less right now.`;
