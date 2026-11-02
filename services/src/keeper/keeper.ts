import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { CU_LIMITS } from "@mpb/sdk";
import type { ChainReader } from "../chain/accounts.js";
import type { Logger } from "../lib/log.js";
import { jupiterQuote, jupiterSwapInstructions, sendIxs, type KeeperActions, type SendOptions } from "./actions.js";
import { jittered, minBuybackTokens, planBuybackChunks } from "./plan.js";

export interface KeeperConfig {
  live: boolean;
  tokenMint?: string;
  crankIntervalMs: number;
  buybackIntervalMs: number;
  buybackJitterMs: number;
  maxChunkLamports: bigint;
  minChunkLamports: bigint;
  maxPerRunLamports: bigint;
  reserveLamports: bigint;
  slippageBps: number;
  maxPriceImpactPct: number;
  jupiterApiUrl: string;
  jito: { enabled: boolean; url: string; tipLamports: number };
  /** Delay between chunks, randomized: [min, min+jitter) */
  chunkDelayMs: { min: number; jitter: number };
}

export class Keeper {
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private readonly sendOpts: SendOptions;

  constructor(
    private readonly conn: Connection,
    private readonly payer: Keypair | null,
    private readonly actions: KeeperActions,
    private readonly chain: ChainReader | null,
    private readonly cfg: KeeperConfig,
    private readonly log: Logger,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (cfg.live && !payer) throw new Error("KEEPER_LIVE=1 requires KEEPER_KEYPAIR");
    this.sendOpts = { live: cfg.live, jito: cfg.jito };
  }

  /** Config.buyback_max_slippage_bps (set via setOnchainSlippage once read); null = unknown. */
  onchainSlippageBps: number | null = null;

