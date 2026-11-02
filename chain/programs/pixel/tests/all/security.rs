//! Regression tests for the round-1 audit findings (H-1 EMA manipulation, M-1 pause vs auction, L-1 window).
//! Scenarios A/B/C mirror the auditor's PoC: 2x2 rect, curve pumped 4x (30 SOL -> 120 SOL virtual quote).
use crate::common::*;
use pixel::{constants::*, error::PixelError, events::AuctionResumed};
use solana_signer::Signer;

const PUMP: u64 = 4;

fn honest_q() -> u128 {
    ref_price_q(CURVE_VSOL, CURVE_VTOK)
}
fn honest_tokens_2x2() -> u64 {
    ref_tokens(4, SOL_PRICE, honest_q())
}
fn buyer(env: &mut Env) -> (solana_keypair::Keypair, anchor_lang::prelude::Pubkey) {
    env.new_user(10_000_000_000, 900_000_000_000_000)
}
fn crank_after(env: &mut Env, secs: i64) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    env.warp(secs);
    env.refresh_price();
    let kp = env.keeper.insecure_clone();
    env.send(&[env.ix_crank()], &[&kp])
}

// ------------------------------------------------------------------ H-1 (A): no single-read seeding

#[test]
fn h1_a_seed_crank_cannot_set_ema_to_pumped_spot() {
    // initialize WITHOUT a seed: crank refuses (no seeding from spot), token buys disabled
    let mut env = Env::new(SPL_TOKEN, Source::Curve);
    env.initial_ema = 0;
    let admin = env.admin.insecure_clone();
    ok(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]));
    let (b, ta) = buyer(&mut env);
    env.set_curve(CURVE_VSOL * PUMP, CURVE_VTOK);
    assert_err(crank_after(&mut env, 31), PixelError::EmaUnavailable);
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]), PixelError::EmaWarmingUp);

    // admin seeds at the honest price; attacker pumps 4x before the first crank => seed band rejects it
    let cs = pixel::state::PriceSource::BondingCurve { curve: env.curve };
    ok(env.send(&[env.ix_set_price_source(&admin.pubkey(), cs, honest_q())], &[&admin]));
    assert_err(crank_after(&mut env, 31), PixelError::EmaSeedMismatch);
    // a pump inside the 25% band passes the seed check but moves the EMA by at most 2%
    env.set_curve(CURVE_VSOL * 6 / 5, CURVE_VTOK);
    ok(crank_after(&mut env, 0));
    assert!(env.config().token_ema_price_sol <= honest_q() * 102 / 100 + 1);
    // ... and token buys stay disabled during warm-up (10 cranks over >= 600 s)
    env.warp(1);
    env.refresh_price();
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]), PixelError::EmaWarmingUp);
    for _ in 0..8 {
        ok(crank_after(&mut env, 67));
    }
    env.warp(1);
    env.refresh_price();
    assert_eq!(env.config().ema_warmup_cranks, 9);
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]), PixelError::EmaWarmingUp);
    ok(crank_after(&mut env, 67)); // 10th crank, span 603 s
    env.set_curve(CURVE_VSOL, CURVE_VTOK);
    env.warp(1);
    env.refresh_price();
    let m = ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
    let _ = m;
    let paid = env.ad_at(0, 0).paid_tokens;
    // PoC A was 25% of honest; now >= 100% (spot honest, ema slightly above => min = spot)
    assert_eq!(paid, honest_tokens_2x2());
}

// ------------------------------------------------------------------ H-1 (B): crank after a long gap

#[test]
fn h1_b_gap_crank_moves_ema_at_most_two_percent() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (b, ta) = buyer(&mut env);
    env.set_curve(CURVE_VSOL * PUMP, CURVE_VTOK);
    ok(crank_after(&mut env, 650));
    let ema = env.config().token_ema_price_sol;
    assert_eq!(ema, honest_q() + (honest_q() * 4_000 / 10_000) * 500 / 10_000, "+2%, not = spot");
    env.warp(1);
    env.refresh_price();
    // pump still held: spot 4x vs ema +2% => outside the 15% band => no token buys at all
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]), PixelError::PriceDeviationTooHigh);
    // unwind: buyer pays min(spot, ema) = honest => 100% (PoC B was 25%)
    env.set_curve(CURVE_VSOL, CURVE_VTOK);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
    assert_eq!(env.ad_at(0, 0).paid_tokens, honest_tokens_2x2());
    // EMA older than 900 s: rejected until cranked
    env.warp(MAX_EMA_AGE_SECS + 1);
    env.refresh_price();
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 2, 0, 1, 1, u64::MAX)], &[&b]), PixelError::EmaUnavailable);
}

