/**
 * The launch phase, in one place. Buyback-and-burn and paying with $PXL arrive together with a later program upgrade.
 * Set BUYBACK_PHASE to "live" and all of the phase copy reverts. Client components read it through `useBuybacksLive` (lib/usePhase.ts) and server
 * code through `getBuybacksLive`, so moving to `buybackPhase` on /api/stats later only changes those two functions.
 * services/src/card/render.ts holds the same wording for the server-rendered card.
 */
import { BRAND } from "./config";
import type { Stats } from "./types";

export const BUYBACK_PHASE = "later" as "live" | "later";
export const BUYBACKS_LIVE = BUYBACK_PHASE === "live";

/** The owner's brand line. Where it stands alone in this phase, PHASE_LINE stands beside it. */
export const TAGLINE = "A million pixels. Half of every dollar burns.";
export const COMING_SOON = `Buybacks and ${BRAND.ticker} payments are coming soon.`;
export const PHASE_LINE = `Half of every SOL payment goes to the buyback vault. ${COMING_SOON}`;
/** One-line description for previews, where nothing can stand beside the tagline. */
export const socialLine = (live: boolean) => (live ? TAGLINE : `A million pixels on Solana. ${PHASE_LINE}`);

/** SOL in the buyback vault from purchases, as the indexer reports it (without the account's rent). */
export function vaultLamports(s: Pick<Stats, "lamportsToBuyback" | "lamportsSpentBuyback">) {
  const left = BigInt(s.lamportsToBuyback) - BigInt(s.lamportsSpentBuyback);
  return left > 0n ? left : 0n;
}

/** Metadata and server pages. */
export const getBuybacksLive = async () => BUYBACKS_LIVE;
