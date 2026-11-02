use crate::common::*;
use pixel::{constants::{MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR, PRICE_SCALE, PUMP_PROGRAM_ID}, error::PixelError, events::BuybackBurned};
use solana_signer::Signer;

fn fund_vault(env: &mut Env, sol_blocks: u8) {
    let (buyer, _) = env.new_user(1_000_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 50, sol_blocks, 1, u64::MAX)], &[&buyer]));
}

#[test]
fn release_caps_and_record_burn() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    fund_vault(&mut env, 30); // $3000 => 20 SOL => 10 SOL to vault
    let kp = env.keeper.insecure_clone();
    let (rando, _) = env.new_user(1_000_000_000, 0);
    let keeper_ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(keeper_ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);

    // only keeper
    assert_err(env.send(&[env.ix_release(&rando.pubkey(), 1_000_000_000)], &[&rando]), PixelError::Unauthorized);
    // cap: 5 SOL / hour (set in harness)
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 5_000_000_001)], &[&kp]), PixelError::BuybackCapExceeded);
    let k0 = env.lamports(&kp.pubkey());
    let v0 = env.lamports(&vault_pda());
    ok(env.send(&[env.ix_release(&kp.pubkey(), 3_000_000_000)], &[&kp]));
    assert_eq!(env.lamports(&vault_pda()), v0 - 3_000_000_000);
    assert!(env.lamports(&kp.pubkey()) > k0 + 2_999_000_000);
    assert_eq!(env.config().buyback_outstanding_lamports, 3_000_000_000);
    // cannot release again until recorded
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 1)], &[&kp]), PixelError::BuybackOutstanding);
    let admin = env.admin.insecure_clone();

    // record: spent 2 SOL, must burn >= 2 SOL worth at the EMA minus 15% slippage
    let pq = ref_price_q(CURVE_VSOL, CURVE_VTOK);
    let fair = (2_000_000_000u128 * 1_000_000_000_000_000_000u128 / pq) as u64;
    let min = (fair as u128 * 8_500 / 10_000) as u64;
    assert_err(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 2_000_000_000, min - 1)], &[&kp]), PixelError::BuybackRateTooLow);
    assert_err(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 3_000_000_001, fair * 2)], &[&kp]), PixelError::BuybackAmountTooHigh);
    assert_err(env.send(&[env.ix_record(&rando.pubkey(), &keeper_ta, 2_000_000_000, fair)], &[&rando]), PixelError::Unauthorized);

    let supply0 = read_mint_supply(&env.svm, &env.mint);
    let v1 = env.lamports(&vault_pda());
    let m = ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 2_000_000_000, fair)], &[&kp]));
    assert_eq!(supply0 - read_mint_supply(&env.svm, &env.mint), fair, "burn decreased supply");
    assert_eq!(env.lamports(&vault_pda()) - v1, 1_000_000_000, "unspent returned");
    let c = env.canvas();
    assert_eq!(c.tokens_burned_buyback, fair);
    assert_eq!(c.lamports_spent_buyback, 2_000_000_000);
    assert_eq!(env.config().buyback_outstanding_lamports, 0);
    let ev = &events::<BuybackBurned>(&m)[0];
    assert_eq!((ev.lamports_in, ev.tokens_burned), (2_000_000_000, fair));
    // nothing outstanding => cannot record (no fake burns inflating stats)
    assert_err(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 0, 1)], &[&kp]), PixelError::InvalidParam);

    // window: 3 SOL used of 5 in this hour
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 2_000_000_001)], &[&kp]), PixelError::BuybackCapExceeded);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 2_000_000_000)], &[&kp]));
    ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 0, 0)], &[&kp])); // full refund
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 1)], &[&kp]), PixelError::BuybackCapExceeded);
    // next hour the window resets
    env.warp(3_600);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 4_000_000_000)], &[&kp]));
    // EMA is now > 15 min old: spending cannot be reconciled until someone cranks; a full refund still can
    assert_err(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 1, 1_000_000_000)], &[&kp]), PixelError::EmaUnavailable);
    ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 0, 0)], &[&kp]));
    // vault rent reserve is never released
    let avail = env.lamports(&vault_pda()) - env.svm.minimum_balance_for_rent_exemption(0);
    assert_err(env.send(&[env.ix_admin(&admin.pubkey(), pixel::instruction::SetParams { max_price_age_secs: 60, buyback_cap_lamports_per_hour: MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR + 1, buyback_max_slippage_bps: 1_500, token_blocks_cap_per_hour: 1_000 })], &[&admin]), PixelError::InvalidParam);
    ok(env.send(&[env.ix_admin(&admin.pubkey(), pixel::instruction::SetParams { max_price_age_secs: 60, buyback_cap_lamports_per_hour: MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR, buyback_max_slippage_bps: 1_500, token_blocks_cap_per_hour: 1_000 })], &[&admin]));
    env.warp(3_600);
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), avail + 1)], &[&kp]), PixelError::InsufficientVaultFunds);
    ok(env.send(&[env.ix_release(&kp.pubkey(), avail)], &[&kp]));
}

