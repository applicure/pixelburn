# chain/ — `pixel` program: notes

Owner: chain agent. Anchor 1.1.2 workspace, program `pixel` (`programs/pixel`), LiteSVM test suite, devnet scripts.
The TS client lives in `packages/sdk` (`@mpb/sdk`).

## How to build and test

```bash
cd chain
anchor build                      # SBF build + IDL (target/idl/pixel.json, target/types/pixel.ts)
anchor test                       # = anchor build + cargo test (Anchor.toml [scripts] test; no validator needed)
cargo test                        # unit tests (src/math.rs) + LiteSVM integration tests (tests/all/*)
cargo clippy --all-targets        # clean

cd ../packages/sdk
pnpm sync-idl                     # copy IDL + types from chain/target after a program change
pnpm build && pnpm test           # vitest, incl. an SDK-vs-compiled-program LiteSVM test
```

The integration tests load `target/deploy/pixel.so`, so run `anchor build` before `cargo test` after any program change.

## Architecture

### PDAs
| Account | Seeds | Size (bytes, incl. 8-byte discriminator) | Rent |
|---|---|---|---|
| `Config` | `["config"]` | 544 (32 reserved) | ~0.0044 SOL |
| `Canvas` | `["canvas"]` | 1,321 | ~0.0101 SOL |
| `Ad` (rect) | `["ad", block_index u16 LE]`, where block_index = y*100+x of the top-left block | 599 (strings at max length) | ~0.0051 SOL, paid by the buyer |
| `Ad` (auction lot) | `["ad_auction"]` | 599 | paid by the settler |
| `Auction` | `["auction"]` | 1,326 | ~0.0101 SOL, paid by whoever starts it |
| buyback vault | `["buyback_vault"]` | 0 (system-owned SOL holder) | rent-exempt minimum funded at `initialize` |

Ad addressing: the address comes from the ad's top-left block, not from a global counter. Blocks are exclusive, so two
buyers can only collide when they want the same block, which has to fail anyway. Disjoint purchases built against the same
state all land (tested in Rust and in the SDK). `Ad.id` is still the display counter (`canvas.next_ad_id`, assigned inside
the ix). `AdPurchased`, `AdUpdated`, `AdTransferred` and `AuctionSettled` carry the account address `ad: Pubkey`.
`update_ad` and `transfer_ad` accept any program-owned `Ad` account (owner + discriminator checked by `Account<Ad>`), with
`has_one = owner`. A buy whose top-left block is already some ad's top-left fails in `init` with "account already in use"
(code 0) rather than `Overlap`. UIs should pre-check with `isRectFree`.

Bitmap: block index `i = by*100 + bx`; bit `i` is byte `i>>3`, bit `i&7` (LSB first). 10,000 bits = 1,250 bytes, no padding.
Invariant (checked when the auction starts): `popcount(canvas.bitmap) == canvas.sold_blocks`.

Overlap check (`math::is_rect_free` / `mark_rect`) works per row on byte masks, about 13 byte operations per row instead of
one per block. A full 100×100 purchase costs about 116k CU, which fits the default 200k budget.

### Instructions
| Instruction | Who | Notes |
|---|---|---|
| `initialize(params)` | program **upgrade authority** only | checks `program.programdata_address == program_data` and `program_data.upgrade_authority == admin`, which blocks init front-running. Funds the vault to rent-exempt. Takes the admin-supplied EMA seed `initial_token_ema_price_sol` (0 = token payments off). |
| `set_treasury`, `set_keeper`, `set_params`, `propose_admin` | admin (`has_one = admin`) | `set_params` = max price age (1..=300 s), hourly buyback cap (≤ 50 SOL hard ceiling), keeper slippage (≤ 50%). |
| `set_price_source(source, initial_ema)` | admin | the source must be the canonical curve PDA or the canonical PumpSwap migration pool + its ATAs. Re-seeds the EMA with the admin value; warm-up restarts. |
| `set_paused(paused)` | admin | always receives the `["auction"]` PDA. Pausing records `paused_at`; unpausing extends an active auction to `max(end + paused, now + 10 min)`. |
| `accept_admin` | pending admin | two-step admin transfer |
| `buy_with_sol(x,y,w,h,title,link,image_uri,image_sha256,max_lamports)` | anyone | Pyth SOL/USD, 50/50 split, odd lamport goes to the buyback vault |
| `buy_with_token(…, max_tokens)` | anyone | 10% discount, price = min(spot, EMA), burns 100% via `token_interface::burn` (SPL Token or Token-2022) |
| `crank_token_price()` | anyone | ≥ 30 s between updates, at most one per slot, EMA must be seeded; moves the EMA ≤ 2% (see Token EMA) |
| `release_buyback(lamports)` | keeper | rate-limited fallback, see below |
| `record_buyback_burn(lamports_spent, tokens_burned)` | keeper | program performs the burn itself, so it is verified |
| `update_ad`, `transfer_ad` | ad owner (`has_one = owner`) | the rectangle is immutable |
| `start_final_auction` | anyone, once `sold_blocks ≥ 9,900` | snapshots the free blocks into `Auction.lot_bitmap` |
| `bid_final_auction(lamports)` | anyone | escrowed in the auction PDA; the previous bidder is refunded in the same instruction |
| `restart_final_auction` | anyone, after the end with zero bids, not while paused | another 72 h |
| `settle_final_auction` | anyone, after the end, not while paused | 100% of the bid goes to the buyback vault; creates the winner's `Ad` (kind `AuctionLot`); canvas becomes full |

Events: `AdPurchased`, `AdUpdated`, `AdTransferred`, `TokenPriceUpdated`, `BuybackBurned`, `AuctionStarted`, `AuctionBid`,
`AuctionSettled` as in SPEC, plus `BuybackReleased`, `BuybackWrittenOff`, `AuctionRestarted` and `AuctionResumed{end_ts, paused_secs}`. On settle, an `AdPurchased`
with `pay_mode = Auction` and `x=y=w=h=0` is also emitted, so an indexer that only follows `AdPurchased` still sees the
winner's ad.

### Pricing math (`src/math.rs`, mirrored 1:1 in `@mpb/sdk` `quote.ts`)
- USD: `w*h * 100_000_000` micro-USD.
- SOL: Pyth `SOL/USD = price * 10^expo`, so `lamports = ceil(usd_micro * 10^(3-expo) / price)`.
- Split: `treasury = floor(lamports * 5000 / 10000)` and `buyback = lamports - treasury`. The parts always sum exactly, and the remainder goes to buyback.
- Token: `usd_disc = ceil(usd * 9000 / 10000)`, then `lamports_equiv` as above, then `tokens = ceil(lamports_equiv * 1e18 / min(spot_q, ema_q))`.
  Every rounding step favours the protocol.
- Token price fixed point: **lamports per token base unit × 1e18** (`u128`). SPEC says "SOL per base unit": this is the same
  quantity expressed in lamports, so 1 SOL/base unit = 1e9 × 1e18.
- EMA (after audit H-1): `spot_c = clamp(spot, ema·0.6, ema·1.4)`, then `ema += (spot_c − ema) × 5%`. Alpha is fixed (30 s / 600 s) whatever the gap since the last crank, so one crank moves the EMA at most **±2%**. There is no seeding from spot: the admin supplies the seed.

### Oracles
- **Pyth**: `Account<PriceUpdateV2>` checks owner = Pyth receiver (`rec5EKMG…`) and the discriminator.
  `get_price_no_older_than(clock, config.max_price_age_secs, config.pyth_feed_id)` enforces feed id, staleness and
  **Full** Wormhole verification. On top of that the program rejects `price <= 0`, `conf > 2% of price`, and exponents outside [-18, 6].
- **Token spot**:
  - `BondingCurve{curve}`: owner must be the pump program `6EF8rrec…`; discriminator `[23,183,248,55,96,216,172,96]`;
    `complete == false`; `quote_mint` (offset 83, appended field) must be default or WSOL, and a shorter legacy account counts as SOL.
    `spot = virtual_quote_reserves(16) / virtual_token_reserves(8)`. At config time the curve must equal the canonical PDA
    `["bonding-curve", token_mint]` under the pump program, because the curve account does not store its mint.
  - `Pool{pool, base_vault, quote_vault}`: pool owner = PumpSwap `pAMMBay6…` with discriminator `[241,154,109,4,17,177,109,188]`.
    The pool's stored `base_mint` must be our mint, `quote_mint` must be WSOL, and its stored vault addresses must equal the
    config's. Vaults are owned by SPL Token or Token-2022 and their mints are checked.
    `effective_quote = quote_vault.amount + pool.virtual_quote_reserves (i128, offset 245, may be negative, missing = 0)`.