// ------------------------------------------------------------------ H-1 (C): pump held through regular cranks

#[test]
fn h1_c_held_4x_pump_through_cranks_cannot_buy() {
    for n in [1u32, 4, 10] {
        let mut env = Env::ready(SPL_TOKEN, Source::Curve);
        let (b, ta) = buyer(&mut env);
        env.set_curve(CURVE_VSOL * PUMP, CURVE_VTOK);
        for _ in 0..n {
            ok(crank_after(&mut env, 30));
        }
        let ema = env.config().token_ema_price_sol;
        // <= 2% per crank
        let mut cap = honest_q();
        for _ in 0..n {
            cap += (cap * 4_000 / 10_000) * 500 / 10_000;
        }
        assert!(ema <= cap, "n={n}");
        env.warp(1);
        env.refresh_price();
        // PoC C: 87% / 64% / 45% of honest. Now: rejected while the pump is held.
        assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]), PixelError::PriceDeviationTooHigh);
        // unwinding before buying: the band is one-sided, so spot below the (dragged) EMA is accepted and the buyer
        // pays min(spot, fast, slow) = honest spot.
        env.set_curve(CURVE_VSOL, CURVE_VTOK);
        ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
        assert_eq!(env.ad_at(0, 0).paid_tokens, honest_tokens_2x2(), "n={n}");
    }
}

#[test]
fn h1_c_best_in_band_attack_is_bounded_by_the_deviation_band() {
    // Strongest remaining strategy: hold spot at +15% (the edge of the band) for a long time so the EMA catches up.
    // The buyer then pays at most 15% fewer tokens, and only after holding the pump for many minutes.
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (b, ta) = buyer(&mut env);
    env.set_curve(CURVE_VSOL * 115 / 100, CURVE_VTOK);
    for _ in 0..60 {
        ok(crank_after(&mut env, 30)); // 30 minutes of a held pump
    }
    env.warp(1);
    env.refresh_price();
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
    let paid = env.ad_at(0, 0).paid_tokens as u128;
    let honest = honest_tokens_2x2() as u128;
    assert!(paid * 1_000 >= honest * 869, "paid {paid} vs honest {honest}"); // >= 1/1.15
    // after only 4 cranks (2 minutes) the EMA has moved ~2.8%: the attack yields < 3%
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (b, ta) = buyer(&mut env);
    env.set_curve(CURVE_VSOL * 115 / 100, CURVE_VTOK);
    for _ in 0..4 {
        ok(crank_after(&mut env, 30));
    }
    env.warp(1);
    env.refresh_price();
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
    let paid = env.ad_at(0, 0).paid_tokens as u128;
    assert!(paid * 1_000 >= honest * 970, "paid {paid} vs honest {honest}");
}

