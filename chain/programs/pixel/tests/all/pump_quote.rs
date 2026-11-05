//! A coin paired with PUMP on pump.fun, against the program as audited: curve quote_mint = PUMP, reserves in PUMP units.
//! SOL purchases must work from the first moment; nothing that needs a token price may work, or move any SOL.
use crate::common::*;
use anchor_lang::prelude::Pubkey;
use pixel::{constants::*, error::PixelError, state::PriceSource};
use solana_signer::Signer;

const PUMP_MINT: Pubkey = anchor_lang::pubkey!("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
/// Sampled from a mainnet PUMP-quoted curve, 2026-11-05.
const VQUOTE_PUMP_UNITS: u64 = 998_139_534_885;

/// Initialized the way mainnet-init.ts does for a PUMP pair: seed 0. The curve account is real-shaped and quoted in PUMP.
fn parked() -> Env {
    let mut env = Env::new(TOKEN_2022, Source::Curve);
    env.initial_ema = 0;
    env.set_raw(env.curve, pack_curve(VQUOTE_PUMP_UNITS, CURVE_VTOK, false, PUMP_MINT), PUMP_PROGRAM_ID);
    let admin = env.admin.insecure_clone();
    ok(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]));
    env
}

#[test]
fn initialize_with_seed_zero_on_a_pump_curve() {
    let env = parked();
    let c = env.config();
    assert_eq!(c.token_mint, env.mint);
    assert_eq!(c.token_ema_price_sol, 0);
    assert_eq!(c.ema_warmup_cranks, 0);
    assert_eq!(c.price_source, PriceSource::BondingCurve { curve: env.curve });
    assert_eq!(env.canvas().sold_blocks, 0);
}

#[test]
fn initialize_also_works_when_the_curve_account_is_a_short_real_layout() {
    // Mainnet PUMP curves come in 141, 151 and 166 bytes; initialize doesn't read the account at all.
    let mut env = Env::new(TOKEN_2022, Source::Curve);
    env.initial_ema = 0;
    let mut d = pack_curve(VQUOTE_PUMP_UNITS, CURVE_VTOK, false, PUMP_MINT);
    d.truncate(141);
    env.set_raw(env.curve, d, PUMP_PROGRAM_ID);
    let admin = env.admin.insecure_clone();
    ok(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]));
}

#[test]
fn sol_purchase_splits_50_50_and_the_vault_accumulates() {
    let mut env = parked();
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let b = buyer.pubkey();
    let (t0, v0) = (env.lamports(&env.treasury), env.lamports(&vault_pda()));

    let one = ref_lamports(100_000_000, SOL_PRICE);
    ok(env.send(&[env.ix_buy_sol(&b, 0, 0, 1, 1, one)], &[&buyer]));
    let (t1, v1) = (env.lamports(&env.treasury), env.lamports(&vault_pda()));
    assert_eq!(t1 - t0, one / 2, "treasury gets half, rounded down");
    assert_eq!(v1 - v0, one - one / 2, "vault gets the rest");

    env.warp(1);
    env.refresh_price();
    let six = ref_lamports(600_000_000, SOL_PRICE);
    ok(env.send(&[env.ix_buy_sol(&b, 10, 10, 3, 2, six)], &[&buyer]));
    assert_eq!(env.lamports(&env.treasury) - t1, six / 2);
    assert_eq!(env.lamports(&vault_pda()) - v1, six - six / 2);

    let c = env.canvas();
    assert_eq!(c.sold_blocks, 7);
    assert_eq!(c.lamports_raised, one + six);
    assert_eq!(c.lamports_to_treasury + c.lamports_to_buyback, c.lamports_raised);
    assert_eq!(c.lamports_spent_buyback, 0);
    assert_eq!(c.tokens_burned_buyback, 0);
}

#[test]
fn sol_purchase_survives_the_curve_completing() {
    let mut env = parked();
    env.set_raw(env.curve, pack_curve(VQUOTE_PUMP_UNITS, CURVE_VTOK, true, PUMP_MINT), PUMP_PROGRAM_ID);
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, u64::MAX)], &[&buyer]));
}