#[test]
fn rotating_a_non_reconciling_keeper_writes_off_outstanding() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    fund_vault(&mut env, 10);
    let kp = env.keeper.insecure_clone();
    let admin = env.admin.insecure_clone();
    let (new_keeper, _) = env.new_user(1_000_000_000, 0);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 1_000_000_000)], &[&kp]));
    let m = ok(env.send(&[env.ix_admin(&admin.pubkey(), pixel::instruction::SetKeeper { keeper: new_keeper.pubkey() })], &[&admin]));
    let ev = &events::<pixel::events::BuybackWrittenOff>(&m)[0];
    assert_eq!((ev.keeper, ev.lamports), (kp.pubkey(), 1_000_000_000));
    let c = env.config();
    assert_eq!(c.keeper, new_keeper.pubkey());
    assert_eq!(c.buyback_outstanding_lamports, 0);
    assert_eq!(c.buyback_written_off_lamports, 1_000_000_000);
    // old keeper is locked out, new keeper can operate (hourly cap still counts the written-off release)
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 1)], &[&kp]), PixelError::Unauthorized);
    ok(env.send(&[env.ix_release(&new_keeper.pubkey(), 1_000_000_000)], &[&new_keeper]));
    assert_err(env.send(&[env.ix_release(&new_keeper.pubkey(), 1)], &[&new_keeper]), PixelError::BuybackOutstanding);
}

#[test]
fn record_burn_token_2022() {
    let mut env = Env::ready(TOKEN_2022, Source::Pool);
    fund_vault(&mut env, 10);
    let kp = env.keeper.insecure_clone();
    let keeper_ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(keeper_ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 1_000_000_000)], &[&kp]));
    let supply0 = read_mint_supply(&env.svm, &env.mint);
    let fair = (1_000_000_000u128 * 1_000_000_000_000_000_000u128 / ref_price_q(CURVE_VSOL, CURVE_VTOK)) as u64;
    ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 1_000_000_000, fair)], &[&kp]));
    assert_eq!(supply0 - read_mint_supply(&env.svm, &env.mint), fair);
}

#[test]
fn keeper_cannot_lower_the_bar_by_pumping_spot() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    fund_vault(&mut env, 10);
    let kp = env.keeper.insecure_clone();
    let keeper_ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(keeper_ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 1_000_000_000)], &[&kp]));
    let fair = (1_000_000_000u128 * 1_000_000_000_000_000_000u128 / ref_price_q(CURVE_VSOL, CURVE_VTOK)) as u64;
    // spot pumped 10x (and even cranked in the same tx): the bar stays at the pre-slot EMA
    env.warp(31);
    env.set_curve(CURVE_VSOL * 10, CURVE_VTOK);
    assert_err(env.send(&[env.ix_crank(), env.ix_record(&kp.pubkey(), &keeper_ta, 1_000_000_000, fair / 10)], &[&kp]), PixelError::BuybackRateTooLow);
    // with the pump unwound (post-trade spot back near the EMA, inside the backstop band) the honest record passes
    env.set_curve(CURVE_VSOL, CURVE_VTOK);
    ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 1_000_000_000, fair * 85 / 100 + 1)], &[&kp]));
}