#[test]
fn h1_same_slot_rule_still_holds() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (b, ta) = buyer(&mut env);
    env.warp(30);
    env.refresh_price();
    env.set_curve(CURVE_VSOL * 110 / 100, CURVE_VTOK); // inside the band
    ok(env.send(&[env.ix_crank(), env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
    let c = env.config();
    assert!(c.token_ema_price_sol > honest_q());
    assert_eq!(c.token_ema_prev_price_sol, honest_q());
    assert_eq!(env.ad_at(0, 0).paid_tokens, honest_tokens_2x2(), "priced at pre-crank EMA");
}

// ------------------------------------------------------------------ H-1: keeper floor re-derived

#[test]
fn h1_keeper_dragging_ema_is_bounded() {
    // Keeper holds a 4x pump through 10 cranks (>= 5 minutes) to lower the reconciliation bar.
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (whale, _) = env.new_user(1_000_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&whale.pubkey(), 0, 50, 10, 1, u64::MAX)], &[&whale]));
    let kp = env.keeper.insecure_clone();
    let keeper_ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(keeper_ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 1_000_000_000)], &[&kp]));
    env.set_curve(CURVE_VSOL * PUMP, CURVE_VTOK);
    for _ in 0..10 {
        ok(crank_after(&mut env, 30));
    }
    env.warp(1);
    let ema = env.config().token_ema_price_sol;
    assert!(ema * 1_000 <= honest_q() * 1_219 + 1_000, "EMA <= +21.9% after 10 cranks");
    let fair = (1_000_000_000u128 * PRICE_SCALE / honest_q()) as u64;
    // worst-case bar = fair / 1.219 * 0.85 ~= 69.7% of fair (was unbounded: PoC took the EMA to 4x => 21%)
    let bar = (1_000_000_000u128 * PRICE_SCALE / ema * 8_500 / 10_000) as u64;
    assert!(bar as u128 * 1_000 >= fair as u128 * 697);
    assert_err(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 1_000_000_000, bar - 1)], &[&kp]), PixelError::BuybackRateTooLow);
    ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 1_000_000_000, bar)], &[&kp]));
}

// ------------------------------------------------------------------ M-1: pause cannot decide the auction

fn fill_to_auction(env: &mut Env) -> solana_keypair::Keypair {
    let (whale, _) = env.new_user(20_000_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&whale.pubkey(), 0, 0, 100, 99, u64::MAX)], &[&whale]));
    ok(env.send(&[env.ix_start_auction(&whale.pubkey())], &[&whale]));
    whale
}

#[test]
fn m1_pause_freezes_auction_clock_and_settlement() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let whale = fill_to_auction(&mut env);
    let admin = env.admin.insecure_clone();
    let (a, _) = env.new_user(10_000_000_000, 0);
    let (b, _) = env.new_user(10_000_000_000, 0);
    ok(env.send(&[env.ix_bid(&a.pubkey(), None, AUCTION_MIN_OPENING_BID_LAMPORTS)], &[&a]));
    let end0 = env.auction().end_ts;
    // pause one hour before the end; let the end pass while paused
    let now = env.now();
    env.warp(end0 - now - 3_600);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    let paused_at = env.now();
    env.warp(2 * 3_600);
    assert_err(env.send(&[env.ix_settle(&whale.pubkey())], &[&whale]), PixelError::Paused);
    assert_err(env.send(&[env.ix_bid(&b.pubkey(), Some(a.pubkey()), 200_000_000)], &[&b]), PixelError::Paused);
    // unpause: end_ts = max(end + paused, now + 10 min) => the 1 h that was left is restored
    let m = ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    let paused_for = env.now() - paused_at;
    let ev = &events::<AuctionResumed>(&m)[0];
    assert_eq!(ev.paused_secs, paused_for);
    assert_eq!(env.auction().end_ts, end0 + paused_for);
    assert_eq!(env.auction().end_ts - env.now(), 3_600);
    // bidding works again; the leader did not win by pause
    ok(env.send(&[env.ix_bid(&b.pubkey(), Some(a.pubkey()), 200_000_000)], &[&b]));
    assert_err(env.send(&[env.ix_settle(&whale.pubkey())], &[&whale]), PixelError::AuctionNotEnded);
    // a pause in the last minute still leaves >= 10 minutes after unpause
    let end1 = env.auction().end_ts;
    let now = env.now();
    env.warp(end1 - now - 60);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    env.warp(1);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    assert_eq!(env.auction().end_ts, env.now() + AUCTION_EXTENSION_SECS);
    // re-pausing while paused does not reset paused_at
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    let pa = env.config().paused_at;
    env.warp(10);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    assert_eq!(env.config().paused_at, pa);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    let end2 = env.auction().end_ts;
    env.warp(end2 - env.now());
    ok(env.send(&[env.ix_settle(&whale.pubkey())], &[&whale]));
}

