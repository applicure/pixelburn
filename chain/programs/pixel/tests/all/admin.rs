use anchor_lang::Space;
use crate::common::*;
use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, InstructionData, ToAccountMetas};
use pixel::{error::PixelError, instruction as ixs, state::*};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn initialize_only_by_upgrade_authority_and_once() {
    let mut env = Env::new(SPL_TOKEN, Source::Curve);
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    assert_err(env.send(&[env.ix_initialize(&attacker.pubkey())], &[&attacker]), PixelError::Unauthorized);
    let admin = env.admin.insecure_clone();
    // non-canonical bonding curve (not ["bonding-curve", mint] under pump) is rejected
    let good = env.curve;
    env.curve = Pubkey::new_unique();
    assert_err(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]), PixelError::InvalidParam);
    env.curve = good;
    ok(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]));
    let c = env.config();
    assert_eq!(c.admin, admin.pubkey());
    assert_eq!(c.token_mint, env.mint);
    assert_eq!(c.token_program, SPL_TOKEN);
    assert_eq!(c.token_decimals, DECIMALS);
    assert_eq!(c.max_price_age_secs, 60);
    assert!(env.lamports(&vault_pda()) >= env.svm.minimum_balance_for_rent_exemption(0));
    // second init fails (account already in use)
    assert!(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]).is_err());
}

#[test]
fn account_sizes() {
    println!("Config  {} bytes", 8 + Config::INIT_SPACE);
    println!("Canvas  {} bytes", 8 + Canvas::INIT_SPACE);
    println!("Ad      {} bytes", 8 + Ad::INIT_SPACE);
    println!("Auction {} bytes", 8 + Auction::INIT_SPACE);
    assert_eq!(8 + Config::INIT_SPACE, 544); // 32 bytes reserved
    assert_eq!(8 + Canvas::INIT_SPACE, 1_321);
    assert_eq!(8 + Ad::INIT_SPACE, 599);
    assert_eq!(8 + Auction::INIT_SPACE, 1_326);
}

#[test]
fn pause_blocks_buys_and_only_admin_can_pause() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let admin = env.admin.insecure_clone();
    let (buyer, ta) = env.new_user(100_000_000_000, 500_000_000_000_000);
    assert_err(env.send(&[env.ix_set_paused(&buyer.pubkey(), true)], &[&buyer]), PixelError::Unauthorized);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    assert!(env.config().paused);
    assert_err(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::Paused);
    assert_err(env.send(&[env.ix_buy_token(&buyer.pubkey(), &ta, 0, 0, 1, 1, u64::MAX)], &[&buyer]), PixelError::Paused);
    let kp = env.keeper.insecure_clone();
    assert_err(env.send(&[env.ix_release(&kp.pubkey(), 1)], &[&kp]), PixelError::Paused);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, u64::MAX)], &[&buyer]));
}

