// Buy routes for the keeper's buyback: SOL -> token instructions that sit between
// release_buyback and record_buyback_burn in ONE atomic transaction.
//   PumpCurveRoute:     pump.fun bonding curve (pre-migration; the mainnet launch phase)
//   PumpSwapPoolRoute:  the canonical PumpSwap pool after graduation (devnet today, mainnet later)
//   JupiterRoute:       any DEX via Jupiter (mainnet fallback; Jupiter does not route devnet tokens)
// A route returns null when it cannot serve the trade (curve migrated, no route, quote error);
// the keeper then tries the next route or skips the chunk. Nothing is sent from here.
import { Connection, PublicKey, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput as ammBuyQuoteInput } from "@pump-fun/pump-swap-sdk";
import { jupiterQuote, jupiterSwapInstructions } from "./actions.js";
import type { Logger } from "../lib/log.js";

export interface SwapPlan {
  route: string;
  /** Tokens (base units) the swap guarantees to deliver (exact-out, or min-out after slippage). */
  minTokensOut: bigint;
  /** Lamports the swap consumes (record_buyback_burn refunds `released - spent` to the vault). */
  lamportsSpent: bigint;
  impactPct: number;
  build(): Promise<{ ixs: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[] }>;
}

export interface SwapRoute {
  readonly name: string;
  plan(lamports: bigint, user: PublicKey): Promise<SwapPlan | null>;
}

/** pump.fun bonding-curve buy (legacy SOL `buy`, exact tokens out, max SOL cost). */
export class PumpCurveRoute implements SwapRoute {
  readonly name = "pump-curve";
  private readonly online: OnlinePumpSdk;
  constructor(
    private readonly conn: Connection,
    private readonly mint: PublicKey,
    private readonly tokenProgram: PublicKey,
    private readonly slippageBps: number,
    private readonly log: Logger,
  ) {
    this.online = new OnlinePumpSdk(conn);
  }

  async plan(lamports: bigint, user: PublicKey): Promise<SwapPlan | null> {
    try {
      const [global, feeConfig, st] = await Promise.all([
        this.online.fetchGlobal(),
        this.online.fetchFeeConfig().catch(() => null),
        this.online.fetchBuyState(this.mint, user, this.tokenProgram),
      ]);
      const curve = st.bondingCurve;
      if (curve.complete) {
        this.log.warn("pump-curve: bonding curve is complete (migrated) — not buying on the curve");
        return null;
      }
      // mintSupply must be the LIVE supply (burns shrink it); the curve's initial supply over-quotes
      // and the buy then fails with NotEnoughTokensToBuy (6021), seen on devnet by the chain team.
      const mintSupply = new BN((await this.conn.getTokenSupply(this.mint, "confirmed")).value.amount);
      const common = {
        global, feeConfig, mintSupply, bondingCurve: curve,
        quoteMint: st.quoteMint, quoteTransferFee: st.quoteTransferFee,
      };
      const tokens = getBuyTokenAmountFromSolAmount({ ...common, amount: new BN(lamports.toString()) });
      if (tokens.isZero()) return null;
      // Never buy the curve out: that triggers pump.fun's migration (and breaks the curve price source).
      // Keep at least 10% of the remaining real tokens on the curve.
      const real = BigInt(curve.realTokenReserves.toString());
      if (BigInt(tokens.toString()) * 10n > real * 9n) {
        this.log.warn(`pump-curve: buy of ${tokens} tokens would nearly exhaust the curve (${real} real tokens left) — skipping, nothing released`);
        return null;
      }
      // What these exact tokens cost incl. pump fees, at the state we just read (<= lamports).
      const cost = getBuySolAmountFromTokenAmount({ ...common, amount: tokens });
      // Impact (incl. fees) vs. buying at the current marginal price.
      const atSpot = (lamports * BigInt(curve.virtualTokenReserves.toString())) / BigInt(curve.virtualQuoteReserves.toString());
      const impactPct = atSpot > 0n ? (1 - Number(BigInt(tokens.toString())) / Number(atSpot)) * 100 : 100;
      const slippagePct = this.slippageBps / 100;
      return {
        route: this.name,
        minTokensOut: BigInt(tokens.toString()),
        lamportsSpent: BigInt(cost.toString()),
        impactPct,
        build: async () => ({
          ixs: await PUMP_SDK.buyInstructions({
            global,
            bondingCurveAccountInfo: st.bondingCurveAccountInfo,
            bondingCurve: curve,
            associatedUserAccountInfo: st.associatedUserAccountInfo,
            mint: this.mint,
            user,
            amount: tokens, // exact out
            solAmount: cost, // max cost = cost * (1 + slippage)
            slippage: slippagePct,
            tokenProgram: this.tokenProgram,
          }),
          lookupTables: [],
        }),
      };
    } catch (e) {
      this.log.warn(`pump-curve route unavailable: ${(e as Error).message}`);
      return null;
    }
  }
}