- **Token EMA rules** (rewritten after audit H-1; regression tests in `tests/all/security.rs`):
  1. **Admin seed only.** `initialize` and `set_price_source` take `initial_ema` from the admin; a crank on an unseeded EMA fails. The first crank after a (re)seed requires spot within ±25% of the seed (`EmaSeedMismatch`). The lead asked for the band check at configuration time; it happens at this first crank instead, because `initialize` does not take reserve accounts.
  2. **Warm-up.** Token buys and keeper reconciliation need ≥ 10 cranks spanning ≥ 600 s since the seed (`EmaWarmingUp`).
  3. **Bounded step.** Each crank uses a fixed alpha of 5% with spot clamped to ±40%, so the EMA moves at most ±2% per crank. Cranks are ≥ 30 s apart and limited to one per slot.
  4. **Deviation guard (one-sided, round 3).** `buy_with_token` is rejected only while `spot > fast EMA × 1.15` (`PriceDeviationTooHigh`). Spot *below* the EMA is allowed: min() then charges the buyer at spot, which means more tokens, so it is safe. Token buys keep working in a crash and the DoS surface is halved. Tested in `round3_one_sided_band`.
  5. **Same-slot rule.** If the EMA was cranked in the current slot, the buy uses the pre-crank value.
  6. **Freshness.** The EMA must be ≤ 900 s old.
  7. **Slow EMA (audit round 2, "ratchet").** A second EMA with a 4 h window: alpha = 30 s / 14,400 s = 1/480 per crank, the same ±40% clamp, so at most +0.083% per crank. It is seeded together with the fast EMA, shares the same warm-up and the same same-slot rule, and is emitted in `TokenPriceUpdated.slow_ema`.
  8. **Price charged** = `min(spot, fast EMA, slow EMA)`. The one-sided 15% guard applies to the fast EMA.
  9. **Token-paid block cap.** A token bucket allows 1,000 blocks/hour by default ($100k/h at list price). Admin-settable via `set_params`, hard max 5,000. SOL buys are uncapped. Error `TokenBuyCapExceeded`. A single token purchase larger than the cap is impossible, so big rectangles have to be paid in SOL.
- **Worst case for a held pump (auditor scenario D).** The attacker keeps spot ≥ +40% above both EMAs through every crank, then partially unwinds into the 15% band of the fast EMA just before buying. The slow EMA bounds the price. Computed with the program's own `slow_ema_update` (`round2_worst_case_table`) and asserted end-to-end for 10/30/60 cranks (`round2_scenario_d_*`, which hit the bound exactly):

  | pump held at ≥ +40% | cranks | slow EMA ≤ | buyer burns ≥ (vs honest) | before round 2 |
  |---|---|---|---|---|
  | 5 min | 10 | ×1.0084 | **99.2%** | 82.9% |
  | 15 min | 30 | ×1.0253 | **97.5%** | 55.8% |
  | 30 min | 60 | ×1.0512 | **95.1%** | 31.2% |
  | 60 min | 120 | ×1.1051 | **90.5%** | – |
  | 4 h | 480 | ×1.4916 | 67.0% | – |

  - Holding a market +40% above fair for an hour costs real capital and is arbitraged against the whole time.
  - What one episode can extract is capped by the block limit: at most 1,000 token-paid blocks per hour × $90 × the discount above. That is ≤ ~$8.5k of under-burn per hour of a one-hour +40% hold.
  - The earlier "≥ 87%" claim was wrong: it ignored the crank-time ratchet the auditor found.
- **Auditor scenarios D′ and A′ (round 3; asserted, measured against the compiled program, each at its model bound):**

  | scenario | 5 min | 15 min | 30 min | 60 min |
  |---|---|---|---|---|
  | D (hold ≥ +40%, unwind into the band, buy) | 99.2% | 97.5% | 95.1% | 90.5% (bound) |
  | D′ (in-band ramp: spot = fast EMA × 1.149 before every crank, never rejected) | 99.6% | 98.3% | 95.9% | 91.2% (bound) |
  | A′ (first crank at +24%, inside the seed band, held through a 21-crank warm-up) | 98.98% | – | – | – |

  D′ ratchets the fast EMA by 0.745% per crank without ever leaving the band. The slow EMA follows the rising spot at 1/480 of the gap per crank and sets the price.
- **Trade-off of the slow EMA.** After a genuine rally, token buyers are priced at the lagging slow EMA. They pay *more* tokens than spot implies (a 2x rally takes about 7 h to be fully reflected). This fails safe for the protocol; buyers see it in the quote (`tokenPricingStatus().pricedBy === "slowEma"`) and are protected by `max_tokens`.
- **Ops: fail-safe liveness cases.**
  - A genuine *upward* move of more than 15% blocks token buys until the fast EMA catches up, at 2% per 30 s. Downward moves never block (one-sided band).
  - **Seed-band DoS (documented, accepted).** An attacker who holds spot more than 25% away from a fresh seed makes every first crank fail with `EmaSeedMismatch`. Token payments stay off, which fails safe: nothing is mispriced, SOL buys keep working, and the attacker pays to hold the price. Recovery: the admin re-seeds via `set_price_source` at the current market value once the price is stable (or once the move is genuine).
  - If spot moves more than 25% between a (re)seed and the first crank, every crank fails with `EmaSeedMismatch` until the admin re-seeds via `set_price_source` with a current value.
  - SOL buys are unaffected in both cases.

Layout sources (fetched 2026-11-02):
- https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json (`BondingCurve`)
- https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json (`Pool`)
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md and `PUMP_SWAP_README.md#quoting-effective-quote-reserves` (effective reserves)
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md (appended curve fields, `quote_mint` default = SOL)
- `pyth-solana-receiver-sdk` 2.0.0 (`PriceUpdateV2`, `get_price_no_older_than`)

## Buyback design: keeper fallback (no atomic CPI in v1)

**Choice:** I shipped SPEC's fallback, not the atomic `buyback_and_burn` CPI.

**Why:** pump.fun `buy` currently takes 16 accounts and PumpSwap `buy` takes 23 (fee program, fee config, global and user
volume accumulators, creator vaults…). The public IDL shows that list has changed repeatedly over 2025–26 (fee program
and fee config, cashback, mayhem mode, v2/v3 trade instructions). A hard-coded CPI would break the next time pump changes
the list, and testing it properly means cloning the live mainnet programs plus a dozen config accounts into a validator.
I did not build or test that, and an untested CPI that moves treasury SOL is worse than a bounded, verifiable keeper.

**Flow:**
1. `release_buyback(lamports)`, keeper only:
   - Paused: rejected.
   - Token bucket (after audit L-1), **not a rolling window**: the allowance refills at `cap`/3600 per second, up to `cap`. Bursts are ≤ cap, sustained releases ≤ cap/hour, and any single hour can reach **2 × cap** (a full bucket plus one hour of refill). The old fixed window allowed 2 × cap within seconds at the window edge. The admin can change the cap, but never above 50 SOL.
   - Rejected while a previous release is unreconciled, so at most one release is ever outstanding.
   - The vault never drops below rent-exempt.
   - Lamports go from the vault to the keeper wallet.
2. The keeper buys on pump.fun or PumpSwap off-chain (services/keeper).
3. `record_buyback_burn(lamports_spent, tokens_burned)`:
   - `lamports_spent ≤ outstanding`, and the unspent remainder is pulled back into the vault in the same instruction.
   - The **program** burns `tokens_burned` from the keeper's token account via CPI, so the supply drop is verified on-chain.
   - It requires `tokens_burned ≥ lamports_spent / EMA × (1 − buyback_max_slippage_bps)`.
   - The EMA is the pre-slot value, must be warmed up and under 900 s old. Spot is deliberately not used, because the keeper could pump spot in the same transaction to lower the bar (tested).
   - **Why the keeper bar uses only the fast EMA** (not the slow one, and not min/max): the bar must track a genuine rally within minutes. Against the 4 h slow EMA, a keeper buying after a +30% rally would fail the check for hours and buybacks would stall. The fast EMA's manipulation bound is analysed below, and the release cap bounds the stake.
   - Re-derived floor under the H-1 rules: within one transaction the keeper cannot move the EMA. Dragging it up takes holding a pump for ≥ 30 s per +2%, so after 10 cranks (≥ 5 min of a held 4x pump) the EMA is ≤ +21.9% and the bar is ≥ 0.85 / 1.219 ≈ 69.7% of fair. Tested in `h1_keeper_dragging_ema_is_bounded`. Before the fix, the PoC took the EMA to 4x, a bar of ~21%.
   - **Post-trade price backstop (round 4, lead-approved, auditor: SHIP; not yet deployed to devnet):** when `lamports_spent > 0`, the instruction reads spot from the *configured* price source and requires `spot ≤ fast EMA × 1.12`, three points inside the 15% token-buy band. The source is the curve, or the pool plus both vaults, key-checked against `config.price_source`, so the accounts cannot be substituted.
     - **Claim (precise wording):** the keeper's atomic release → swap → record flow cannot push spot past fast EMA × 1.12. If it would, the whole transaction reverts: vault, allowance and supply are unchanged, and no release is left outstanding.
     - **This is a safety rail for the honest keeper, not an adversarial control.** Nothing on-chain ties the record to the swap (the same is true of the rate bar). A malicious keeper could swap in a separate transaction, then record later once spot is back inside the band. The trust model for a malicious keeper is unchanged: the cap per release and the hourly bucket.
     - Why: on devnet a 0.019 SOL PumpSwap buy moved a thin pool +3.8% and paused token payments for users.
     - Consequence: while spot is already above the band for external reasons (for example a pump boost wave), buybacks with spend wait. They fail closed.
     - Tests: `backstop_buyback_cannot_push_spot_out_of_band_{curve,pool}` (+13% reverts atomically, +12% and +5% pass, a refund always passes) and `backstop_rejects_substituted_price_accounts`.
     - CU delta: `record_buyback_burn` went 24.6k → 26.7k (SPL/curve) and 21.3k → 24.7k (T22/pool), under the 40k SDK limit.
     - SDK `recordBuybackBurnIx` now requires `priceSource`.
   - **What to claim as `lamports_spent`:** the quote actually swapped, capped at the outstanding release. Not the keeper's balance drop: the first PumpSwap buy also pays one-time account rent (user volume accumulator, ~2.9M lamports), and claiming that failed with `BuybackAmountTooHigh` on devnet.
   - A pure refund (`lamports_spent = 0`) needs no price.
   - It updates `lamports_spent_buyback` and `tokens_burned_buyback`, and emits `BuybackBurned`.
