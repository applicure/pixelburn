use crate::common::*;
use pixel::{error::PixelError, events::AdPurchased, state::*};
use solana_signer::Signer;

#[test]
fn buy_with_sol_happy_path_and_split() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let t0 = env.lamports(&env.treasury);
    let v0 = env.lamports(&vault_pda());

    // 1 block = $100 at $150 => 666_666_667 lamports (odd => split remainder goes to buyback)
    let expected = ref_lamports(100_000_000, SOL_PRICE);
    assert_eq!(expected, 666_666_667);
    let meta = ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, expected)], &[&buyer]));

    assert_eq!(env.lamports(&env.treasury) - t0, 333_333_333);
    assert_eq!(env.lamports(&vault_pda()) - v0, 333_333_334);

    let ad = env.ad_at(0, 0);
    assert_eq!(ad.owner, buyer.pubkey());
    assert_eq!((ad.x, ad.y, ad.w, ad.h), (0, 0, 1, 1));
    assert_eq!(ad.kind, AdKind::Rect);
    assert_eq!(ad.pay_mode, PayMode::Sol);
    assert_eq!(ad.paid_lamports, expected);
    assert_eq!(ad.usd_micro, 100_000_000);
    assert_eq!(ad.title, "Hello");
    assert_eq!(ad.image_sha256, [7u8; 32]);

    let c = env.canvas();
    assert_eq!(c.sold_blocks, 1);
    assert_eq!(c.next_ad_id, 1);
    assert_eq!(c.bitmap[0], 1);
    assert_eq!(c.lamports_raised, expected);
    assert_eq!(c.lamports_to_treasury, 333_333_333);
    assert_eq!(c.lamports_to_buyback, 333_333_334);
    assert_eq!(c.usd_micro_raised, 100_000_000);

    let ev = events::<AdPurchased>(&meta);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].ad_id, 0);
    assert_eq!(ev[0].lamports, expected);
    assert_eq!(ev[0].pay_mode, PayMode::Sol);

    // A larger, even-priced buy: 3x2 = $600 => 4 SOL exactly
    let l2 = ref_lamports(600_000_000, SOL_PRICE);
    assert_eq!(l2, 4_000_000_000);
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 10, 10, 3, 2, l2)], &[&buyer]));
    let c = env.canvas();
    assert_eq!(c.lamports_to_treasury + c.lamports_to_buyback, c.lamports_raised);
    assert_eq!(c.lamports_to_treasury, 333_333_333 + 2_000_000_000);
    assert_eq!(c.sold_blocks, 7);
}

#[test]
fn slippage_guard_sol() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let expected = ref_lamports(400_000_000, SOL_PRICE);
    assert_err(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 2, 2, expected - 1)], &[&buyer]), PixelError::SlippageExceeded);
    // SOL price drops => more lamports needed => old max fails
    env.set_sol_price(SOL_PRICE / 2, 1, env.now());
    assert_err(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 2, 2, expected)], &[&buyer]), PixelError::SlippageExceeded);
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 0, 2, 2, expected * 2)], &[&buyer]));
}

#[test]
fn overlap_and_edges() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _) = env.new_user(1_000_000_000_000, 0);
    let max = u64::MAX;
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 10, 10, 5, 5, max)], &[&buyer]));
    // exact overlaps / partial overlaps / corners
    // Same top-left block as an existing ad: the ad PDA already exists, so `init` fails (system "account in use",
    // code 0) before the handler runs. Still rejected, just with a different error.
    let r = env.send(&[env.ix_buy_sol(&buyer.pubkey(), 10, 10, 5, 5, max)], &[&buyer]);
    assert_eq!(custom_code(&r), Some(0));
    for (x, y, w, h) in [(14, 14, 1, 1), (6, 10, 5, 5), (14, 14, 5, 5), (0, 0, 11, 11), (12, 0, 1, 100)] {
        assert_err(env.send(&[env.ix_buy_sol(&buyer.pubkey(), x, y, w, h, max)], &[&buyer]), PixelError::Overlap);
    }
    // touching on every side is fine
    for (x, y, w, h) in [(5, 10, 5, 5), (15, 10, 5, 5), (10, 5, 5, 5), (10, 15, 5, 5)] {
        ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), x, y, w, h, max)], &[&buyer]));
    }
    // right/bottom canvas edges: x+w == 100, y+h == 100
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 90, 0, 10, 1, max)], &[&buyer]));
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 0, 99, 100, 1, max)], &[&buyer]));
    ok(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 99, 50, 1, 49, max)], &[&buyer]));
    assert_err(env.send(&[env.ix_buy_sol(&buyer.pubkey(), 99, 98, 1, 2, max)], &[&buyer]), PixelError::Overlap);
    let c = env.canvas();
    assert_eq!(c.sold_blocks as u32, 25 * 5 + 10 + 100 + 49);
    // popcount invariant
    let pop: u32 = c.bitmap.iter().map(|b| b.count_ones()).sum();
    assert_eq!(pop, c.sold_blocks as u32);
}