#[test]
fn m1_restart_blocked_while_paused_and_unpause_without_auction_is_fine() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let admin = env.admin.insecure_clone();
    // no auction account yet: pause/unpause still work
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    let whale = fill_to_auction(&mut env);
    env.warp(AUCTION_DURATION_SECS);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    assert_err(env.send(&[env.ix_restart_auction()], &[&whale]), PixelError::Paused);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    // end was already past when paused: the auction stays ended (round-2 fix), so restart works right away
    ok(env.send(&[env.ix_restart_auction()], &[&whale]));
}

// ------------------------------------------------------------------ L-1: token bucket, no double cap at a window edge

#[test]
fn l1_no_double_cap_at_window_edge() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (whale, _) = env.new_user(1_000_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&whale.pubkey(), 0, 50, 100, 2, u64::MAX)], &[&whale])); // 200 blocks => vault ~66 SOL
    let kp = env.keeper.insecure_clone();
    let cap = env.config().buyback_cap_lamports_per_hour; // 5 SOL
    ok(env.send(&[env.ix_release(&kp.pubkey(), cap)], &[&kp]));
    let keeper_ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(keeper_ta, pack_token_account(&mint, &kp.pubkey(), 1), tp);
    ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 0, 0)], &[&kp]));
    // the old fixed window allowed another full cap right at the edge; the bucket only refilled 3600s*cap/3600
    env.warp(BUYBACK_WINDOW_SECS - 1);
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), cap)], &[&kp]), PixelError::BuybackCapExceeded);
    let refilled = env.config();
    let _ = refilled;
    // half an hour => half the cap
    let mut env2 = Env::ready(SPL_TOKEN, Source::Curve);
    let (w2, _) = env2.new_user(1_000_000_000_000, 0);
    ok(env2.send(&[env2.ix_buy_sol(&w2.pubkey(), 0, 50, 100, 2, u64::MAX)], &[&w2]));
    let kp2 = env2.keeper.insecure_clone();
    ok(env2.send(&[env2.ix_release(&kp2.pubkey(), cap)], &[&kp2]));
    let ta2 = anchor_lang::prelude::Pubkey::new_unique();
    let (m2, tp2) = (env2.mint, env2.token_program);
    env2.set_raw(ta2, pack_token_account(&m2, &kp2.pubkey(), 1), tp2);
    ok(env2.send(&[env2.ix_record(&kp2.pubkey(), &ta2, 0, 0)], &[&kp2]));
    env2.warp(1_800);
    assert_err(env2.send(&[env2.ix_release(&kp2.pubkey(), cap / 2 + 1_000_000)], &[&kp2]), PixelError::BuybackCapExceeded);
    ok(env2.send(&[env2.ix_release(&kp2.pubkey(), cap / 2)], &[&kp2]));
}

// ------------------------------------------------------------------ round 2: ratchet (auditor scenario D)

/// Worst-case price inflation from a held pump of >= +40% over n cranks: the slow EMA (1/480 per crank, ±40% clamp)
/// bounds it. Computed with the program's own `slow_ema_update`.
fn slow_ratchet_factor(n: u32) -> f64 {
    let p = PRICE_SCALE;
    let mut s = p;
    for _ in 0..n {
        s = pixel::math::slow_ema_update(s, u128::MAX / 4).unwrap();
    }
    s as f64 / p as f64
}

#[test]
fn round2_worst_case_table() {
    println!("\n| held pump (>= +40%) | cranks | slow-EMA bound | min tokens burned vs honest |");
    println!("|---|---|---|---|");
    for (mins, n) in [(5, 10u32), (15, 30), (30, 60), (60, 120), (240, 480)] {
        let f = slow_ratchet_factor(n);
        println!("| {mins} min | {n} | x{f:.4} | {:.1}% |", 100.0 / f);
    }
    assert!(100.0 / slow_ratchet_factor(10) > 99.1);
    assert!(100.0 / slow_ratchet_factor(30) > 97.5);
    assert!(100.0 / slow_ratchet_factor(60) > 95.0);
    assert!(100.0 / slow_ratchet_factor(120) > 90.4); // x1.1051
}

