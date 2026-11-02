//! Compute-unit report for every instruction (numbers feed the SDK's CU limits; see NOTES.md).
//! Run: cargo test --test all cu_report -- --nocapture
use crate::common::*;
use pixel::constants::*;
use solana_signer::Signer;

fn cu(name: &str, m: &litesvm::types::TransactionMetadata, out: &mut Vec<(String, u64)>) {
    // `send` prepends a SetComputeUnitLimit ix (150 CU), which is included here: a slight over-estimate.
    out.push((name.to_string(), m.compute_units_consumed));
}

#[test]
fn cu_report() {
    let mut out = vec![];
    for (tp, src, tag) in [(SPL_TOKEN, Source::Curve, "spl/curve"), (TOKEN_2022, Source::Pool, "t22/pool")] {
        let mut env = Env::new(tp, src);
        let admin = env.admin.insecure_clone();
        let m = ok(env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]));
        cu(&format!("initialize ({tag})"), &m, &mut out);
        env.warp(30);
        env.refresh_price();
        let m = ok(env.send(&[env.ix_crank()], &[&admin]));
        cu(&format!("crank_token_price first ({tag})"), &m, &mut out);
        env.warm_up();
        env.warp(30);
        env.refresh_price();
        let m = ok(env.send(&[env.ix_crank()], &[&admin]));
        cu(&format!("crank_token_price ({tag})"), &m, &mut out);
        env.warp(1);
        env.refresh_price();
        let (buyer, ta) = env.new_user(20_000_000_000_000, 900_000_000_000_000);
        let b = buyer.pubkey();
        let m = ok(env.send(&[env.ix_buy_token(&b, &ta, 0, 0, 1, 1, u64::MAX)], &[&buyer]));
        cu(&format!("buy_with_token 1x1 ({tag})"), &m, &mut out);
        let m = ok(env.send(&[env.ix_buy_token(&b, &ta, 0, 10, 5, 4, u64::MAX)], &[&buyer]));
        cu(&format!("buy_with_token 5x4 ({tag})"), &m, &mut out);
        let m = ok(env.send(&[env.ix_buy_sol(&b, 1, 0, 1, 1, u64::MAX)], &[&buyer]));
        cu(&format!("buy_with_sol 1x1 ({tag})"), &m, &mut out);
        let m = ok(env.send(&[env.ix_buy_sol(&b, 0, 50, 100, 50, u64::MAX)], &[&buyer]));
        cu(&format!("buy_with_sol 100x50 ({tag})"), &m, &mut out);
        let m = ok(env.send(&[env.ix_update_ad(&b, ad_pda(0, 0), "https://x.io")], &[&buyer]));
        cu("update_ad", &m, &mut out);
        let m = ok(env.send(&[env.ix_transfer_ad(&b, ad_pda(0, 0), admin.pubkey())], &[&buyer]));
        cu("transfer_ad", &m, &mut out);
        let kp = env.keeper.insecure_clone();
        let keeper_ta = anchor_lang::prelude::Pubkey::new_unique();
        let mint = env.mint;
        env.set_raw(keeper_ta, pack_token_account(&mint, &kp.pubkey(), 300_000_000_000_000), tp);
        let m = ok(env.send(&[env.ix_release(&kp.pubkey(), 1_000_000_000)], &[&kp]));
        cu("release_buyback", &m, &mut out);
        let m = ok(env.send(&[env.ix_record(&kp.pubkey(), &keeper_ta, 500_000_000, 100_000_000_000_000)], &[&kp]));
        cu(&format!("record_buyback_burn ({tag})"), &m, &mut out);
    }
    // auction ixs
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (w, _) = env.new_user(20_000_000_000_000, 0);
    let wk = w.pubkey();
    let m = ok(env.send(&[env.ix_buy_sol(&wk, 0, 0, 100, 99, u64::MAX)], &[&w]));
    cu("buy_with_sol 100x99", &m, &mut out);
    let m = ok(env.send(&[env.ix_start_auction(&wk)], &[&w]));
    cu("start_final_auction", &m, &mut out);
    let (a, _) = env.new_user(10_000_000_000, 0);
    let m = ok(env.send(&[env.ix_bid(&a.pubkey(), None, AUCTION_MIN_OPENING_BID_LAMPORTS)], &[&a]));
    cu("bid_final_auction (first)", &m, &mut out);
    let m = ok(env.send(&[env.ix_bid(&wk, Some(a.pubkey()), 1_000_000_000)], &[&w]));
    cu("bid_final_auction (with refund)", &m, &mut out);
    env.warp(AUCTION_DURATION_SECS);
    let m = ok(env.send(&[env.ix_settle(&wk)], &[&w]));
    cu("settle_final_auction", &m, &mut out);

    println!("\n| instruction | CU |\n|---|---|");
    for (n, c) in &out {
        println!("| {n} | {c} |");
    }
    // Must stay <= the limits @mpb/sdk requests (src/compute.ts). Buys: base + per-row cost (rows dominate).
    let rows = |name: &str| -> u64 {
        name.split_whitespace()
            .find(|t| t.contains('x') && t.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .and_then(|t| t.split('x').nth(1))
            .and_then(|h| h.parse().ok())
            .unwrap_or(100)
    };
    let budget = |name: &str| -> u64 {
        match name {
            n if n.starts_with("buy_with_sol") => 50_000 + 1_200 * rows(n),
            n if n.starts_with("buy_with_token") => 65_000 + 1_200 * rows(n),
            n if n.starts_with("crank") => 20_000,
            n if n.starts_with("record_buyback_burn") => 40_000,
            n if n.starts_with("release_buyback") => 20_000,
            n if n.starts_with("start_final_auction") => 80_000,
            n if n.starts_with("settle_final_auction") => 70_000,
            n if n.starts_with("bid_final_auction") => 20_000,
            n if n.starts_with("initialize") => 60_000,
            _ => 15_000, // update_ad, transfer_ad
        }
    };
    for (n, c) in &out {
        assert!(*c <= budget(n), "{n} uses {c} CU, over SDK budget {}", budget(n));
    }
}