#[test]
fn setters_and_two_step_admin_transfer() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let admin = env.admin.insecure_clone();
    let new_admin = Keypair::new();
    let rando = Keypair::new();
    env.svm.airdrop(&new_admin.pubkey(), 1_000_000_000).unwrap();
    env.svm.airdrop(&rando.pubkey(), 1_000_000_000).unwrap();

    let t2 = Pubkey::new_unique();
    assert_err(env.send(&[env.ix_admin(&rando.pubkey(), ixs::SetTreasury { treasury: t2 })], &[&rando]), PixelError::Unauthorized);
    assert_err(env.send(&[env.ix_admin(&admin.pubkey(), ixs::SetTreasury { treasury: Pubkey::default() })], &[&admin]), PixelError::InvalidParam);
    ok(env.send(&[env.ix_admin(&admin.pubkey(), ixs::SetTreasury { treasury: t2 })], &[&admin]));
    assert_eq!(env.config().treasury, t2);
    ok(env.send(&[env.ix_admin(&admin.pubkey(), ixs::SetKeeper { keeper: rando.pubkey() })], &[&admin]));
    assert_eq!(env.config().keeper, rando.pubkey());
    assert_err(env.send(&[env.ix_admin(&admin.pubkey(), ixs::SetParams { max_price_age_secs: 301, buyback_cap_lamports_per_hour: 1, buyback_max_slippage_bps: 100, token_blocks_cap_per_hour: 1_000 })], &[&admin]), PixelError::InvalidParam);
    assert_err(env.send(&[env.ix_admin(&admin.pubkey(), ixs::SetParams { max_price_age_secs: 0, buyback_cap_lamports_per_hour: 1, buyback_max_slippage_bps: 100, token_blocks_cap_per_hour: 1_000 })], &[&admin]), PixelError::InvalidParam);
    assert_err(env.send(&[env.ix_admin(&admin.pubkey(), ixs::SetParams { max_price_age_secs: 30, buyback_cap_lamports_per_hour: 1, buyback_max_slippage_bps: 5_001, token_blocks_cap_per_hour: 1_000 })], &[&admin]), PixelError::InvalidParam);
    ok(env.send(&[env.ix_admin(&admin.pubkey(), ixs::SetParams { max_price_age_secs: 30, buyback_cap_lamports_per_hour: 7, buyback_max_slippage_bps: 100, token_blocks_cap_per_hour: 1_000 })], &[&admin]));
    let c = env.config();
    assert_eq!((c.max_price_age_secs, c.buyback_cap_lamports_per_hour, c.buyback_max_slippage_bps), (30, 7, 100));

    // a bonding curve that is not the canonical pump PDA of our mint is rejected
    let bad = PriceSource::BondingCurve { curve: Pubkey::new_unique() };
    assert_err(env.send(&[env.ix_set_price_source(&admin.pubkey(), bad, ref_price_q(CURVE_VSOL, CURVE_VTOK))], &[&admin]), PixelError::InvalidParam);
    let bad_pool = PriceSource::Pool { pool: env.pool, base_vault: env.pool_base_vault, quote_vault: env.pool_base_vault };
    assert_err(env.send(&[env.ix_set_price_source(&admin.pubkey(), bad_pool, ref_price_q(CURVE_VSOL, CURVE_VTOK))], &[&admin]), PixelError::InvalidParam);
    let good_curve = PriceSource::BondingCurve { curve: env.curve };
    ok(env.send(&[env.ix_set_price_source(&admin.pubkey(), good_curve, ref_price_q(CURVE_VSOL, CURVE_VTOK))], &[&admin]));
    // set_price_source resets the EMA
    let ps = PriceSource::Pool { pool: env.pool, base_vault: env.pool_base_vault, quote_vault: env.pool_quote_vault };
    ok(env.send(&[env.ix_set_price_source(&admin.pubkey(), ps, ref_price_q(CURVE_VSOL, CURVE_VTOK))], &[&admin]));
    assert_eq!(env.config().price_source, ps);
    // admin-supplied seed, warm-up restarts
    let c = env.config();
    assert_eq!(c.token_ema_price_sol, ref_price_q(CURVE_VSOL, CURVE_VTOK));
    assert_eq!(c.ema_warmup_cranks, 0);
    // M-2: a PumpSwap pool that is not the canonical migration pool of our mint is rejected
    let rogue = PriceSource::Pool { pool: Pubkey::new_unique(), base_vault: env.pool_base_vault, quote_vault: env.pool_quote_vault };
    assert_err(env.send(&[env.ix_set_price_source(&admin.pubkey(), rogue, 1)], &[&admin]), PixelError::InvalidParam);
    let wrong_vault = PriceSource::Pool { pool: env.pool, base_vault: Pubkey::new_unique(), quote_vault: env.pool_quote_vault };
    assert_err(env.send(&[env.ix_set_price_source(&admin.pubkey(), wrong_vault, 1)], &[&admin]), PixelError::InvalidParam);

    // two-step admin
    ok(env.send(&[env.ix_admin(&admin.pubkey(), ixs::ProposeAdmin { new_admin: new_admin.pubkey() })], &[&admin]));
    let accept = |who: &Pubkey| Instruction::new_with_bytes(pixel::id(), &ixs::AcceptAdmin {}.data(), pixel::accounts::AcceptAdmin { new_admin: *who, config: config_pda() }.to_account_metas(None));
    assert_err(env.send(&[accept(&rando.pubkey())], &[&rando]), PixelError::Unauthorized);
    assert_eq!(env.config().admin, admin.pubkey());
    ok(env.send(&[accept(&new_admin.pubkey())], &[&new_admin]));
    assert_eq!(env.config().admin, new_admin.pubkey());
    assert_eq!(env.config().pending_admin, Pubkey::default());
    // old admin is out
    assert_err(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]), PixelError::Unauthorized);
    ok(env.send(&[env.ix_set_paused(&new_admin.pubkey(), true)], &[&new_admin]));
    // accept cannot be replayed
    assert_err(env.send(&[accept(&new_admin.pubkey())], &[&new_admin]), PixelError::Unauthorized);
}
