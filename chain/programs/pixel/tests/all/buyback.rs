use crate::common::*;
use pixel::{constants::MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR, error::PixelError, events::BuybackBurned};
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
    ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 1_000_000_000, fair * 85 / 100 + 1)], &[&kp]));
}