4. `set_keeper` always works. An unreconciled release is moved to `buyback_written_off_lamports` and `BuybackWrittenOff`
   is emitted, so a rogue keeper cannot block rotation.

**Trust model:**
- **The keeper alone** can steal at most one release (≤ hourly cap), and only by never recording it. That shows up on-chain
  as `buyback_outstanding_lamports > 0` without a `BuybackBurned` event.
- **The keeper can underpay** by up to `buyback_max_slippage_bps` (default 15%) against the EMA. A dishonest keeper could
  pocket that margin. An honest one needs it for pump fees (~1.25%) and price impact.
- **Admin and keeper together** (admin can appoint a keeper) can drain the vault at ≤ 50 SOL/hour, visibly. Recommended
  mitigation: admin = Squads multisig with a timelock; keeper = a dedicated hot key holding no other funds.
- **Upgrade authority = admin (audit M-2.1).** `initialize` requires the admin to be the program's upgrade authority, so until that authority is moved, the admin can upgrade the program and take anything: vault, auction escrow. **Launch requirement:** after `initialize`, transfer the upgrade authority to a timelocked Squads multisig, or make the program immutable (`solana program set-upgrade-authority --final`). Everything under "What no one can do" assumes that has happened.
- **Pause freezes buyback releases (audit M-2.3).** `release_buyback` is pausable. A pause does not move funds, but the vault cannot be spent on buybacks until unpause. Bids and settlement are also frozen while paused; the auction clock is compensated on unpause.
- **What no one can do** (given the launch requirement above):
  - The admin cannot withdraw from the vault directly.
  - The treasury share is paid out at purchase time.
  - Auction proceeds go straight to the vault.
  - Token-payment burns happen in the buyer's own transaction.
- **Upgrade path:** add an atomic `buyback_and_burn` once the pump CPI account list is stable, and retire the keeper with `set_params(cap = 0)`.

## Final auction
- Opens when `sold_blocks ≥ 9,900`. Fixed-price sales stop once `sold_blocks ≥ 9,900` before a purchase, so the purchase that crosses the threshold is allowed (tested: 9,899 → 9,901).
- The lot is the complement of the bitmap at start. It cannot change afterwards because sales are closed.
- Opening bid ≥ 0.1 SOL. Each new bid must beat the current one by at least max(5%, 0.01 SOL).
- The current highest bidder cannot outbid themselves. This also avoids Anchor 1.x's duplicate-mutable-account check on `bidder == previous_bidder`.
- Anti-sniping: a bid in the last 10 minutes moves the end to now + 10 minutes.
- Settle is permissionless. If nobody bid, `restart_final_auction` runs it again for 72 h.
- If one purchase fills all 10,000 blocks, there is nothing to auction (`NothingToAuction`).
- **Pause (after audit M-1).** While paused, bids, settle and restart are all rejected. Unpausing an auction that was **still live when the pause began** (`end_ts > paused_at`) sets `end_ts = max(end_ts + paused_duration, now + 10 min)`, so a pause can never hand the lot to the current leader. An auction that had already ended (`end_ts ≤ paused_at`) stays ended: a pause can never reopen a won auction (audit round 2; test `round2_pause_after_end_cannot_reopen_auction`). Re-pausing while already paused keeps the original `paused_at`. Tested in `m1_*`.
- **Write-lock flooding (audit L-3, accepted).** An attacker can fill the per-block write-lock compute budget on the auction PDA in the last 10 minutes to stop outbids from landing. There is no on-chain fix. Each successful extension costs the attacker about 10 minutes of sustained block-space spend, and bidders should use priority fees. Documented risk.

## Security self-review (attack, then how it is blocked; "T" = covered by a test)
1. **Init front-running** (someone else initialises with their own admin or treasury): only the upgrade authority can initialise. T
2. **Overlap / double-sell**: per-row byte-mask check, then mark, in the same instruction. Randomised equivalence test against a naive model (200 rounds × 500 queries) plus every edge (`x+w == 100`, touching sides). T
3. **Out-of-bounds / u8 overflow** (`x=200, w=100`): bounds computed in u16; w and h ≥ 1. T
4. **Forged oracle account**: Anchor owner check (Pyth receiver) and discriminator; wrong-owner price account → 3007. T
5. **Stale, unverified, wrong-feed or low-confidence price**: feed id, staleness ≤ max age (boundary tested at 60 and 61 s), Full verification, conf ≤ 2%, price > 0. T
6. **Price selection by the buyer** (choosing the most favourable of several valid Pyth updates within the max age, now 120 s): residual risk, bounded by 120 s of SOL volatility and the 2% confidence cap. The admin can tighten `max_price_age_secs`. Not fully mitigable with a pull oracle.
7. **Token price manipulation (pump spot, then buy in the same slot)**: `min(spot, EMA)`, the same-slot rule and the 15% deviation guard. T (`h1_same_slot_rule_still_holds`, `h1_c_*`)
8. **EMA manipulation (audit H-1, corrected).** The original claim here ("a buyer who unwinds pays spot") was **wrong**: the attacker buys *before* unwinding, at the dragged EMA. The auditor's PoC got a 2x2 token buy for 25% of honest in scenarios A and B, and 45–87% in C. Fixed with the Token EMA rules above; regression tests in `tests/all/security.rs`:
   - **A** (seed crank): no single-read seeding. A pumped first crank → `EmaSeedMismatch`; warm-up blocks buys; result 100% of honest.
   - **B** (crank after a ≥ 600 s gap): the EMA moves +2%, not to spot. With the pump held → `PriceDeviationTooHigh`; after unwinding → 100%.
   - **C** (4x pump held through 1/4/10 cranks): buys rejected while held. After unwinding: 100% for n = 1 and 4, rejected for n = 10 until the EMA reconverges.
   - **Residual risk (corrected in round 2):** the earlier "≥ 87%" bound was wrong. Holding spot ≥ +40% through cranks ratchets the fast EMA by 2% per crank, and the 15% band is only checked at buy time (auditor scenario D: 82.9 / 55.8 / 31.2% at 5 / 15 / 30 min). Now bounded by the slow EMA plus the hourly token-block cap. See the worst-case table under Token EMA rules (99.2 / 97.5 / 95.1 / 90.5% at 5 / 15 / 30 / 60 min). Tested.
   - **Keeper floor:** see the Buyback section (≥ 69.7% of fair after 10 dragged cranks; previously unbounded). T
9. **Fake curve or pool**:
   - The owner must be the pump or PumpSwap program, and the discriminator and layout are checked. T
   - The curve must be the canonical PDA of our mint, enforced at init and in `set_price_source`. T
   - **Audit M-2.2:** the pool must be the canonical pump.fun migration pool, enforced at config time: `["pool", 0u16, pool_authority, mint, WSOL]` under PumpSwap, with `pool_authority = ["pool-authority", mint]` under pump (seeds from the pump `migrate` IDL). Its vaults must be the pool's ATAs (base uses the mint's token program, quote is SPL WSOL). An admin can no longer point pricing at a thin pool they created themselves. T
   - At read time, the pool's stored base mint and vaults must also bind to the config. T
   - Vault mints are checked. T
   - Completed curves and non-SOL-quoted curves are rejected. T