/**
 * Canonical PumpSwap pool (graduated token). buy = exact base out with a max quote in; the builder
 * wraps maxQuote lamports into WSOL and closes the account again, so the unspent part returns to
 * the keeper. We size quote so that maxQuote (quote + slippage) fits the released lamports.
 */
export class PumpSwapPoolRoute implements SwapRoute {
  readonly name = "pumpswap-pool";
  private readonly online: OnlinePumpAmmSdk;
  constructor(
    private readonly conn: Connection,
    private readonly pool: PublicKey,
    private readonly slippageBps: number,
    private readonly log: Logger,
  ) {
    this.online = new OnlinePumpAmmSdk(conn);
  }

  async plan(lamports: bigint, user: PublicKey): Promise<SwapPlan | null> {
    try {
      const st = await this.online.swapSolanaState(this.pool, user);
      const slippagePct = this.slippageBps / 100;
      const quote = new BN(((lamports * 10_000n) / BigInt(10_000 + this.slippageBps)).toString());
      const { pool } = st;
      const { base, maxQuote } = ammBuyQuoteInput({
        quote, slippage: slippagePct, quoteTransferFee: st.quoteTransferFee, baseReserve: st.poolBaseAmount,
        quoteReserve: st.poolQuoteAmount, virtualQuoteReserves: pool.virtualQuoteReserves, baseMintAccount: st.baseMintAccount,
        baseMint: st.baseMint, coinCreator: pool.coinCreator, creator: pool.creator, feeConfig: st.feeConfig,
        globalConfig: st.globalConfig, quoteMint: pool.quoteMint, isMayhemMode: pool.isMayhemMode, creatorFeeBps: pool.creatorFeeBps,
      });
      if (base.isZero() || BigInt(maxQuote.toString()) > lamports) return null;
      const effQuote = BigInt(st.poolQuoteAmount.toString()) + BigInt((pool.virtualQuoteReserves ?? new BN(0)).toString());
      const atSpot = effQuote > 0n ? (BigInt(quote.toString()) * BigInt(st.poolBaseAmount.toString())) / effQuote : 0n;
      const impactPct = atSpot > 0n ? (1 - Number(BigInt(base.toString())) / Number(atSpot)) * 100 : 100;
      return {
        route: this.name,
        minTokensOut: BigInt(base.toString()),
        lamportsSpent: BigInt(quote.toString()),
        impactPct,
        build: async () => ({ ixs: await PUMP_AMM_SDK.buyQuoteInput(st, quote, slippagePct), lookupTables: [] }),
      };
    } catch (e) {
      this.log.warn(`pumpswap-pool route unavailable: ${(e as Error).message}`);
      return null;
    }
  }
}

/** Jupiter ExactIn swap (post-migration). */
export class JupiterRoute implements SwapRoute {
  readonly name = "jupiter";
  constructor(
    private readonly conn: Connection,
    private readonly apiUrl: string,
    private readonly mint: string,
    private readonly slippageBps: number,
    private readonly log: Logger,
  ) {}

  async plan(lamports: bigint, user: PublicKey): Promise<SwapPlan | null> {
    let q;
    try {
      q = await jupiterQuote(this.apiUrl, this.mint, lamports, this.slippageBps);
    } catch (e) {
      this.log.warn(`jupiter route unavailable: ${(e as Error).message}`);
      return null;
    }
    return {
      route: this.name,
      minTokensOut: BigInt(q.otherAmountThreshold),
      lamportsSpent: BigInt(q.inAmount),
      impactPct: Number(q.priceImpactPct) * 100,
      build: () => jupiterSwapInstructions(this.conn, this.apiUrl, q, user),
    };
  }
}