#[test]
fn round2_scenario_d_ratchet_then_partial_unwind_is_bounded_by_slow_ema() {
    // Auditor's D: hold a 4x pump through n cranks (fast EMA ratchets +2%/crank), then drop spot to fast*0.99
    // (inside the 15% band) and buy. Before: 82.9% / 55.8% / 31.2% of honest for n = 10 / 30 / 60.
    for n in [10u32, 30, 60] {
        let mut env = Env::ready(SPL_TOKEN, Source::Curve);
        let (b, ta) = buyer(&mut env);
        env.set_curve(CURVE_VSOL * PUMP, CURVE_VTOK);
        for _ in 0..n {
            ok(crank_after(&mut env, 30));
        }
        let c = env.config();
        let spot_target = c.token_ema_price_sol * 99 / 100;
        let vsol = (spot_target * CURVE_VTOK as u128 / PRICE_SCALE) as u64;
        env.set_curve(vsol, CURVE_VTOK);
        env.warp(1);
        env.refresh_price();
        ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
        let paid = env.ad_at(0, 0).paid_tokens as f64;
        let honest = honest_tokens_2x2() as f64;
        let pct = 100.0 * paid / honest;
        let bound = 100.0 / slow_ratchet_factor(n);
        println!("D {n:>2} cranks: {pct:.1}% of honest (bound {bound:.1}%)");
        assert!(pct >= bound - 0.01, "n={n}: {pct} < {bound}");
        // and the slow EMA is what priced it
        let c = env.config();
        assert!(c.token_slow_ema_price_sol < c.token_ema_price_sol);
    }
}

// ------------------------------------------------------------------ round 2: token-paid blocks rate limit

#[test]
fn round2_token_blocks_hourly_cap() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let admin = env.admin.insecure_clone();
    let set = |env: &Env, cap: u16| env.ix_admin(&admin.pubkey(), pixel::instruction::SetParams {
        max_price_age_secs: 60,
        buyback_cap_lamports_per_hour: 5_000_000_000,
        buyback_max_slippage_bps: 1_500,
        token_blocks_cap_per_hour: cap,
    });
    assert_err(env.send(&[set(&env, MAX_TOKEN_BLOCKS_CAP_PER_HOUR + 1)], &[&admin]), PixelError::InvalidParam);
    ok(env.send(&[set(&env, MAX_TOKEN_BLOCKS_CAP_PER_HOUR)], &[&admin]));
    ok(env.send(&[set(&env, 10)], &[&admin]));
    assert_eq!(env.config().token_blocks_allowance, 10);
    let (b, ta) = buyer(&mut env);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 2, 0, 2, 2, u64::MAX)], &[&b]));
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 4, 0, 2, 2, u64::MAX)], &[&b]), PixelError::TokenBuyCapExceeded);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 4, 0, 1, 2, u64::MAX)], &[&b])); // exactly the remaining 2
    // SOL buys are not capped
    let (s, _) = env.new_user(1_000_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&s.pubkey(), 10, 10, 20, 20, u64::MAX)], &[&s]));
    // half an hour refills 5 blocks (crank to keep the EMA fresh)
    ok(crank_after(&mut env, 1_800));
    env.warp(1);
    env.refresh_price();
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 5, 3, 2, u64::MAX)], &[&b]), PixelError::TokenBuyCapExceeded);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 5, 5, 1, u64::MAX)], &[&b]));
    // a rect bigger than the cap can never be bought with tokens
    ok(env.send(&[set(&env, 1_000)], &[&admin]));
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 60, 100, 11, u64::MAX)], &[&b]), PixelError::TokenBuyCapExceeded);
}

// ------------------------------------------------------------------ round 2: M-1 edge (ended auction stays ended)

#[test]
fn round2_pause_after_end_cannot_reopen_auction() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let whale = fill_to_auction(&mut env);
    let admin = env.admin.insecure_clone();
    let (a, _) = env.new_user(10_000_000_000, 0);
    let (b, _) = env.new_user(10_000_000_000, 0);
    ok(env.send(&[env.ix_bid(&a.pubkey(), None, AUCTION_MIN_OPENING_BID_LAMPORTS)], &[&a]));
    let end = env.auction().end_ts;
    env.warp(end - env.now() + 5); // ended, not settled
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    env.warp(1);
    let m = ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    assert!(events::<AuctionResumed>(&m).is_empty());
    assert_eq!(env.auction().end_ts, end, "ended auction not reopened");
    assert_err(env.send(&[env.ix_bid(&b.pubkey(), Some(a.pubkey()), 1_000_000_000)], &[&b]), PixelError::AuctionEnded);
    ok(env.send(&[env.ix_settle(&whale.pubkey())], &[&whale]));
    assert_eq!(env.load::<pixel::state::Ad>(&auction_ad_pda()).owner, a.pubkey());
}