10. **Sandwiching a buyer** (move SOL or token price against them): `max_lamports` and `max_tokens` guards. T
11. **Burning someone else's tokens**: `token::authority = buyer` and the buyer must sign. T
12. **Wrong mint or token program**: `has_one = token_mint, token_program` on config; `mint::token_program`, `token::mint`, `token::token_program`. T (mint)
13. **Treasury substitution**: `has_one = treasury`. T
14. **Ad PDA confusion**:
   - Buys must pass `["ad", y*100+x]` for their own (x, y); any other address fails `ConstraintSeeds`. T
   - A repeated top-left block fails `init`. T
   - Double settle fails on the `["ad_auction"]` `init`, with no second payout. T
   - `update_ad` / `transfer_ad` accept only accounts that are owned by this program and carry the `Ad` discriminator, plus `has_one = owner`. T
15. **Unauthorised `update_ad` / `transfer_ad` / admin setters**: `has_one`, plus signer checks. Two-step admin transfer that cannot be replayed. T
16. **Split rounding leak**: the remainder goes to buyback. Unit tests cover 0, 1, odd values and `u64::MAX`; integration tests check exact balance deltas. T
17. **Arithmetic overflow**: checked arithmetic everywhere; u128 intermediates; `overflow-checks = true` in the release profile; no `unwrap` on user input. T (unit)
18. **Auction**:
   - Refunds cannot be skipped: `previous_bidder` must equal `highest_bidder`. T
   - Refunds cannot be blocked: they are credited by direct lamport add, and bids sit far above the rent minimum.
   - No double settle. T
   - No bids after the end. T
   - No settle before the end. T
   - The lot cannot overlap sold blocks (checked again at settle).
   - All escrow leaves the auction PDA (verified the PDA keeps only rent). T
19. **Keeper theft**: one outstanding release at a time, hourly cap with a hard ceiling, on-chain burn with an EMA-based minimum, write-off on rotation. T
20. **Pause**: blocks buys, bids, auction start, settle, restart and buyback release. It does not block ad edits or cranks. Auction escrow is never lost (the end is extended on unpause), but buyback spending and settlement wait for the admin to unpause. Keeping `release_buyback` pausable is intentional: it is the incident brake, per the lead's decision on audit M-2.3. The earlier "never trapped" claim was too strong. T
24. **Unicode spoofing in content (audit L-2)**: link and image URI must be printable ASCII (0x21–0x7E); the title rejects Cc and Cf characters (bidi overrides, zero-width characters, BOM, tags). Mirrored in the SDK's `validateAdContent`. Services and web should still escape everything. T (unit)
25. **Buyback rate limit at the window edge (audit L-1)**: replaced the fixed window with a token bucket. T (`l1_no_double_cap_at_window_edge`)
21. **Account revival / close attacks**: there is no close instruction anywhere.
22. **Duplicate mutable accounts**: Anchor 1.x check is on; the bidder-equals-previous-bidder case is rejected explicitly.
23. **CU exhaustion**: a full-canvas purchase uses about 116k CU. T

## Audit round 1 (independent reviewer): findings and status
| ID | Finding | Status |
|---|---|---|
| H-1 | A single crank could set the EMA to a pumped spot (seed crank, a ≥ 600 s gap, no clamp); the keeper bar was weakened too | **Fixed.** Admin seed + seed band, warm-up, fixed alpha, ±2%/crank, 15% deviation guard, EMA-only keeper bar. Regression tests A/B/C + keeper floor in `tests/all/security.rs`. Auditor to re-run the PoC (instruction layouts changed, see below). |
| M-1 | A mid-auction pause lets the leader win | **Fixed.** `paused_at`; unpause extends to `max(end + paused, now + 10 min)`; settle and restart pausable. Tests `m1_*`. |
| M-2.1 | admin = upgrade authority | **Documented as a launch requirement** (move to a timelocked multisig or make immutable). Not enforceable on-chain. |
| M-2.2 | Any PumpSwap pool accepted | **Fixed.** Canonical migration pool PDA + ATA vaults required. Tested. |
| M-2.3 | A pause freezes buyback releases | **Documented** (accepted behaviour). |
| L-1 | Fixed window allowed 2 × cap at the edge | **Fixed.** Token bucket. Tested. |
| L-2 | Cf characters / non-ASCII URLs | **Fixed.** ASCII-only URLs, no Cc/Cf in titles (program + SDK). Unit-tested. |
| L-3 | Write-lock flooding to snipe | **Documented** (no on-chain fix). |

### Audit round 2 (re-verify)
| ID | Finding | Status |
|---|---|---|
| H-1 residual (scenario D) | Crank-time ratchet: hold spot ≥ +40%, the fast EMA compounds +2%/crank, then partially unwind into the band → 82.9 / 55.8 / 31.2% of honest | **Fixed** per the lead's decision. Slow 4 h EMA in `min()` + hourly token-block bucket (default 1,000, max 5,000). D now gives 99.2 / 97.5 / 95.1% (asserted). Keeper bar stays on the fast EMA (rationale in the Buyback section). |
| M-1 edge | Pause/unpause after `end_ts` reopened an ended auction | **Fixed.** Extension only if `end_ts > paused_at`. Test `round2_pause_after_end_cannot_reopen_auction`. |
| notes | Liveness (deviation guard, seed mismatch); L-1 is 2 × cap per hour | **Documented** (Ops notes; Buyback section). |
| addendum (a) | Two-sided band was a DoS surface and blocked buys in a crash | **Changed** to one-sided: reject only when `spot > fast × 1.15`. Tested. |
| addendum (b) | Scenarios D′ (in-band ramp) and A′ (+24% seed edge held) | **Regression tests with asserted bounds** (`round3_scenario_d_prime_*`, `round3_scenario_a_prime_*`). Numbers in the table above. |
| addendum (c) | Seed-band DoS | **Documented** (Ops notes). |

Round-2 layout changes:
- `initialize` params gained a trailing `u16 token_blocks_cap_per_hour`.
- `set_params` gained a trailing `u16 token_blocks_cap_per_hour`.
- `buy_with_token` now writes `config`.
- Config grew to 544 bytes (adds slow EMA ×2 and the token-block bucket).
- `TokenPriceUpdated` gained `slow_ema: u128` after `ema`.

PoC compatibility: the auditor's hand-built instructions need updating.
- `initialize` params gained a trailing `u128 initial_token_ema_price_sol`.
- `set_price_source` gained a trailing `u128` argument.
- `set_paused` gained the auction PDA as its third account.
- `restart_final_auction` gained `config` as its first account.
- Ad PDAs are `["ad", block u16 LE]`.
- Token buys need the warm-up: 10 cranks spanning ≥ 600 s after initialize.

## Deviations from SPEC
1. **`buyback_and_burn(lamports_in, min_tokens_out)` does not exist.** It is replaced by `release_buyback(lamports)` and `record_buyback_burn(lamports_spent, tokens_burned)`, the documented fallback. `BuybackBurned{lamports_in, tokens_burned, ts}` is emitted on record, as specified.
2. **`PriceSource::Pool` has an extra `pool` field** (`{pool, base_vault, quote_vault}`). It is needed for `virtual_quote_reserves`, which can be negative, and to bind the vaults to a real PumpSwap pool of our mint.
3. **Config fields beyond SPEC**: `pending_admin`, `token_decimals`, `token_ema_prev_price_sol`, `token_spot_price_sol`, `ema_updated_slot`, `ema_warmup_cranks`, `ema_warmup_started_at`, `paused_at`, buyback allowance bucket/cap/slippage/outstanding/written-off, `canvas_bump`, `buyback_vault_bump`, 38 reserved bytes.
4. **Ad fields beyond SPEC**: `kind` (`Rect` or `AuctionLot`), `updated_at`, `bump`. `pay_mode` has a third variant `Auction`. The auction winner's ad has `x=y=w=h=0`; its block set is `Auction.lot_bitmap`.
5. **Extra instructions**: `set_params`, `propose_admin`, `accept_admin`, `restart_final_auction`. Extra events: `BuybackReleased`, `BuybackWrittenOff`, `AuctionRestarted`. `AuctionStarted` carries `{lot_blocks, start_ts, end_ts}`, `AuctionBid` adds `end_ts`, and `AdTransferred` is `{ad_id, from, to, ts}`. (SPEC left those fields open.)
6. **Token price unit**: lamports per base unit × 1e18 (see above).
7. **Token payments**: `Ad.usd_micro` and `Canvas.usd_micro_raised` record the **discounted** USD value. The auction adds lamports but no USD, because no oracle is read at settle.
8. **Auction rules SPEC left open**:
   - Anti-sniping extension (10 min).
   - Opening bid 0.1 SOL; minimum increment max(5%, 0.01 SOL).
   - Restart when there are no bids.
   - `start_final_auction` is permissionless.
