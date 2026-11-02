use crate::common::*;
use anchor_lang::prelude::Pubkey;
use pixel::{constants::*, error::PixelError};
use pyth_solana_receiver_sdk::price_update::VerificationLevel;
use solana_signer::Signer;

#[test]
fn stale_price_rejected_at_boundary() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let now = env.now();
    env.set_sol_price(SOL_PRICE, 1, now - 61);
    assert_err(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::StalePrice);
    env.set_sol_price(SOL_PRICE, 1, now - 60);
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, u64::MAX)], &[&buyer]));
}

#[test]
fn wrong_feed_partial_verification_bad_conf_bad_owner() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let now = env.now();
    let b = buyer.pubkey();
    env.set_price_update(SOL_PRICE, 1, now, [1u8; 32], VerificationLevel::Full);
    assert_err(env.send(&[env.ix_buy_sol(&b, 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::StalePrice);
    env.set_price_update(SOL_PRICE, 1, now, SOL_USD_FEED, VerificationLevel::Partial { num_signatures: 5 });
    assert_err(env.send(&[env.ix_buy_sol(&b, 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::StalePrice);
    // conf > 2%
    env.set_sol_price(SOL_PRICE, (SOL_PRICE as u64) * 201 / 10_000, now);
    assert_err(env.send(&[env.ix_buy_sol(&b, 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::OracleConfidenceTooWide);
    env.set_sol_price(SOL_PRICE, (SOL_PRICE as u64) * 200 / 10_000, now);
    ok(env.send(&[env.ix_buy_sol(&b, 0, 0, 1, 1, u64::MAX)], &[&buyer]));
    // negative / zero price
    env.set_sol_price(0, 0, now);
    assert_err(env.send(&[env.ix_buy_sol(&b, 1, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::InvalidOraclePrice);
    env.set_sol_price(-5, 0, now);
    assert_err(env.send(&[env.ix_buy_sol(&b, 1, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::InvalidOraclePrice);
    // Forged PriceUpdateV2 owned by an attacker program
    let fake = Pubkey::new_unique();
    let data = env.svm.get_account(&env.price_update).unwrap().data;
    env.set_raw(fake, data, Pubkey::new_unique());
    let pu = fake;
    assert_code(env.send(&[env.ix_buy_sol_full(&b, 1, 0, 1, 1, "t", "https://a.io", "ar://x", u64::MAX, pu)], &[&buyer]), 3007); // AccountOwnedByWrongProgram
}

#[test]
fn crank_rules() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let kp = env.keeper.insecure_clone();
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::CrankTooSoon);
    env.warp(28); // ready() already advanced 1s => 29s since the last crank
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::CrankTooSoon);
    env.warp(1);
    env.set_curve(CURVE_VSOL * 2, CURVE_VTOK);
    let meta = ok(env.send(&[env.ix_crank()], &[&kp]));
    let ev = events::<pixel::events::TokenPriceUpdated>(&meta);
    let p = ref_price_q(CURVE_VSOL, CURVE_VTOK);
    let spot = ref_price_q(CURVE_VSOL * 2, CURVE_VTOK);
    assert_eq!(ev[0].spot, spot);
    // spot (2x) is clamped to ema*1.4, then a fixed 5% step => +2%
    assert_eq!(ev[0].ema, p + (p * 4_000 / 10_000) * 500 / 10_000);

    // wrong curve account
    env.warp(30);
    let fake = Pubkey::new_unique();
    env.set_raw(fake, pack_curve(1, 1, false, Pubkey::default()), PUMP_PROGRAM_ID);
    let mut ix = env.ix_crank();
    ix.accounts[1].pubkey = fake;
    assert_err(env.send(&[ix], &[&kp]), PixelError::InvalidPriceSource);
    // right address, wrong owner (spoofed program)
    let data = pack_curve(CURVE_VSOL, CURVE_VTOK, false, Pubkey::default());
    let curve = env.curve;
    env.set_raw(curve, data, Pubkey::new_unique());
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::InvalidPriceSource);
    // complete curve
    env.set_raw(curve, pack_curve(CURVE_VSOL, CURVE_VTOK, true, Pubkey::default()), PUMP_PROGRAM_ID);
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::CurveComplete);
    // non-SOL quote mint
    env.set_raw(curve, pack_curve(CURVE_VSOL, CURVE_VTOK, false, Pubkey::new_unique()), PUMP_PROGRAM_ID);
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::InvalidPriceSource);
    // legacy (short) curve account without quote_mint still works
    let mut short = pack_curve(CURVE_VSOL, CURVE_VTOK, false, Pubkey::default());
    short.truncate(81);
    env.set_raw(curve, short, PUMP_PROGRAM_ID);
    ok(env.send(&[env.ix_crank()], &[&kp]));
    // zero reserves
    env.warp(30);
    env.set_curve(0, CURVE_VTOK);
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::EmptyReserves);
}

#[test]
fn pool_source_binding() {
    let mut env = Env::ready(SPL_TOKEN, Source::Pool);
    let kp = env.keeper.insecure_clone();
    env.warp(30);
    // swap vault order
    let mut ix = env.ix_crank();
    let (a, b) = (ix.accounts[2].pubkey, ix.accounts[3].pubkey);
    ix.accounts[2].pubkey = b;
    ix.accounts[3].pubkey = a;
    assert_err(env.send(&[ix], &[&kp]), PixelError::InvalidPriceSource);
    // missing vaults
    let mut ix = env.ix_crank();
    ix.accounts[2].pubkey = pixel::id();
    assert_err(env.send(&[ix], &[&kp]), PixelError::InvalidPriceSource);
    // pool whose stored base mint is a different token
    let (pool, bv, qv) = (env.pool, env.pool_base_vault, env.pool_quote_vault);
    env.set_raw(pool, pack_pool(&Pubkey::new_unique(), &bv, &qv, 0), PUMP_AMM_PROGRAM_ID);
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::InvalidPriceSource);
    // pool account owned by the wrong program
    let mint = env.mint;
    env.set_raw(pool, pack_pool(&mint, &bv, &qv, 0), Pubkey::new_unique());
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::InvalidPriceSource);
    // vault token account with a different mint
    env.set_pool(CURVE_VSOL, CURVE_VTOK, 0);
    env.set_raw(bv, pack_token_account(&Pubkey::new_unique(), &Pubkey::new_unique(), CURVE_VTOK), SPL_TOKEN);
    assert_err(env.send(&[env.ix_crank()], &[&kp]), PixelError::InvalidPriceSource);
    env.set_pool(CURVE_VSOL, CURVE_VTOK, 0);
    ok(env.send(&[env.ix_crank()], &[&kp]));
}