// ------------------------------------------------------------------ round 3 addendum: one-sided band, D', A'

fn set_spot_q(env: &mut Env, q: u128) {
    let vsol = (q * CURVE_VTOK as u128 / PRICE_SCALE) as u64;
    env.set_curve(vsol, CURVE_VTOK);
}

#[test]
fn round3_one_sided_band() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (b, ta) = buyer(&mut env);
    let e = env.config().token_ema_price_sol;
    // just above +15% -> rejected; exactly +15% -> allowed
    set_spot_q(&mut env, e * 1_151 / 1_000);
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 1, 1, u64::MAX)], &[&b]), PixelError::PriceDeviationTooHigh);
    set_spot_q(&mut env, e * 1_149 / 1_000);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 1, 1, u64::MAX)], &[&b]));
    assert_eq!(env.ad_at(0, 0).paid_tokens, ref_tokens(1, SOL_PRICE, e), "priced at the EMA, not the higher spot");
    // crash: spot -50% -> still allowed, priced at spot (buyer pays ~2x tokens)
    set_spot_q(&mut env, e / 2);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 1, 0, 1, 1, u64::MAX)], &[&b]));
    let crash_q = (e / 2 * CURVE_VTOK as u128 / PRICE_SCALE) * PRICE_SCALE / CURVE_VTOK as u128;
    assert_eq!(env.ad_at(1, 0).paid_tokens, ref_tokens(1, SOL_PRICE, crash_q));
}

/// Model of the D' attacker against the program's own EMA math: spot = fast * 1.149 before every crank.
fn d_prime_bound(n: u32) -> f64 {
    let p = PRICE_SCALE;
    let (mut fast, mut slow) = (p, p);
    for _ in 0..n {
        let spot = fast * 1_149 / 1_000;
        fast = pixel::math::ema_update(fast, spot).unwrap();
        slow = pixel::math::slow_ema_update(slow, spot).unwrap();
    }
    p as f64 / slow.min(fast) as f64 * 100.0
}

#[test]
fn round3_scenario_d_prime_in_band_ramp() {
    // Auditor D': ramp spot to fast EMA * 1.149 before every crank (never outside the band, never rejected), buy at
    // the end with spot still at the top. Price = min(spot, fast, slow) = slow.
    println!("\n| D' in-band ramp | cranks | buyer burns >= |\n|---|---|---|");
    for (mins, n) in [(5, 10u32), (15, 30), (30, 60), (60, 120)] {
        println!("| {mins} min | {n} | {:.1}% |", d_prime_bound(n));
    }
    for n in [10u32, 30, 60] {
        let mut env = Env::ready(SPL_TOKEN, Source::Curve);
        let (b, ta) = buyer(&mut env);
        for _ in 0..n {
            let fast = env.config().token_ema_price_sol;
            set_spot_q(&mut env, fast * 1_149 / 1_000);
            ok(crank_after(&mut env, 30));
        }
        let fast = env.config().token_ema_price_sol;
        set_spot_q(&mut env, fast * 1_149 / 1_000);
        env.warp(1);
        env.refresh_price();
        ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
        let pct = 100.0 * env.ad_at(0, 0).paid_tokens as f64 / honest_tokens_2x2() as f64;
        let bound = d_prime_bound(n);
        println!("D' {n:>2} cranks: {pct:.2}% of honest (model bound {bound:.2}%)");
        assert!(pct >= bound - 0.05, "n={n}: {pct} < {bound}");
    }
    assert!(d_prime_bound(10) > 99.5 && d_prime_bound(30) > 98.2 && d_prime_bound(60) > 95.8 && d_prime_bound(120) > 91.1);
}