9. **Length limits are bytes** (UTF-8), not characters: title ≤ 64 B with no Cc/Cf characters; link ≤ 200 B, `https://`, printable ASCII only; image URI ≤ 200 B, `ar://` or `https://`, printable ASCII only.
10. **`max_price_age_secs`** is admin-settable within 1..=300. The deployed default is **120** (lead decision; SPEC said 60), set in `init.ts` and in `DEFAULT_MAX_PRICE_AGE_SECS`. Tests configure 60 to check the boundary.
12. **Token EMA** is admin-seeded, warm-up gated, step-limited and deviation-guarded (audit H-1). The price is `min(spot, fast, slow 4 h EMA)`, and token-paid blocks are capped per hour (audit round 2). `initialize` gains `initial_token_ema_price_sol`, and `set_price_source` gains `initial_ema_price_sol`. Token payments pause automatically during fast price moves of more than 15% against the EMA.
13. **`set_paused`** takes the auction PDA. Settle and restart are pausable, and unpausing extends the auction (audit M-1).
11. **Ad PDA seeds** are `["ad", top-left block u16 LE]` and `["ad_auction"]` instead of `["ad", ad_id u32 LE]` (lead decision, fixes the concurrent-buyer collision). Events carry `ad: Pubkey`.

## Known gaps / not tested (please read)
- **No atomic pump CPI.** See above. Nothing was run against cloned mainnet programs; `[test.validator]` cloning is not configured.
- **Pump layouts were read from the public IDL and docs.** They were not checked against a live mainnet account dump. Tests use synthetic accounts built from those offsets.
- **RPC rebroadcast** (reported by services): on a fresh local validator, v0 transactions sent with `maxRetries: 3` were dropped. The SDK builds transactions but does not send them, so callers should rebroadcast until confirmed or until the blockhash expires.
- **Pyth sponsored feed cadence (why the default is 120 s).** I measured it on 2026-11-02 with read-only RPC calls.
  - The sponsored SOL/USD account `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` (derived by the SDK, owner = Pyth receiver, Full verification) exists on both devnet and mainnet.
  - It updates roughly **every 60 s**. Sampled ages ran 4 s → 59 s, then reset.
  - At 60 s, buys landing late in a cycle failed. At 120 s they have a margin of at least 60 s.
  - Clients do NOT post Hermes updates on the critical path: Hermes needs an API key, which must not reach browsers. `@mpb/sdk/pyth` is an optional extra and is **untested end-to-end** against Hermes or a cluster. Its Node loader was verified in an isolated install with the override (see Requests).
  - Program-side Pyth tests use mock `PriceUpdateV2` accounts.
- **Token-2022 with extensions.** Tests cover base-layout Token-2022 mints and accounts only, with no extensions. A mint with a pausable or non-transferable extension, or a transfer-fee mint, was not exercised. Burn ignores transfer fees.
- **`init.ts` dry-run**:
  - Run against devnet: mint creation simulates OK.
  - `initialize` fails simulation because the program is not deployed (expected).
  - Nothing was deployed and no SOL was spent.
  - On devnet there is no pump curve for the test mint, so `crank_token_price` and `buy_with_token` cannot work there until you point the config at a real devnet pump coin (`PRICE_SOURCE=curve:…`) or create one.
- **Token payments pause during fast markets.** By design (H-1), a genuine move of more than 15% pauses `buy_with_token` until the EMA catches up at ≤ 2% per crank: about 4 minutes for +15%, about 18 minutes for 2x. SOL buys are unaffected. The UI should surface `tokenPricingStatus` from the SDK.
- **EMA parameters are constants, not admin-tunable**: 5% alpha, ±40% clamp, 15% band, 25% seed band, 10 cranks / 600 s warm-up. Changing them requires a program upgrade.
- **Keeper.** The off-chain keeper (buy on pump, then `record_buyback_burn`) belongs to services and is not written here.
- **No fuzzing.** No trident or proptest fuzzing on the program instructions. There is a randomised model check on the bitmap only.
- **Program keypair.** `target/deploy/pixel-keypair.json` is gitignored by Anchor's default `.gitignore`. Back it up before cleaning `target/`, or the program id changes (then run `anchor keys sync`, rebuild, and `pnpm --filter @mpb/sdk sync-idl`).

## Compute units
Measured by `cargo test --test all cu_report -- --nocapture` (`tests/all/cu.rs`).
- Figures include the harness's 150-CU SetComputeUnitLimit instruction.
- The same test asserts every measurement stays under the limits `@mpb/sdk` requests (`src/compute.ts`), so the SDK limits cannot silently go stale.

| instruction | measured CU | SDK limit |
|---|---|---|
| initialize (curve / canonical-pool checks) | 33.7k / 41.5k | 60k |
| crank_token_price (curve / pool; fast + slow EMA) | 8.8k / 10.2k | 20k |
| buy_with_sol 1×1 | 23.6k | 50k + 1.2k × h |
| buy_with_sol 100×50 | 69.9k | 110k |
| buy_with_sol 100×99 | 116.7k | 168.8k |
| buy_with_token 1×1 (SPL+curve / T22+pool) | 35.3k / 33.3k | 65k + 1.2k × h (+20k if a crank is prepended) |
| buy_with_token 5×4 | 34.6k / 32.6k | 69.8k |
| update_ad / transfer_ad | 6.3k / 4.7k | 15k |
| release_buyback | 10.7–10.9k | 20k |
| record_buyback_burn (SPL / T22) | 26.7k / 24.7k (with the post-trade spot backstop) | 40k |
| start_final_auction | 53.9k | 80k |
| bid_final_auction (first / with refund) | 9.7k / 10.1k | 20k |
| settle_final_auction | 40.6k | 70k |

Notes on the numbers:
- Buy cost is dominated by the per-row bitmap work: about 940 CU per row, so it scales with h and barely with w.
- Ad PDA bump search adds a variable ~1.5k CU per extra bump iteration, which is covered by the 50k base.
- Priority fee: `buildBuyTx` / `estimatePriorityFee` call `getRecentPrioritizationFees` on the canvas account (every buy write-locks it). They take the 75th percentile of non-zero fees, clamp it to [1,000, 200,000] micro-lamports/CU (configurable), and fall back to the floor when there is no data or the RPC errors. Max priority cost at the cap for a 1×1 SOL buy (51.2k CU) is about 10,240 lamports.

## Devnet launch (executed 2026-11-02, see DEVNET.md for every tx)