#[test]
fn nothing_priced_can_run() {
    let mut env = parked();
    let keeper = env.keeper.insecure_clone();
    let (buyer, ta) = env.new_user(100_000_000_000, SUPPLY / 10);
    env.warp(31);
    env.refresh_price();

    // The parser refuses the quote mint before anything else looks at the EMA.
    assert_err(env.send(&[env.ix_crank()], &[&keeper]), PixelError::InvalidPriceSource);
    assert_err(env.send(&[env.ix_buy_token(&buyer.pubkey(), &ta, 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::InvalidPriceSource);
    assert_eq!(read_token_amount(&env.svm, &ta), SUPPLY / 10, "no tokens taken");

    // Even a wrongly seeded EMA stays unusable: the parser still refuses, so PUMP units can never become a SOL price.
    let admin = env.admin.insecure_clone();
    let ps = env.price_source();
    ok(env.send(&[env.ix_set_price_source(&admin.pubkey(), ps, 1_000_000)], &[&admin]));
    env.warp(31);
    env.refresh_price();
    assert_err(env.send(&[env.ix_crank()], &[&keeper]), PixelError::InvalidPriceSource);
    assert_err(env.send(&[env.ix_buy_token(&buyer.pubkey(), &ta, 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::InvalidPriceSource);
}

#[test]
fn vault_sol_is_safe_a_release_can_only_be_refunded() {
    let mut env = parked();
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 2, 2, u64::MAX)], &[&buyer]));
    let vault = env.lamports(&vault_pda());
    let keeper = env.keeper.insecure_clone();
    let (_, keeper_ta) = {
        let k = keeper.pubkey();
        let ta = Pubkey::new_unique();
        env.set_raw(ta, pack_token_account(&env.mint, &k, 1_000_000), TOKEN_2022);
        (k, ta)
    };

    // A release is the keeper's own trust domain, as on any coin; what matters is that spending it can't be recorded.
    ok(env.send(&[env.ix_release(&keeper.pubkey(), 100_000_000)], &[&keeper]));
    env.warp(1);
    assert_err(env.send(&[env.ix_record(&keeper.pubkey(), &keeper_ta, 100_000_000, 1_000_000)], &[&keeper]), PixelError::EmaWarmingUp);

    // record(0, 0) needs no price and hands everything back.
    ok(env.send(&[env.ix_record(&keeper.pubkey(), &keeper_ta, 0, 0)], &[&keeper]));
    assert_eq!(env.lamports(&vault_pda()), vault);
    assert_eq!(env.config().buyback_outstanding_lamports, 0);
    assert_eq!(env.canvas().lamports_spent_buyback, 0);
}

#[test]
fn canonical_wsol_pool_is_the_only_pool_this_binary_accepts() {
    // A PUMP pair graduates to a pool whose PDA has PUMP in its seeds. Today's set_price_source refuses it: only the upgrade can switch.
    let mut env = parked();
    let admin = env.admin.insecure_clone();
    let auth = Pubkey::find_program_address(&[b"pool-authority", env.mint.as_ref()], &PUMP_PROGRAM_ID).0;
    let pool = Pubkey::find_program_address(&[b"pool", &0u16.to_le_bytes(), auth.as_ref(), env.mint.as_ref(), PUMP_MINT.as_ref()], &PUMP_AMM_PROGRAM_ID).0;
    let base = Pubkey::find_program_address(&[pool.as_ref(), TOKEN_2022.as_ref(), env.mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM_ID).0;
    let quote = Pubkey::find_program_address(&[pool.as_ref(), TOKEN_2022.as_ref(), PUMP_MINT.as_ref()], &ASSOCIATED_TOKEN_PROGRAM_ID).0;
    let ps = PriceSource::Pool { pool, base_vault: base, quote_vault: quote };
    assert_err(env.send(&[env.ix_set_price_source(&admin.pubkey(), ps, 0)], &[&admin]), PixelError::InvalidParam);
}

// ------------------------------------------------------------- real mainnet bytes, read 2026-11-05 (public accounts)
/// Coin 69GLwTLV...: a real PUMP-paired create_v2 mint (Token-2022, metadata extensions only) and its curve.
const REAL_MINT: Pubkey = anchor_lang::pubkey!("69GLwTLVuwnaeNPjUixo6CSXKkEYeQ2WQrBVwmQKhT4C");
const REAL_MINT_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000000000000080c6a47e8d030006010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011200400000000000000000000000000000000000000000000000000000000000000000004c686e2c5c1457c7dc061532f2d0b0bc22b0534d5e727cad2539354a3e25ff211300970000000000000000000000000000000000000000000000000000000000000000004c686e2c5c1457c7dc061532f2d0b0bc22b0534d5e727cad2539354a3e25ff21080000006361746f6e6d6163030000006d61633c00000068747470733a2f2f6d657461646174612e6a37747261636b65722e696f2f6d657461646174612f366633633233663138343034346539382e6a736f6e00000000";
const REAL_CURVE_HEX: &str = "17b7f83760d8ac600010d847e3cf03004daf6132a50000000078c5fb51d1020000000000000000000080c6a47e8d030000d4b539b6672c40de1adf4e43044a005bd4becbfeecbcf350d4a076396e395a6c00000c45f7df8d9e72956284933f6d98b757032e83df84604fb5e117fff61d5b12f92c01000000000000000000000000000000000000000000000000004daf6132a500000000000000000000000000000000000000";
/// The other layouts seen on PUMP-quoted curves. Only the bytes are real here: they sit at the test coin's curve address.
const REAL_CURVE_151_HEX: &str = "17b7f83760d8ac600010d847e3cf0300259ec065e80000000078c5fb51d1020001000000000000000080c6a47e8d030000842073232a7449f62a1c184472024423209c33d5b6ad84aa442fae9bda15b95800000c45f7df8d9e72956284933f6d98b757032e83df84604fb5e117fff61d5b12f92c0100000000000000000000000000000000000000000000000000000000000000000000";
const REAL_CURVE_141_HEX: &str = "17b7f83760d8ac600010d847e3cf0300842cfe73800000000078c5fb51d1020002000000000000000080c6a47e8d03000094f4be1825475d12706714306da5e87bd6ee05e26756ba36840b74be572a48fe00000c45f7df8d9e72956284933f6d98b757032e83df84604fb5e117fff61d5b12f90000000000000000000100000000000000000000000000000000";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// The real coin at its real addresses: the canonical-curve check passes on the real mint, not on a fixture chosen to pass it.
fn real_coin() -> Env {
    let mut env = Env::new(TOKEN_2022, Source::Curve);
    env.initial_ema = 0;
    env.mint = REAL_MINT;
    env.curve = Pubkey::find_program_address(&[b"bonding-curve", REAL_MINT.as_ref()], &PUMP_PROGRAM_ID).0;
    assert_eq!(env.curve, anchor_lang::pubkey!("1243xDdU9d4F7s2hEAwi2oZwNTRWpvAPJhPXFsupR86"));
    env.set_raw(REAL_MINT, unhex(REAL_MINT_HEX), TOKEN_2022);
    env.set_raw(env.curve, unhex(REAL_CURVE_HEX), PUMP_PROGRAM_ID);
    let admin = env.admin.insecure_clone();
    ok(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]));
    env
}

#[test]
fn real_bytes_the_curve_is_what_we_think_it_is() {
    let d = unhex(REAL_CURVE_HEX);
    assert_eq!(d[..8], PUMP_BONDING_CURVE_DISCRIMINATOR);
    assert_eq!(d[83..115], PUMP_MINT.to_bytes());
    assert_eq!(d[48], 0, "not complete");
    assert_eq!(d[81], 0, "not mayhem");
    let vt = u64::from_le_bytes(d[8..16].try_into().unwrap());
    assert!(vt > 0);
}

#[test]
fn real_bytes_initialize_seed_zero_then_sol_buy_splits() {
    let mut env = real_coin();
    let c = env.config();
    assert_eq!(c.token_mint, REAL_MINT);
    assert_eq!(c.token_program, TOKEN_2022);
    assert_eq!(c.token_decimals, 6);
    assert_eq!(c.token_ema_price_sol, 0);

    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let (t0, v0) = (env.lamports(&env.treasury), env.lamports(&vault_pda()));
    let one = ref_lamports(100_000_000, SOL_PRICE);
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 3, 4, 1, 1, one)], &[&buyer]));
    assert_eq!(env.lamports(&env.treasury) - t0, one / 2);
    assert_eq!(env.lamports(&vault_pda()) - v0, one - one / 2);
    assert_eq!(env.canvas().sold_blocks, 1);
    assert_eq!(env.ad_at(3, 4).owner, buyer.pubkey());
}

#[test]
fn real_bytes_crank_is_refused_on_every_layout() {
    let mut env = real_coin();
    let keeper = env.keeper.insecure_clone();
    for hex in [REAL_CURVE_HEX, REAL_CURVE_151_HEX, REAL_CURVE_141_HEX] {
        env.set_raw(env.curve, unhex(hex), PUMP_PROGRAM_ID);
        env.warp(31);
        env.refresh_price();
        assert_err(env.send(&[env.ix_crank()], &[&keeper]), PixelError::InvalidPriceSource);
    }
}