#[test]
fn out_of_bounds_and_content() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let b = buyer.pubkey();
    for (x, y, w, h) in [(99, 0, 2, 1), (0, 99, 1, 2), (100, 0, 1, 1), (0, 100, 1, 1), (0, 0, 0, 1), (0, 0, 1, 0), (0, 0, 101, 1), (200, 200, 100, 100)] {
        assert_err(env.send(&[env.ix_buy_sol(&b, x, y, w, h, u64::MAX)], &[&buyer]), PixelError::OutOfBounds);
    }
    let pu = env.price_update;
    let long_title = "x".repeat(65);
    assert_err(env.send(&[env.ix_buy_sol_full(&b, 0, 0, 1, 1, &long_title, "https://a.io", "ar://x", u64::MAX, pu)], &[&buyer]), PixelError::InvalidTitle);
    assert_err(env.send(&[env.ix_buy_sol_full(&b, 0, 0, 1, 1, "t", "http://a.io", "ar://x", u64::MAX, pu)], &[&buyer]), PixelError::InvalidLink);
    assert_err(env.send(&[env.ix_buy_sol_full(&b, 0, 0, 1, 1, "t", "https://a.io", "data:xx", u64::MAX, pu)], &[&buyer]), PixelError::InvalidImageUri);
    assert_eq!(env.canvas().sold_blocks, 0);
}

#[test]
fn wrong_treasury_rejected() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (buyer, _) = env.new_user(100_000_000_000, 0);
    let mut ix = env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, u64::MAX);
    // account index 4 = treasury
    ix.accounts[4].pubkey = buyer.pubkey();
    assert_err(env.send(&[ix], &[&buyer]), PixelError::Unauthorized);
    // wrong ad PDA (skipping an id) fails seeds check
    let mut ix = env.ix_buy_sol(&buyer.pubkey(), 0, 0, 1, 1, u64::MAX);
    ix.accounts[3].pubkey = ad_pda(5, 5);
    assert_code(env.send(&[ix], &[&buyer]), 2006); // ConstraintSeeds
}

#[test]
fn concurrent_buyers_of_disjoint_rects_both_land() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (alice, _) = env.new_user(100_000_000_000, 0);
    let (bob, _) = env.new_user(100_000_000_000, 0);
    // Both txs are built from the same canvas state before either lands.
    let ix_a = env.ix_buy_sol(&alice.pubkey(), 0, 0, 2, 2, u64::MAX);
    let ix_b = env.ix_buy_sol(&bob.pubkey(), 2, 0, 3, 1, u64::MAX);
    ok(env.send(&[ix_a], &[&alice]));
    ok(env.send(&[ix_b], &[&bob]));
    let (a, b) = (env.ad_at(0, 0), env.ad_at(2, 0));
    assert_eq!((a.owner, a.id), (alice.pubkey(), 0));
    assert_eq!((b.owner, b.id), (bob.pubkey(), 1), "display id comes from the counter inside the ix");
    assert_eq!(env.canvas().next_ad_id, 2);

    // Same top-left block: the second buyer fails (ad account already exists), canvas unchanged.
    let (carol, _) = env.new_user(100_000_000_000, 0);
    let r = env.send(&[env.ix_buy_sol(&carol.pubkey(), 0, 0, 1, 1, u64::MAX)], &[&carol]);
    assert!(r.is_err());
    // Overlapping but different top-left block: Overlap error.
    assert_err(env.send(&[env.ix_buy_sol(&carol.pubkey(), 1, 1, 1, 1, u64::MAX)], &[&carol]), PixelError::Overlap);
    assert_eq!(env.canvas().sold_blocks, 7);
    // The ad PDA is tied to (x, y): passing another block's PDA fails the seeds check.
    let mut ix = env.ix_buy_sol(&carol.pubkey(), 50, 50, 1, 1, u64::MAX);
    ix.accounts[3].pubkey = ad_pda(51, 50);
    assert_code(env.send(&[ix], &[&carol]), 2006);
    // Two disjoint buys in one tx also work.
    let (dave, _) = env.new_user(100_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&dave.pubkey(), 60, 60, 1, 1, u64::MAX), env.ix_buy_sol(&dave.pubkey(), 61, 60, 1, 1, u64::MAX)], &[&dave]));
    assert_eq!(env.ad_at(61, 60).id, 3);
}