### Findings (read-only checks against devnet, 2026-11-02; nothing sent, no SOL spent)
- **pump.fun is live on devnet.** These are all deployed and executable at their mainnet addresses: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (pump), `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (PumpSwap) and `metaqbxx…` (Metaplex).
  - The pump `Global` PDA `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` exists (1,088 bytes).
  - All of the last 20 pump transactions on devnet succeeded; the newest was a few minutes old.
- **The create flow works on devnet.**
  - The legacy `create` instruction (hand-built from the IDL) simulates OK: 109.6k CU.
  - `scripts/pump-devnet.ts` (official `@pump-fun/pump-sdk` 4.3.1, `createV2AndBuyInstructions`: a Token-2022 coin plus a 0.5 SOL buy in one transaction) **simulates OK: 219.8k CU**. The script sets a 400k CU limit.
- **Our curve parser matches live devnet curves.** I decoded two real devnet bonding curves with `@mpb/sdk`'s `parseBondingCurve`: 166 bytes each, `quote_mint = default`, `complete = false`, and plausible reserves.
- **Devnet curves are about 100× smaller than mainnet**: about 0.3 SOL of virtual SOL, against 30 SOL on mainnet. Consequences:
  - A 0.5 SOL buy takes about 667M tokens (≈ 67% of supply) and moves the price about 5×.
  - Token payments are only testable with a creator/test wallet that bought a large share of the curve. For a 1×1 token buy at ~$94/SOL the buyer needs tokens worth ≈ 0.96 SOL at spot, which takes buying roughly ≥ 0.45 SOL of the curve first.
  - **Ordering matters.** Create and buy the coin *before* `initialize`, so the admin EMA seed equals the post-buy spot. If the 5× buy happened after seeding, token payments would be blocked by the deviation guard, and then priced at the lagging slow EMA (hours) or need a re-seed.
- The Pyth sponsored SOL/USD account exists on devnet and updates about every 60 s. The 120 s max age covers it.

### Keys (all under `chain/keys/`, gitignored via `keys/`; generated locally and never committed)
```bash
cd chain && mkdir -p keys
solana-keygen new --no-bip39-passphrase -s -o keys/deployer.json   # pays for the program deploy only
solana-keygen new --no-bip39-passphrase -s -o keys/admin.json      # upgrade authority + config admin + coin creator
solana-keygen new --no-bip39-passphrase -s -o keys/keeper.json     # crank + buyback keeper (services KEEPER_KEYPAIR)
solana-keygen new --no-bip39-passphrase -s -o keys/treasury.json   # treasury receiver (or any pubkey)
solana-keygen new --no-bip39-passphrase -s -o keys/buyer.json      # test buyer for SOL purchases
cp target/deploy/pixel-keypair.json keys/pixel-program.json        # back up the program id A4uaXC9s… (target/ is disposable)
```

### SOL needed (devnet airdrops only)
Rent figures are from devnet's `solana rent`.

| wallet | what for | SOL |
|---|---|---|
| deployer | buffer (2.93) + programdata (2.93) at peak; the buffer is refunded after deploy; write fees ~0.003 | **6.5** (≈ 2.95 net) |
| admin | config 0.0034, canvas 0.0074, vault rent 0.00065, treasury rent 0.00065, pump create rents ~0.02, **coin buy 0.5–1.0**, fees | **1.5** |
| keeper | ~100 cranks/h × 5,000 lamports + buyback test (≤ cap) | **0.3** |
| buyer | 3 SOL buys of 1×1 ($100 ≈ 1.06 SOL each at $94) + ad rent 0.0037 each | **3.5** |
| **total** | | **≈ 12 SOL** |

Airdrops: `solana airdrop 2 <PUBKEY> --url devnet`. The public faucet gives ≤ 2 SOL per request and is rate-limited (429s), so it takes several requests, ideally spread over time, or https://faucet.solana.com (GitHub login raises the limit). A Helius devnet RPC (`SOLANA_RPC_HELIUS_KEY`) does not lift faucet limits. If the deployer gets short, the deploy can be resumed from the buffer (`solana program deploy --buffer <BUFFER>`).

### Commands (in order; every script is dry-run first, then `--execute`)
```bash
cd chain
export SOLANA_RPC_HELIUS_KEY=…            # optional (or DEVNET_RPC_URL); SOLANA_RPC is ignored; scripts never print it
anchor build && ./scripts/deploy-devnet.sh                     # 0. dry run: checks keys, declare_id, rent, balances
# 1. fund (repeat until the balances in the table above are reached)
for k in deployer admin keeper buyer; do solana airdrop 2 $(solana address -k keys/$k.json) --url devnet; done
# 2. deploy: payer = deployer, upgrade authority = admin
DEPLOYER_KEYPAIR=keys/deployer.json ADMIN_KEYPAIR=keys/admin.json ./scripts/deploy-devnet.sh --execute
solana program show A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS --url devnet   # authority must be admin
# 3. create the pump coin + buy (admin is creator/buyer), BEFORE initialize
cd scripts && pnpm install --ignore-workspace
CREATOR_KEYPAIR=../keys/admin.json BUY_SOL=0.8 node pump-devnet.ts             # dry run (simulate)
CREATOR_KEYPAIR=../keys/admin.json BUY_SOL=0.8 node pump-devnet.ts --execute   # prints MINT and PRICE_SOURCE=curve:…
# 4. initialize pixel against that coin (EMA seed = live curve spot, read automatically)
ADMIN_KEYPAIR=../keys/admin.json MINT=<mint> PRICE_SOURCE=curve:<curve> \
  TREASURY=$(solana address -k ../keys/treasury.json) KEEPER=$(solana address -k ../keys/keeper.json) \
  MAX_PRICE_AGE_SECS=120 TOKEN_BLOCKS_CAP_PER_HOUR=1000 BUYBACK_CAP_SOL_PER_HOUR=1 node init.ts           # dry run