// ------------------------------------------------------------------ backstop: buyback must not push spot out of band

/// Keeper-style atomic tx: release + (buy, simulated by setting reserves before the tx) + record, spot at `spot_mult_bps`
/// of the fast EMA after the "buy". Returns the result and checks atomicity on failure.
fn atomic_buyback(env: &mut Env, spot_mult_bps: u128) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let kp = env.keeper.insecure_clone();
    let keeper_ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(keeper_ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);
    let ema = env.config().token_ema_price_sol;
    let post = ema * spot_mult_bps / 10_000;
    env.set_spot((post * CURVE_VTOK as u128 / PRICE_SCALE) as u64, CURVE_VTOK);
    let fair = (100_000_000u128 * PRICE_SCALE / ema) as u64;
    env.send(&[env.ix_release(&kp.pubkey(), 100_000_000), env.ix_record(&kp.pubkey(), &keeper_ta, 100_000_000, fair)], &[&kp])
}

fn backstop_case(tp: anchor_lang::prelude::Pubkey, src: Source) {
    let mut env = Env::ready(tp, src);
    fund_vault(&mut env, 10);
    let vault0 = env.lamports(&vault_pda());
    let supply0 = read_mint_supply(&env.svm, &env.mint);
    // +13% after the buy: above fast EMA * 1.12 -> the whole tx (release + record) reverts
    let r = atomic_buyback(&mut env, 11_300);
    assert_err(r, PixelError::BuybackPushesPriceOutOfBand);
    assert_eq!(env.lamports(&vault_pda()), vault0, "vault unchanged");
    assert_eq!(read_mint_supply(&env.svm, &env.mint), supply0, "nothing burned");
    let c = env.config();
    assert_eq!(c.buyback_outstanding_lamports, 0, "no release left outstanding");
    assert_eq!(c.buyback_allowance, c.buyback_cap_lamports_per_hour, "allowance untouched");
    // exactly at the ceiling (+12%) and inside it (+5%) -> passes
    env.warp(31);
    env.refresh_price();
    ok(atomic_buyback(&mut env, 11_200));
    env.warp(31);
    env.refresh_price();
    ok(atomic_buyback(&mut env, 10_500));
    assert!(read_mint_supply(&env.svm, &env.mint) < supply0);
    assert_eq!(env.config().buyback_outstanding_lamports, 0);
    // a pure refund needs no price (works even far out of band)
    let kp = env.keeper.insecure_clone();
    let ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp2) = (env.mint, env.token_program);
    env.set_raw(ta, pack_token_account(&mint, &kp.pubkey(), 1), tp2);
    let e = env.config().token_ema_price_sol;
    env.set_spot((e * 2 * CURVE_VTOK as u128 / PRICE_SCALE) as u64, CURVE_VTOK);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 1_000_000), env.ix_record(&kp.pubkey(), &ta, 0, 0)], &[&kp]));
}

#[test]
fn backstop_buyback_cannot_push_spot_out_of_band_curve() {
    backstop_case(SPL_TOKEN, Source::Curve);
}

#[test]
fn backstop_buyback_cannot_push_spot_out_of_band_pool() {
    backstop_case(TOKEN_2022, Source::Pool);
}

#[test]
fn backstop_rejects_substituted_price_accounts() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    fund_vault(&mut env, 10);
    let kp = env.keeper.insecure_clone();
    let ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);
    // keeper passes a fake "curve" with a low price to dodge the backstop
    let fake = anchor_lang::prelude::Pubkey::new_unique();
    env.set_raw(fake, pack_curve(CURVE_VSOL, CURVE_VTOK, false, anchor_lang::prelude::Pubkey::default()), PUMP_PROGRAM_ID);
    let fair = (100_000_000u128 * PRICE_SCALE / env.config().token_ema_price_sol) as u64;
    let mut rec = env.ix_record(&kp.pubkey(), &ta, 100_000_000, fair);
    let idx = rec.accounts.iter().position(|m| m.pubkey == env.curve).unwrap();
    rec.accounts[idx].pubkey = fake;
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 100_000_000), rec], &[&kp]), PixelError::InvalidPriceSource);
}