  private async keeperTokenBalance(): Promise<bigint> {
    if (!this.payer || !this.cfg.tokenMint) return 0n;
    const r = await this.conn.getParsedTokenAccountsByOwner(this.payer.publicKey, { mint: new PublicKey(this.cfg.tokenMint) });
    return r.value.reduce((a, v) => a + BigInt(v.account.data.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
  }

  private get keeperKey(): PublicKey {
    return this.payer?.publicKey ?? PublicKey.default;
  }

  async crankOnce(): Promise<string | null> {
    const ixs = await this.actions.crankTokenPriceIxs(this.keeperKey);
    if (!ixs) {
      this.log.warn("crank_token_price: no program configured (PROGRAM_ID unset) — skipped");
      return null;
    }
    return sendIxs(this.conn, this.payer ?? Keypair.generate(), ixs, { ...this.sendOpts, computeUnitLimit: CU_LIMITS.crankTokenPrice }, this.log, "crank_token_price");
  }

  async buybackOnce(): Promise<{ chunks: bigint[]; sent: string[] }> {
    const sent: string[] = [];
    const vault = (await this.chain?.fetchBuybackVaultLamports().catch(() => null)) ?? null;
    if (vault === null) {
      this.log.warn("buyback: vault balance unavailable (PROGRAM_ID unset or vault missing) — skipped");
      return { chunks: [], sent };
    }
    const chunks = planBuybackChunks({
      vaultLamports: vault,
      reserveLamports: this.cfg.reserveLamports,
      maxPerRunLamports: this.cfg.maxPerRunLamports,
      minChunkLamports: this.cfg.minChunkLamports,
      maxChunkLamports: this.cfg.maxChunkLamports,
    });
    this.log.info(`buyback: vault=${vault} lamports, plan=${chunks.length} chunks [${chunks.join(", ")}]${this.cfg.live ? "" : " (dry-run)"}`);
    const price = (await this.chain?.fetchTokenPrice().catch(() => null)) ?? null;
    // record_buyback_burn needs a warmed-up, fresh EMA; don't release SOL we can't reconcile.
    if (price?.unavailable && price.unavailable.reason !== "deviation") {
      this.log.warn(`buyback: skipped, token EMA not usable (${price.unavailable.reason}: ${price.unavailable.detail})`);
      return { chunks: [], sent };
    }
    for (const [i, lamports] of chunks.entries()) {
      if (this.stopped) break;
      if (!this.cfg.tokenMint) {
        this.log.warn("buyback: TOKEN_MINT unset — cannot quote");
        break;
      }
      // Fresh quote right before each chunk: min-out bounds slippage and sandwich profit.
      let q;
      try {
        q = await jupiterQuote(this.cfg.jupiterApiUrl, this.cfg.tokenMint, lamports, this.cfg.slippageBps);
      } catch (e) {
        this.log.warn(`buyback chunk ${i}: quote failed: ${(e as Error).message}`);
        break;
      }
      const impact = Number(q.priceImpactPct) * 100;
      if (impact > this.cfg.maxPriceImpactPct) {
        this.log.warn(`buyback chunk ${i}: price impact ${impact.toFixed(3)}% > cap ${this.cfg.maxPriceImpactPct}% — stopping run`);
        break;
      }
      const minOut = BigInt(q.otherAmountThreshold);
      // ExactIn swap: lamports actually consumed by Jupiter (record_buyback_burn refunds the rest).
      const lamportsSpent = BigInt(q.inAmount);
      // The program rejects the record if tokens < lamports_spent * 1e18 / EMA * (1 - slippage).
      if (price && this.onchainSlippageBps !== null) {
        const chainMin = minBuybackTokens(lamportsSpent, price.ema, this.onchainSlippageBps);
        if (minOut < chainMin) {
          this.log.warn(`buyback chunk ${i}: jupiter minOut ${minOut} < on-chain minimum ${chainMin} — skipping (route too thin or price moved)`);
          continue;
        }
      }
      // Leftover tokens from earlier runs (swap output above minOut) are burned along with this chunk.
      const leftover = await this.keeperTokenBalance();
      const tokensToBurn = minOut + leftover;
      const release = await this.actions.releaseBuybackIxs(this.keeperKey, lamports);
      const record = await this.actions.recordBuybackBurnIxs(this.keeperKey, lamportsSpent, tokensToBurn);
      if (!release || !record) {
        this.log.warn(
          `buyback chunk ${i}: no program configured; planned ${lamports} lamports -> burn >= ${tokensToBurn} tokens (impact ${impact.toFixed(3)}%)`,
        );
        continue;
      }
      // One atomic tx: release -> Jupiter swap -> record (program burns + checks + refunds).
      // If the swap underdelivers, the whole tx reverts and no SOL leaves the vault.
      const swap = await jupiterSwapInstructions(this.conn, this.cfg.jupiterApiUrl, q, this.keeperKey);
      const sig = await sendIxs(
        this.conn, this.payer ?? Keypair.generate(), [...release, ...swap.ixs, ...record], this.sendOpts, this.log,
        `buyback#${i}`, swap.lookupTables,
      );
      if (sig) sent.push(sig);
      if (i < chunks.length - 1) await this.sleep(jittered(this.cfg.chunkDelayMs.min, this.cfg.chunkDelayMs.jitter));
    }
    return { chunks, sent };
  }

  start() {
    const crank = async () => {
      try {
        await this.crankOnce();
      } catch (e) {
        this.log.error("crank", e);
      }
    };
    void crank();
    this.timers.push(setInterval(crank, this.cfg.crankIntervalMs));
    const scheduleBuyback = () => {
      if (this.stopped) return;
      const delay = jittered(this.cfg.buybackIntervalMs, this.cfg.buybackJitterMs);
      this.log.info(`next buyback in ${Math.round(delay / 1000)}s`);
      this.timers.push(
        setTimeout(async () => {
          try {
            await this.buybackOnce();
          } catch (e) {
            this.log.error("buyback", e);
          }
          scheduleBuyback();
        }, delay),
      );
    };
    scheduleBuyback();
  }

  stop() {
    this.stopped = true;
    this.timers.forEach((t) => clearTimeout(t));
  }
}