…same env… node init.ts --execute
# 5. keeper warm-up: services keeper (KEEPER_KEYPAIR=chain/keys/keeper.json, PROGRAM_ID=A4uaXC9s…) cranks every 30–60 s;
#    token payments go live after 10 cranks spanning >= 10 min (tokenPricingStatus -> ok)
```

### Verification checklist (after step 5)
1. `fetchConfig`: admin, treasury, keeper and mint are as expected; `priceSource.curve` equals pump's `bondingCurvePda(mint)`; the token program is Token-2022 (create_v2); `emaWarmupCranks ≥ 10`.
2. A SOL buy (buyer, 1×1 via `buildBuyTx`): treasury and vault each get ~50%, `AdPurchased` is indexed by services, and the tile renders on web.
3. A token buy (admin holds the coin, 1×1): the mint supply drops by exactly `quote.tokens`, and `pricedBy` is `spot` or `ema`.
4. Buyback: keeper `release_buyback` (≤ 1 SOL) → buy on the pump curve → `record_buyback_burn`. The burn shows in supply and in `BuybackBurned`.
5. Pause/unpause works (`set_paused`). Do NOT test the final auction on devnet: it needs 9,900 sold blocks (~10k SOL); it is covered by LiteSVM.

### Rollback / safety
- `set_paused(true)` is the brake.
- The program is upgradeable by `keys/admin.json` (devnet only).
- **The mainnet launch requirement still applies:** upgrade authority and admin go to a timelocked Squads multisig, or the program is made immutable.
- Nothing in this plan touches mainnet; all scripts refuse mainnet URLs.

## Graduation runbook: bonding curve → PumpSwap

Every successful pump.fun coin graduates: when the curve's real token reserves hit 0, `complete = true`. Then `migrate` (permissionless and idempotent; on mainnet pump's bot runs it, usually within seconds) moves the liquidity into the canonical PumpSwap pool. Our config must then be switched from `BondingCurve` to `Pool`.

### What the program does during the transition (fail-closed, never mispriced)
| phase | crank | `buy_with_token` | `buy_with_sol` | keeper |
|---|---|---|---|---|
| curve live | ok | ok (after warm-up) | ok | release/record ok |
| curve `complete`, pool not yet switched | `CurveComplete` | **`CurveComplete` (rejected)** | ok | `release_buyback` still works but **must not be used**; `record_buyback_burn` with spent > 0 needs a fresh EMA. Within 15 min of the last crank it still records, after that `EmaUnavailable`. A refund (spent = 0) always works. |
| switched to pool, warming up | ok (first crank checks the seed band ±25%) | **`EmaWarmingUp` (rejected)** for ≥ 10 cranks / ≥ 600 s | ok | record needs the warm-up as well |
| pool warmed up | ok | ok (priced off the pool) | ok | buy via PumpSwap (`@pump-fun/pump-swap-sdk`), record as before |

- SDK: `buildBuyWithTokenIxs` / `buildBuyTx({mode:'token'})` throw `TokenPricingUnavailableError` with reason `sourceUnavailable` (curve complete or pool unreadable), then `warmingUp`. The UI shows "token payments paused: token graduating to PumpSwap". SOL purchases are never affected.
- Tested in LiteSVM (`graduation_curve_to_pool_rejects_cleanly_then_reprices`):
  - complete curve → token buy and crank rejected `CurveComplete`; SOL buy ok;
  - non-canonical pool rejected;
  - switch with seed = pool spot (+8% vs the old EMA) → `EmaWarmingUp`;
  - after warm-up the token buy is priced exactly off the pool.

### Mainnet notes (learned from the devnet rehearsal, 2026-11-02)
- **Migration is pump's job: treat our `migrate` as "wait for pump".** pump.fun's own bot migrated our devnet coin 18 s after `complete` (at 13:33:02, `7qhZTHxJ…`), and our permissionless call was an idempotent no-op. On mainnet this is pump's standard flow. The runbook therefore *waits* for the canonical pool to exist (poll `getAccountInfo(canonicalPool)`). `graduate-devnet.ts migrate` exists only as a devnet fallback.
- **Expect a boost wave right after graduation.** `migrate_v2` created a PumpSwap *boost* (`InitBoost`, positive `virtual_quote_reserves`). pump's boost crank then ran `BoostBuyAndBurn` 30× over about 6 minutes, buying about 35.5M tokens (~3.5% of supply) out of the pool and burning them. Effects:
  - Spot rose about +43% in minutes. Token payments correctly paused (`deviation`) for about 4 minutes after warm-up, and buybacks are blocked by the backstop while spot is above the band.
  - Total supply drops with no pixel event. Stats must separate "burned by Pixel Frame" (`Canvas.tokens_burned_*`, verifiable from our events) from "total supply reduction (incl. pump boost)".
  - The slow EMA prices token buyers conservatively during the wave (devnet: `pricedBy: slowEma`, buyer burned about 40% more tokens than spot implied).
- **Admin switch latency.** The mainnet admin is a Squads multisig. The token-payment gap is (wait for pump's migration) + (multisig approval) + (≥ 10-minute warm-up) + (any boost-induced deviation). Pre-build the `set_price_source` proposal (the pool address is deterministic: `canonicalPumpPoolPda(mint)`) and have signers on call.
- **Keeper sizing on thin pools.** A post-graduation pool can be very thin. The keeper caps estimated impact at about 1% per buy and skips while spot is near the band. The on-chain backstop enforces ≤ fast EMA × 1.12 regardless.

### Steps (devnet script `chain/scripts/graduate-devnet.ts`; every step is dry-run by default)
1. **Detect.** Services/keeper watches the curve account (`parseBondingCurve(data).complete`; also pump's `CompleteEvent`). From that moment the keeper stops releasing buybacks and settles any outstanding release with a refund (`record_buyback_burn(0, 0)`).
2. **Migrate = wait for pump.** Poll until the canonical pool exists; pump's bot does the migration on mainnet, and on devnet too in our rehearsal. Only if it hasn't happened after a few minutes on devnet, use `node graduate-devnet.ts migrate --execute` (permissionless and idempotent).
3. **Derive the pool.**
   - `pool = PDA(["pool", 0u16 LE, PDA(["pool-authority", mint], pump), mint, WSOL], pAMM)`. Checked to match `@pump-fun/pump-sdk` `canonicalPumpPoolPda(mint)`; for the devnet coin it is `A9xsvGys7sF2FY5RoLvyYk1co9Tdwhg1tePgoGzsgvc9`.
   - `base_vault = ATA(pool, mint's token program, mint)`.
   - `quote_vault = ATA(pool, SPL Token, WSOL)`.
   - The program enforces exactly these addresses (audit M-2.2).
4. **Switch.**
   - Admin calls `set_price_source(Pool{pool, base_vault, quote_vault}, initial_ema = pool spot)`, with the spot read as `poolSpotPriceQ`: vault quote + `virtual_quote_reserves` over vault base.
   - Script: `node graduate-devnet.ts switch --execute`. It refuses while the curve is not complete or the pool doesn't exist yet.
   - On mainnet the admin is the Squads multisig, so this transaction is proposed there. Have it pre-built and signers on call: the gap lasts as long as the multisig takes.
5. **Warm-up.** The keeper cranks every 30–60 s. Token payments resume when `tokenPricingStatus` is ok (≥ 10 cranks over ≥ 600 s). The first crank requires pool spot within ±25% of the seed; if the price moved more than that, re-seed (step 4 again).
6. **Keeper.** Switch buyback routing from the curve (`PUMP_SDK.buyInstructions`) to PumpSwap (`@pump-fun/pump-swap-sdk`). Indexer: `TokenPriceUpdated` continues as before. Update `/api/stats` market data to read the pool.

### Devnet rehearsal (proposed, not yet executed)
- **Buy-out:** the curve has 10,390,581,918,593 base units (~10.4M PXTEST) left. Buying them all costs ~0.0417 SOL (max 0.0425 with 2% slack), paid by the deployer. Dry-run simulate: OK (92k CU).
- **Sequence:**
  1. `buyout --execute`
  2. `status` (expect `complete: true`)
  3. migrate dry-run, then `--execute`
  4. `status` (expect `poolExists: true`, `poolSpotQ`)
  5. switch dry-run, then `--execute`
  6. `devnet-verify.ts crank 10 65`
  7. token buy on the pool
  8. a keeper buyback via PumpSwap (needs the pump-swap SDK route: services' keeper, or a small addition to `devnet-verify.ts`)
- **Cost:** ≈ 0.05 SOL plus fees from the deployer (5.27 SOL available).

## Mainnet launch checklist (DOC ONLY, nothing here has been run; every mainnet step needs explicit sign-off)

> **Owner decision, 2026-11-05: no multisig.** The Squads and timelock steps below (section 1 and the references to it) are not the plan any more and were kept only as the record of the recommendation. The checklist has not been reworked for a single-key setup; do that before relying on it.

Constraint that shapes the order: `initialize` requires **admin == upgrade authority** at init time (audit fix for init front-running). So:
1. Deploy with a hot **launch key** as upgrade authority.
2. Initialize with that same key as admin.
3. Hand both roles to multisigs in the same session (step 1 below).

Total exposure window: minutes.

### 0. Prerequisites (go / no-go)
- [ ] The commit to ship is tagged. `anchor test` (11 + 53 at 9665023) and SDK tests are green on that commit, and the auditor has signed off on the exact commit.
- [ ] A **mainnet script set** exists and is reviewed (**deferred: written only after the customer confirms launch parameters**). Today's scripts are deliberately devnet-only (genesis guard), and no mainnet script is written yet. Requirements:
  - separate files (`mainnet-*.ts`);
  - hard guard on the mainnet genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`;
  - an explicit `--mainnet-i-understand` flag;
  - dry run by default;
  - an RPC from `MAINNET_RPC_URL` only (never `SOLANA_RPC` by accident).
- [x] `security_txt!` embedded (crate `solana-security-txt` =1.1.3, `lib.rs`; .so grows to 579,968 B, still fits the extended devnet programdata). Source values, not yet deployed (batched with the next program upgrade): name `Pixel Frame (pixel)`, contact `team@pixelframe.tech`, project `https://pixelframe.tech`, policy `https://pixelframe.tech/security`. **Still a placeholder:** `source_code`, confirm before the verified build (`docs/domain-cutover.md`). Pending the auditor's glance; to be batched into the next devnet upgrade.
- [ ] **Token metadata** for the pump.fun launch: name `Pixel Frame`, symbol `PXL`, image `brand/token-image-1000.png`. It is immutable once created, so check all three in the create tx before signing.
- [ ] **Program id (decided: fresh, generated offline; do NOT reuse `A4uaXC9s…`).** On an offline machine, run `solana-keygen new -o pixel-mainnet.json`. Then set `declare_id!`, `Anchor.toml [programs.mainnet]`, `anchor keys sync`, the verified rebuild, and SDK `sync-idl`. The SDK's default `PROGRAM_ID` then becomes the mainnet id, and devnet users pass `programId` explicitly (or we ship a cluster-keyed map: decide before the switch).

### 1. Squads multisig + timelock (upgrade authority and admin)
Two multisigs with different timelocks, because the admin needs to act fast (pause, graduation switch) while upgrades should be slow. **Members and thresholds are the customer's decision. The table is our recommendation, marked "customer to confirm".**

| role | Squads v4 multisig | threshold | timelock | why |
|---|---|---|---|---|
| **upgrade authority** | `UPGRADE_MS` | 3-of-5 *(customer to confirm)* | **48 h** *(customer to confirm)* | an upgrade can take every lamport; the community gets 48 h to see it coming |
| **config admin** | `OPS_MS` | 2-of-3 *(customer to confirm)* | 0–15 min *(customer to confirm)* | pause, `set_price_source` at graduation, `set_params`, `set_keeper`. Admin cannot withdraw funds; its worst case is collusion with a keeper, ≤ 50 SOL/h, visible on-chain. |

- Treasury: a third address, ideally a Squads vault with no timelock (it only receives).
- Commands (with `@sqds/multisig` v4 or the Squads app; the vault PDA is index 0 of each multisig):
  ```bash
  # after deploy + initialize with the launch key (keys never printed)
  # a) upgrade authority -> UPGRADE_MS vault (Squads vault PDAs can't co-sign, hence the skip flag)
  solana program set-upgrade-authority <PROGRAM_ID> \
    --upgrade-authority launch-admin.json \
    --new-upgrade-authority <UPGRADE_MS_VAULT> --skip-new-upgrade-authority-signer-check -u mainnet-beta
  # b) config admin -> OPS_MS vault (two-step, in the program)
  #    propose: launch key signs  proposeAdminIx({ admin: launchAdmin, newAdmin: OPS_MS_VAULT })
  #    accept:  Squads vault tx   acceptAdminIx({ newAdmin: OPS_MS_VAULT })   (created, approved, executed in OPS_MS)
  # c) verify, then destroy the launch key
  solana program show <PROGRAM_ID> -u mainnet-beta        # Authority == UPGRADE_MS_VAULT
  # fetchConfig(): admin == OPS_MS_VAULT, pendingAdmin == default
  ```
- Upgrades afterwards: `solana program write-buffer` → `set-buffer-authority` to `UPGRADE_MS_VAULT` → a Squads "program upgrade" tx, executable only after the 48 h timelock. Extend programdata beforehand if the .so grows (on CLI 3.x, `program extend` must be signed by the upgrade authority, so it also becomes a Squads tx).

### 2. Program verification
- Build reproducibly: `solana-verify build --library-name pixel` from `chain/` (Docker, pinned toolchain), and **deploy exactly that .so**. A local `anchor build` .so will not hash-match a verified build.
- Verify locally against the deployment: `solana-verify verify-from-repo -um --program-id <PROGRAM_ID> https://github.com/<org>/<repo> --commit-hash <TAG_SHA> --library-name pixel --mount-path chain`.
- The **OtterSec registry** needs a verification PDA written by the upgrade authority. With Squads as authority:
  - `solana-verify export-pda-tx … --uploader <UPGRADE_MS_VAULT>`, then execute it as a Squads tx. Note it is subject to the 48 h timelock, so do it before or right after the authority transfer, while the launch key still holds the authority.
  - Then `solana-verify remote submit-job --program-id <PROGRAM_ID> --uploader <UPGRADE_MS_VAULT>`.
- Also check what we checked on devnet: the sha256 of `solana program dump`, trimmed to the .so length, equals the verified .so, and the trailing bytes are zero.

### 3. Mainnet initialize parameters
| param | value | note |
|---|---|---|
| `token_mint` / `token_program` | the real coin's mint; Token-2022 if created via pump `create_v2` | init detects the token program from the mint owner |
| `price_source` | `BondingCurve{ PDA(["bonding-curve", mint], pump) }` | enforced canonical |
| `initial_token_ema_price_sol` | **median of curve spot sampled every 10 s over ≥ 10 min** before init (off-chain, read-only) | never a single read: the program's seed band (±25% at the first crank) and warm-up (10 cranks / ≥ 600 s) are the backstop, but the input should already be robust. Abort if the sample's max/min ratio is > 1.25 (market too wild to seed). |
| `max_price_age_secs` | 120 | the sponsored Pyth SOL/USD account updates about every 60 s |
| `token_blocks_cap_per_hour` | **250** at launch, raise to 1000 after a week | bounds manipulation extraction during the first days |
| `buyback_cap_lamports_per_hour` | 2 SOL at launch (hard max 50) | keeper burst ≤ cap; any 1 h ≤ 2 × cap |
| `buyback_max_slippage_bps` | 1500 | the rate bar vs the fast EMA; the backstop separately enforces post-trade spot ≤ fast EMA × 1.12 |
| treasury | Squads treasury vault | fund to rent-exempt (init.ts-style step) |
| keeper | dedicated keeper pubkey (§5) | |

- After init, the keeper cranks every 45 s. Token payments open once `tokenPricingStatus` is ok, about 10 minutes later; SOL payments are live immediately.
- Launch-day smoke test: one 1×1 SOL buy and one 1×1 token buy, from a team wallet.

### 4. Graduation (mainnet) with a pre-built multisig tx
- The pool address is deterministic before graduation: `canonicalPumpPoolPda(mint)`, and the vaults are its ATAs. Pre-compute these and store them in the ops runbook at launch.
- The seed (pool spot) is only known after migration, and Squads freezes tx contents at proposal time. So **pre-build the tooling, not the tx**: a reviewed script `mainnet-graduation-propose.ts` that waits for `curve.complete` and for the canonical pool to exist (pump's bot migrates within seconds; we never call migrate on mainnet). It then reads the pool spot (median over 60 s, aborting on more than 10% dispersion during the boost wave), builds `setPriceSourceIx(Pool, seed)`, creates the vault tx + proposal in `OPS_MS`, and pages the signers.
- With a 0–15 min ops timelock, the token-payment gap is migration (seconds) + approval + timelock + ≥ 10 min warm-up + any boost-wave deviation pause (≈ 4–6 min on devnet). SOL payments are unaffected throughout.
- The first crank after the switch checks pool spot within ±25% of the seed. If the boost wave moved it further, it fails `EmaSeedMismatch` and ops re-proposes with a fresh seed.
- Keeper: on `curve.complete`, stop releases and refund any outstanding release. After the switch, route buybacks via PumpSwap. The backstop blocks spend buybacks while spot is above fast EMA × 1.12.
- Stats: label pump boost burns as external; the headline is our program's burns only.

### 5. Keeper key handling
- Use a dedicated hot key, used for nothing else. Keep it in the deployment secret store (Coolify secret, file mode 600), never in git or logs. Services already never prints it.
- Float: ≤ 0.5 SOL for fees and one-time rents. Release SOL passes through the key only within the atomic release→swap→record tx, so nothing should stay outstanding.
- Monitoring and alerts:
  - `buyback_outstanding_lamports > 0` for more than 15 min;
  - any `BuybackWrittenOff`;
  - cranks failing more than 5 min in a row;
  - EMA age over 10 min;
  - keeper balance under 0.1 SOL.
- Rotation: `set_keeper(new)` from `OPS_MS`, which also writes off any outstanding release so a lost or compromised key can't block rotation. Rotate on any suspicion, and at least quarterly.
- Worst case for a compromised keeper: the hourly bucket (burst ≤ cap, sustained ≤ cap/h). Pause (`set_paused`) is the brake.

### 6. SOL funding (mainnet rent = (bytes + 128) × 6,960 lamports)
| item | SOL | note |
|---|---|---|
| program deploy: buffer (temporary) | 4.03 | refunded after deploy |
| programdata (exact size 579,541 B) | 4.03 | **5.04** with 25% headroom for future upgrades (recommended `--max-len`) |
| deploy tx fees + priority | ~0.05 | ~600 write txs |
| **deployer peak** | **≈ 9.2** | net ≈ 5.1 after the buffer refund |
| initialize (config 0.0047 + canvas 0.0101 + vault 0.0009) + treasury rent | ~0.02 | launch key |
| Squads: 2–3 multisigs + vault txs (authority transfer, accept_admin, verify PDA) | ~0.1 | |
| keeper float | 0.5 | |
| launch smoke tests | ~1.1 + tokens | one 1×1 SOL buy ≈ $100 |
| **total to have ready** | **≈ 11 SOL** | of which ≈ 5 is locked as program rent |

- Final-auction rents are paid by whoever starts or settles it: auction 0.0101 and the lot ad 0.0051.
- Ad rent (0.0051) is paid by each buyer.

## Deploy (devnet, dry-run by default)
```bash
cd chain
./scripts/deploy-devnet.sh             # checks keys/declare_id/balance, prints the deploy command + rent
./scripts/deploy-devnet.sh --execute   # actually deploys
cd scripts && pnpm install --ignore-workspace
node init.ts                           # dry run: plan + tx sizes + simulation
node init.ts --execute                 # creates the test mint (1B, 6 dec, authority revoked), funds treasury, initialize
```
RPC (all chain scripts, via `scripts/devnet-rpc.ts`; the shell deploy script mirrors it):
- `DEVNET_RPC_URL` takes precedence.
- Otherwise `SOLANA_RPC_HELIUS_KEY` (gives `https://devnet.helius-rpc.com/?api-key=…`).
- Otherwise `clusterApiUrl("devnet")`.
- **`SOLANA_RPC` is deliberately ignored**: in the root `.env` it is the QuickNode **mainnet** endpoint.
- **Hard guard:** every script checks `getGenesisHash()` (or `solana genesis-hash`) at startup and exits 1 unless it equals devnet's `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. Verified: a mainnet or testnet URL in `DEVNET_RPC_URL` → `REFUSING…`, exit 1. `SOLANA_RPC=<mainnet>` set → scripts still run on devnet.
- The URL and key are never printed. Errors are redacted (`api-key=<redacted>`), and the deploy command is shown with `--url <label>`.
- `deploy-devnet.sh` prints the M-2.1 launch requirement: before mainnet, move the upgrade authority and admin to a timelocked Squads multisig, or make the program immutable.

## Requests
- **Root (done by the lead)**: the override below is now in `pnpm-workspace.yaml`. With it the receiver loads in Node (verified in the workspace). `@pythnetwork/pyth-solana-receiver` → `@pythnetwork/solana-utils` → `jito-ts` pulls
  `@solana/web3.js@1.77.4`, which breaks on the hoisted `rpc-websockets`.
  - I was authorised to add the override to the root `package.json`, so I tried it. **pnpm 11 ignores `package.json#pnpm`** (`WARN The "pnpm" field in package.json is no longer read`), so I reverted it.
  - The override has to go in `pnpm-workspace.yaml`, which I did not touch:
    ```yaml
    overrides:
      "jito-ts>@solana/web3.js": "^1.98.4"
    ```
  - Verified in an isolated scratch install: with that override the receiver loads in Node CJS. Node ESM still fails on an upstream extensionless import inside `@pythnetwork/solana-utils`, so `@mpb/sdk/pyth` falls back to `createRequire` on Node. Bundlers take the plain `import()`; the browser bundle is not verified.
  - `@pythnetwork/pyth-solana-receiver` is an optional peer dependency of `@mpb/sdk/pyth`; the main SDK entry does not need it.
  Hermes now returns 401 without `Authorization: Bearer <key>`: pass `apiKey` to `fetchHermesSolUsd` or `hermesApiKey`
  to the posting helpers.
- **Root**: `pnpm install` reports `ERR_PNPM_IGNORED_BUILDS` for protobufjs, bufferutil and utf-8-validate. All are harmless; consider adding them to `allowBuilds: false`.
- **Services (keeper)**:
  - Crank `crank_token_price` every 30–60 s; buys need an EMA under 15 min old, and the SDK prepends a crank when it is close to expiry.
  - Run the buyback loop: `release_buyback`, then buy, then `record_buyback_burn` with `lamports_spent` = what was actually spent; the SDK has builders for each.
  - Watch `buyback_outstanding_lamports`.
- **Services and web**: index `AdPurchased` with `pay_mode = auction`, using `Auction.lot_bitmap` for the block set. Treat strings as untrusted (the on-chain check is syntactic only).
