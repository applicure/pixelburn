use crate::common::*;
use pixel::{error::PixelError, events::AdPurchased, state::*};
use solana_signer::Signer;

fn token_happy(tp: anchor_lang::prelude::Pubkey, source: Source) {
    let mut env = Env::ready(tp, source);
    let (buyer, ta) = env.new_user(10_000_000_000, 500_000_000_000_000);
    let supply0 = read_mint_supply(&env.svm, &env.mint);
    let bal0 = read_token_amount(&env.svm, &ta);
    let v0 = env.lamports(&vault_pda());
    let t0 = env.lamports(&env.treasury);

    let pq = ref_price_q(CURVE_VSOL, CURVE_VTOK);
    let expected = ref_tokens(4, SOL_PRICE, pq);
    // slippage guard
    assert_err(env.send(&[env.ix_buy_token(&buyer.pubkey(), &ta, 0, 0, 2, 2, expected - 1)], &[&buyer]), PixelError::SlippageExceeded);
    let meta = ok(env.send(&[env.ix_buy_token(&buyer.pubkey(), &ta, 0, 0, 2, 2, expected)], &[&buyer]));

    // 100% burned: supply and balance drop by exactly the same amount
    assert_eq!(supply0 - read_mint_supply(&env.svm, &env.mint), expected);
    assert_eq!(bal0 - read_token_amount(&env.svm, &ta), expected);
    // no SOL moved to treasury / vault
    assert_eq!(env.lamports(&vault_pda()), v0);
    assert_eq!(env.lamports(&env.treasury), t0);

    let ad = env.ad_at(0, 0);
    assert_eq!(ad.pay_mode, PayMode::Token);
    assert_eq!(ad.paid_tokens, expected);
    assert_eq!(ad.usd_micro, 360_000_000); // $400 - 10%
    let c = env.canvas();
    assert_eq!(c.tokens_burned_direct, expected);
    assert_eq!(c.sold_blocks, 4);
    let ev = events::<AdPurchased>(&meta);
    assert_eq!(ev[0].tokens_burned, expected);
    assert_eq!(ev[0].pay_mode, PayMode::Token);
}

#[test]
fn buy_with_token_spl_curve() {
    token_happy(SPL_TOKEN, Source::Curve);
}
#[test]
fn buy_with_token_2022_curve() {
    token_happy(TOKEN_2022, Source::Curve);
}
#[test]
fn buy_with_token_spl_pool() {
    token_happy(SPL_TOKEN, Source::Pool);
}
#[test]
fn buy_with_token_2022_pool() {
    token_happy(TOKEN_2022, Source::Pool);
}

#[test]
fn pool_virtual_quote_reserves_respected() {
    let mut env = Env::ready(SPL_TOKEN, Source::Pool);
    let (buyer, ta) = env.new_user(10_000_000_000, 500_000_000_000_000);
    // Negative virtual quote reserves lower the effective price => more tokens owed (-10%, inside the 15% band).
    env.warp(EMA_SECS);
    env.refresh_price();
    env.set_pool(CURVE_VSOL, CURVE_VTOK, -3_000_000_000);
    let pq = ref_price_q(CURVE_VSOL - 3_000_000_000, CURVE_VTOK);
    let expected = ref_tokens(1, SOL_PRICE, pq);
    ok(env.send(&[env.ix_buy_token(&buyer.pubkey(), &ta, 0, 0, 1, 1, expected)], &[&buyer]));
    assert_eq!(env.ad_at(0, 0).paid_tokens, expected);
}
pub const EMA_SECS: i64 = 31;

#[test]
fn wrong_token_account_owner_or_mint_rejected() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _ta) = env.new_user(10_000_000_000, 0);
    let (_victim, victim_ta) = env.new_user(10_000_000_000, 500_000_000_000_000);
    // burning from someone else's account: token::authority constraint
    assert_code(env.send(&[env.ix_buy_token(&buyer.pubkey(), &victim_ta, 0, 0, 1, 1, u64::MAX)], &[&buyer]), 2015); // ConstraintTokenOwner
    // a different mint
    let other_mint = anchor_lang::prelude::Pubkey::new_unique();
    env.set_raw(other_mint, pack_mint(SUPPLY, DECIMALS, None), SPL_TOKEN);
    let mut ix = env.ix_buy_token(&buyer.pubkey(), &victim_ta, 0, 0, 1, 1, u64::MAX);
    ix.accounts[4].pubkey = other_mint;
    assert_err(env.send(&[ix], &[&buyer]), PixelError::InvalidParam); // has_one token_mint
}

#[test]
fn insufficient_token_balance_fails_atomically() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, ta) = env.new_user(10_000_000_000, 1_000);
    let r = env.send(&[env.ix_buy_token(&buyer.pubkey(), &ta, 0, 0, 1, 1, u64::MAX)], &[&buyer]);
    assert!(r.is_err());
    assert_eq!(env.canvas().sold_blocks, 0);
    assert!(env.svm.get_account(&ad_pda(0, 0)).is_none() || env.svm.get_account(&ad_pda(0, 0)).unwrap().lamports == 0);
}