// ------------------------------------------------------------------ backstop: auditor's optional tests

fn keeper_with_tokens(env: &mut Env) -> (solana_keypair::Keypair, anchor_lang::prelude::Pubkey) {
    let kp = env.keeper.insecure_clone();
    let ta = anchor_lang::prelude::Pubkey::new_unique();
    let (mint, tp) = (env.mint, env.token_program);
    env.set_raw(ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);
    (kp, ta)
}

#[test]
fn backstop_pool_source_with_vaults_omitted_is_rejected() {
    let mut env = Env::ready(SPL_TOKEN, Source::Pool);
    fund_vault(&mut env, 10);
    let (kp, ta) = keeper_with_tokens(&mut env);
    let fair = (100_000_000u128 * PRICE_SCALE / env.config().token_ema_price_sol) as u64;
    let mut rec = env.ix_record(&kp.pubkey(), &ta, 100_000_000, fair);
    for v in [env.pool_base_vault, env.pool_quote_vault] {
        let i = rec.accounts.iter().position(|m| m.pubkey == v).unwrap();
        rec.accounts[i] = anchor_lang::solana_program::instruction::AccountMeta::new_readonly(pixel::id(), false); // Anchor None
    }
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 100_000_000), rec], &[&kp]), PixelError::InvalidPriceSource);
    assert_eq!(env.config().buyback_outstanding_lamports, 0);
}

#[test]
fn backstop_pool_source_with_curve_key_is_rejected() {
    let mut env = Env::ready(SPL_TOKEN, Source::Pool);
    fund_vault(&mut env, 10);
    let (kp, ta) = keeper_with_tokens(&mut env);
    // a valid-looking pump curve (canonical PDA of our mint, pump-owned) passed where the pool is expected
    let curve = env.curve;
    env.set_raw(curve, pack_curve(CURVE_VSOL, CURVE_VTOK, false, anchor_lang::prelude::Pubkey::default()), PUMP_PROGRAM_ID);
    let fair = (100_000_000u128 * PRICE_SCALE / env.config().token_ema_price_sol) as u64;
    let mut rec = env.ix_record(&kp.pubkey(), &ta, 100_000_000, fair);
    let i = rec.accounts.iter().position(|m| m.pubkey == env.pool).unwrap();
    rec.accounts[i].pubkey = curve;
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 100_000_000), rec], &[&kp]), PixelError::InvalidPriceSource);
    assert_eq!(env.config().buyback_outstanding_lamports, 0);
}

#[test]
fn backstop_stale_ema_rejects_spend_but_refund_passes() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    fund_vault(&mut env, 10);
    let (kp, ta) = keeper_with_tokens(&mut env);
    ok(env.send(&[env.ix_release(&kp.pubkey(), 100_000_000)], &[&kp]));
    env.warp(MAX_EMA_AGE_SECS_T + 1); // EMA older than 900 s, no crank
    let fair = (100_000_000u128 * PRICE_SCALE / env.config().token_ema_price_sol) as u64;
    assert_err(env.send(&[env.ix_record(&kp.pubkey(), &ta, 100_000_000, fair)], &[&kp]), PixelError::EmaUnavailable);
    assert_eq!(env.config().buyback_outstanding_lamports, 100_000_000, "spend path rejected, release still outstanding");
    let v0 = env.lamports(&vault_pda());
    ok(env.send(&[env.ix_record(&kp.pubkey(), &ta, 0, 0)], &[&kp]));
    assert_eq!(env.config().buyback_outstanding_lamports, 0);
    assert_eq!(env.lamports(&vault_pda()) - v0, 100_000_000, "full refund to the vault");
}
const MAX_EMA_AGE_SECS_T: i64 = pixel::constants::MAX_EMA_AGE_SECS;
