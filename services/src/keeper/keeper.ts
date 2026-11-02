import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { CU_LIMITS } from "@mpb/sdk";
import type { ChainReader } from "../chain/accounts.js";
import type { Logger } from "../lib/log.js";
import { sendIxs, type KeeperActions, type SendOptions } from "./actions.js";
import type { SwapPlan, SwapRoute } from "./routes.js";
import { checkDeviation, jittered, minBuybackTokens, planBuybackChunks } from "./plan.js";

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
  /** Skip when spot is (or would be) more than this % above the fast EMA (program pauses token pay at 15%). */
  maxSpotOverEmaPct: number;
  /** Cap on the projected cumulative spot increase caused by one run. */
  maxRunPriceMovePct: number;
  /** KEEPER_BUYBACK_ENABLED: false = crank only. */
  buybackEnabled: boolean;
  /** Leave an outstanding release alone for this long (someone may be mid-way through a manual run). */
  outstandingGraceSecs: number;
  /** Dry-run: simulate built txs (needs a keypair or pubkey with the keeper role). */
  simulateInDryRun?: boolean;
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
    /** Buy routes in priority order (see routes.ts), or a resolver re-evaluated every run. */
    private readonly routes: SwapRoute[] | (() => Promise<SwapRoute[]>) = [],
  ) {
    if (cfg.live && !payer) throw new Error("KEEPER_LIVE=1 requires KEEPER_KEYPAIR");
    this.sendOpts = { live: cfg.live, jito: cfg.jito, simulateInDryRun: cfg.simulateInDryRun ?? false };
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
    const sig = await sendIxs(this.conn, this.payer ?? Keypair.generate(), ixs, { ...this.sendOpts, computeUnitLimit: CU_LIMITS.crankTokenPrice }, this.log, "crank_token_price");
    if (sig) this.log.info(`crank_token_price confirmed ${sig}`);
    return sig;
  }

  /**
   * An outstanding release blocks every later release_buyback. Our own buybacks are atomic and can't
   * leave one, so this only happens after an external/manual release or a crash. Once it is older than
   * `outstandingGraceSecs` (so a human's 3-step run isn't interrupted), resume it the way the chain's
   * devnet-verify does: buy with the outstanding lamports and record (no new release). If no route can
   * buy it, refund it with record_buyback_burn(0, 0).
   */
  async resolveOutstanding(sent: string[]): Promise<"none" | "waiting" | "resolved"> {
    const o = (await this.chain?.fetchBuybackOutstanding?.().catch(() => null)) ?? null;
    if (!o || o.lamports === 0n) return "none";
    if (o.sinceSecs < this.cfg.outstandingGraceSecs) {
      this.log.warn(`buyback: release of ${o.lamports} lamports outstanding for ${o.sinceSecs}s (< ${this.cfg.outstandingGraceSecs}s grace) — waiting, not releasing`);
      return "waiting";
    }
    const routes = typeof this.routes === "function" ? await this.routes().catch(() => []) : this.routes;
    let plan: SwapPlan | null = null;
    for (const r of routes) {
      plan = await r.plan(o.lamports, this.keeperKey);
      if (plan) break;
    }
    let ixs: TransactionInstruction[] | null;
    let what: string;
    if (plan && plan.impactPct <= this.cfg.maxPriceImpactPct) {
      const leftover = await this.keeperTokenBalance();
      const record = await this.actions.recordBuybackBurnIxs(this.keeperKey, plan.lamportsSpent, plan.minTokensOut + leftover);
      ixs = record ? [...(await plan.build()).ixs, ...record] : null;
      what = `resume via ${plan.route}: spend ${plan.lamportsSpent}, burn ${plan.minTokensOut + leftover}`;
    } else {
      ixs = await this.actions.recordBuybackBurnIxs(this.keeperKey, 0n, 0n);
      what = "refund (record_buyback_burn 0, 0): no usable buy route";
    }
    if (!ixs) return "waiting";
    this.log.warn(`buyback: outstanding release of ${o.lamports} lamports — ${what}`);
    const sig = await sendIxs(this.conn, this.payer ?? Keypair.generate(), ixs, this.sendOpts, this.log, "buyback-resolve-outstanding");
    if (sig) {
      sent.push(sig);
      this.log.info(`buyback: outstanding release resolved ${sig}`);
    }
    return "resolved";
  }

  async buybackOnce(): Promise<{ chunks: bigint[]; sent: string[] }> {
    const sent: string[] = [];
    if (!this.cfg.buybackEnabled) {
      this.log.info("buyback: disabled (KEEPER_BUYBACK_ENABLED=0); cranking continues");
      return { chunks: [], sent };
    }
    const outstanding = await this.resolveOutstanding(sent).catch((e) => {
      this.log.error(`buyback: resolving outstanding release failed: ${(e as Error).message}`);
      return "waiting" as const;
    });
    if (outstanding !== "none") return { chunks: [], sent }; // never release while one is open
    const vault = (await this.chain?.fetchBuybackVaultLamports().catch(() => null)) ?? null;
    if (vault === null) {
      this.log.warn("buyback: vault balance unavailable (PROGRAM_ID unset or vault missing) — skipped");
      return { chunks: [], sent };
    }
    const runRoutes = typeof this.routes === "function" ? await this.routes().catch(() => []) : this.routes;
    // Cap each buy at a small fraction of the route's effective quote reserves (≈ 1% price impact),
    // so a thin pool is bought back over many cycles instead of being pushed in one.
    let maxChunk = this.cfg.maxChunkLamports;
    const routeCap = runRoutes[0]?.maxQuoteIn ? await runRoutes[0].maxQuoteIn().catch(() => null) : null;
    if (routeCap !== null && routeCap < maxChunk) maxChunk = routeCap;
    if (maxChunk < this.cfg.minChunkLamports) {
      this.log.warn(`buyback: ${runRoutes[0]?.name} reserves too thin (max buy ${maxChunk} < min chunk ${this.cfg.minChunkLamports} lamports) — skipped, nothing released`);
      return { chunks: [], sent };
    }
    // Never plan more than the on-chain token bucket currently allows (release would fail anyway).
    const releasable = (await this.chain?.fetchBuybackReleasable?.().catch(() => null)) ?? null;
    const perRun = releasable !== null && releasable < this.cfg.maxPerRunLamports ? releasable : this.cfg.maxPerRunLamports;
    const chunks = planBuybackChunks({
      vaultLamports: vault,
      reserveLamports: this.cfg.reserveLamports,
      maxPerRunLamports: perRun,
      minChunkLamports: this.cfg.minChunkLamports,
      maxChunkLamports: maxChunk,
    });
    this.log.info(`buyback: vault=${vault} releasable=${releasable ?? "?"} lamports, plan=${chunks.length} chunks [${chunks.join(", ")}]${this.cfg.live ? "" : " (dry-run)"}`);
    const price = (await this.chain?.fetchTokenPrice().catch(() => null)) ?? null;
    // record_buyback_burn needs a warmed-up, fresh EMA; don't release SOL we can't reconcile.
    if (price?.unavailable && price.unavailable.reason !== "deviation") {
      this.log.warn(`buyback: skipped, token EMA not usable (${price.unavailable.reason}: ${price.unavailable.detail})`);
      return { chunks: [], sent };
    }
    // Deviation guard: token payments pause when spot > fast EMA x 1.15 (one-sided band). A buyback
    // pushes spot UP, so it must never be the thing that trips that band. Two limits per run:
    //  - skip if spot is already more than maxSpotOverEmaPct above the fast EMA (now, or projected
    //    after the next chunk);
    //  - cap the run's cumulative projected spot increase at maxRunPriceMovePct.
    let runFactor = 1; // product of projected per-chunk spot multipliers
    for (const [i, lamports] of chunks.entries()) {
      if (this.stopped) break;
      const now = i === 0 ? price : ((await this.chain?.fetchTokenPrice().catch(() => null)) ?? price);
      // Fresh plan right before each chunk (min-out bounds slippage and sandwich profit).
      // Routes in priority order: pump curve while the token is on the curve, then Jupiter.
      let plan: SwapPlan | null = null;
      const routes = runRoutes;
      for (const r of routes) {
        plan = await r.plan(lamports, this.keeperKey);
        if (plan) break;
      }
      if (!plan) {
        // No release happens without a swap: the chunk (and run) is simply skipped.
        this.log.warn(`buyback chunk ${i}: no buy route available (${routes.map((r) => r.name).join(", ") || "none"}) — skipping run`);
        break;
      }
      if (plan.impactPct > this.cfg.maxPriceImpactPct) {
        this.log.warn(`buyback chunk ${i}: ${plan.route} price impact ${plan.impactPct.toFixed(3)}% > cap ${this.cfg.maxPriceImpactPct}% — stopping run`);
        break;
      }
      const guard = checkDeviation({
        spotQ: now?.spot ?? null, emaQ: now?.ema ?? null, impactPct: plan.impactPct, quoteFractionPct: plan.quoteFractionPct, runFactor,
        maxSpotOverEmaPct: this.cfg.maxSpotOverEmaPct, maxRunPriceMovePct: this.cfg.maxRunPriceMovePct,
      });
      if (!guard.ok) {
        this.log.warn(`buyback chunk ${i}: ${guard.reason} — stopping run (nothing released)`);
        break;
      }
      runFactor = guard.runFactor;
      // The program rejects the record if tokens < lamports_spent * 1e18 / EMA * (1 - slippage).
      if (price && this.onchainSlippageBps !== null) {
        const chainMin = minBuybackTokens(plan.lamportsSpent, price.ema, this.onchainSlippageBps);
        if (plan.minTokensOut < chainMin) {
          this.log.warn(`buyback chunk ${i}: ${plan.route} min-out ${plan.minTokensOut} < on-chain minimum ${chainMin} — skipping`);
          continue;
        }
      }
      // Leftover tokens from earlier runs (swap output above min-out) are burned along with this chunk.
      const leftover = await this.keeperTokenBalance();
      const tokensToBurn = plan.minTokensOut + leftover;
      const release = await this.actions.releaseBuybackIxs(this.keeperKey, lamports);
      const record = await this.actions.recordBuybackBurnIxs(this.keeperKey, plan.lamportsSpent, tokensToBurn);
      if (!release || !record) {
        this.log.warn(`buyback chunk ${i}: no program configured; planned ${lamports} lamports via ${plan.route} -> burn >= ${tokensToBurn}`);
        continue;
      }
      // ONE atomic tx: release -> swap -> record (program burns, checks the EMA bar, refunds unspent SOL).
      // If any leg fails the whole tx reverts and no SOL leaves the vault; release is never sent alone.
      const swap = await plan.build();
      this.log.info(
        `buyback chunk ${i}: ${plan.route} release ${lamports}, spend ${plan.lamportsSpent}, burn ${tokensToBurn} (impact ${plan.impactPct.toFixed(2)}%)`,
      );
      const sig = await sendIxs(
        this.conn, this.payer ?? Keypair.generate(), [...release, ...swap.ixs, ...record], this.sendOpts, this.log,
        `buyback#${i}`, swap.lookupTables,
      );
      if (sig) {
        sent.push(sig);
        this.log.info(`buyback chunk ${i}: confirmed ${sig}`);
      }
      if (i < chunks.length - 1) await this.sleep(jittered(this.cfg.chunkDelayMs.min, this.cfg.chunkDelayMs.jitter));
    }
    return { chunks, sent };
  }

  start() {
    const crank = async () => {
      try {
        await this.crankOnce();
      } catch (e) {
        const msg = (e as Error).message;
        // 6015 CrankTooSoon: someone else cranked within the 30 s minimum. The EMA is fresh; not an error.
        if (/"Custom":6015|CrankTooSoon/.test(msg)) this.log.info("crank_token_price: skipped, cranked by someone else < 30 s ago (6015 CrankTooSoon)");
        else this.log.error(`crank_token_price failed: ${msg.slice(0, 400)}`);
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