#[test]
fn round3_scenario_a_prime_seed_band_edge_held_through_warmup() {
    // Auditor A': admin seeds at honest; attacker moves spot to +24% (inside the 25% seed band) before the first crank
    // and holds it through the whole warm-up (21 cranks, 31 s apart, like the PoC), then buys.
    let mut env = Env::new(SPL_TOKEN, Source::Curve);
    let admin = env.admin.insecure_clone();
    ok(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]));
    let (b, ta) = buyer(&mut env);
    set_spot_q(&mut env, honest_q() * 124 / 100);
    ok(crank_after(&mut env, 31));
    for _ in 0..20 {
        ok(crank_after(&mut env, 31));
    }
    env.warp(1);
    env.refresh_price();
    let c = env.config();
    assert!(c.ema_warmup_cranks >= EMA_WARMUP_CRANKS);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 2, 2, u64::MAX)], &[&b]));
    let pct = 100.0 * env.ad_at(0, 0).paid_tokens as f64 / honest_tokens_2x2() as f64;
    // bound: 21 slow-EMA steps toward +24%
    let mut slow = honest_q();
    for _ in 0..21 {
        slow = pixel::math::slow_ema_update(slow, honest_q() * 124 / 100).unwrap();
    }
    let bound = honest_q() as f64 / slow as f64 * 100.0;
    println!("A' (+24% held through warm-up): {pct:.2}% of honest (bound {bound:.2}%)");
    assert!(pct >= bound - 0.05);
    assert!(pct > 98.9);
}

// ------------------------------------------------------------------ graduation: curve -> canonical PumpSwap pool

#[test]
fn graduation_curve_to_pool_rejects_cleanly_then_reprices() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let admin = env.admin.insecure_clone();
    let (b, ta) = buyer(&mut env);
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 0, 0, 1, 1, u64::MAX)], &[&b]));

    // 1. curve completes (pump sets complete = true; real reserves move to the pool on migrate)
    let curve = env.curve;
    env.set_raw(curve, pack_curve(CURVE_VSOL, CURVE_VTOK, true, anchor_lang::prelude::Pubkey::default()), PUMP_PROGRAM_ID);
    // gap: token buys and cranks are rejected cleanly (never priced off a dead curve); SOL buys keep working
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 1, 0, 1, 1, u64::MAX)], &[&b]), PixelError::CurveComplete);
    assert_err(crank_after(&mut env, 31), PixelError::CurveComplete);
    let (s, _) = env.new_user(100_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&s.pubkey(), 50, 50, 1, 1, u64::MAX)], &[&s]));

    // 2. pool appears at a different price (migration rounding / fees): +8% vs the last EMA
    let pool_quote = CURVE_VSOL * 108 / 100;
    env.set_pool(pool_quote, CURVE_VTOK, 0);
    // a non-canonical pool is refused
    let rogue = pixel::PriceSource::Pool { pool: anchor_lang::prelude::Pubkey::new_unique(), base_vault: env.pool_base_vault, quote_vault: env.pool_quote_vault };
    assert_err(env.send(&[env.ix_set_price_source(&admin.pubkey(), rogue, 1)], &[&admin]), PixelError::InvalidParam);
    // 3. admin switches to the canonical pool, seeding the EMA with the pool's spot
    let seed = ref_price_q(pool_quote, CURVE_VTOK);
    let ps = pixel::PriceSource::Pool { pool: env.pool, base_vault: env.pool_base_vault, quote_vault: env.pool_quote_vault };
    ok(env.send(&[env.ix_set_price_source(&admin.pubkey(), ps, seed)], &[&admin]));
    env.source = Source::Pool;
    // 4. warm-up: token buys rejected (EmaWarmingUp) until 10 cranks over >= 600 s on the pool
    env.warp(1);
    env.refresh_price();
    assert_err(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 1, 0, 1, 1, u64::MAX)], &[&b]), PixelError::EmaWarmingUp);
    env.warm_up();
    ok(env.send(&[env.ix_buy_token(&b.pubkey(), &ta, 1, 0, 1, 1, u64::MAX)], &[&b]));
    assert_eq!(env.ad_at(1, 0).paid_tokens, ref_tokens(1, SOL_PRICE, seed), "priced off the pool");
}
