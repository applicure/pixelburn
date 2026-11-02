use anchor_lang::Space;
use crate::common::*;
use pixel::{constants::*, error::PixelError, events::*, state::*};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Sells exactly 9_901 blocks, crossing the threshold with the last purchase, leaving 99 free:
/// column 99 rows 2..=99 and block (98, 99).
fn fill_to_threshold(env: &mut Env) -> Keypair {
    let (whale, _) = env.new_user(20_000_000_000_000, 0);
    let w = whale.pubkey();
    let m = ok(env.send(&[env.ix_buy_sol(&w, 0, 0, 99, 99, u64::MAX)], &[&whale]));
    println!("CU for a 99x99 buy: {}", m.compute_units_consumed);
    assert!(m.compute_units_consumed < 200_000, "fits the default CU budget");
    ok(env.send(&[env.ix_buy_sol(&w, 0, 99, 98, 1, u64::MAX)], &[&whale]));
    assert_eq!(env.canvas().sold_blocks, 9_899);
    // start before threshold
    assert_err(env.send(&[env.ix_start_auction(&w)], &[&whale]), PixelError::AuctionThresholdNotReached);
    // 9_899 < 9_900 => this purchase is still allowed and crosses the threshold
    ok(env.send(&[env.ix_buy_sol(&w, 99, 0, 1, 2, u64::MAX)], &[&whale]));
    assert_eq!(env.canvas().sold_blocks, 9_901);
    assert_err(env.send(&[env.ix_buy_sol(&w, 99, 50, 1, 1, u64::MAX)], &[&whale]), PixelError::SalesClosed);
    whale
}

fn bit(bm: &[u8], x: usize, y: usize) -> bool {
    let i = y * 100 + x;
    bm[i / 8] & (1 << (i % 8)) != 0
}

#[test]
fn auction_full_cycle_with_refunds() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let whale = fill_to_threshold(&mut env);
    let (alice, _) = env.new_user(10_000_000_000, 0);
    let (bob, _) = env.new_user(10_000_000_000, 0);
    let (a, b) = (alice.pubkey(), bob.pubkey());

    // bidding before start: auction account doesn't exist
    assert!(env.send(&[env.ix_bid(&a, None, 200_000_000)], &[&alice]).is_err());

    let m = ok(env.send(&[env.ix_start_auction(&whale.pubkey())], &[&whale]));
    let ev = &events::<AuctionStarted>(&m)[0];
    assert_eq!(ev.lot_blocks, 99);
    assert_eq!(ev.end_ts - ev.start_ts, AUCTION_DURATION_SECS);
    let au = env.auction();
    assert_eq!(au.lot_blocks, 99);
    assert!(bit(&au.lot_bitmap, 99, 2) && bit(&au.lot_bitmap, 99, 99) && bit(&au.lot_bitmap, 98, 99));
    assert!(!bit(&au.lot_bitmap, 99, 1) && !bit(&au.lot_bitmap, 0, 0) && !bit(&au.lot_bitmap, 97, 99));
    // cannot start twice
    assert!(env.send(&[env.ix_start_auction(&whale.pubkey())], &[&whale]).is_err());

    // opening bid rules
    assert_err(env.send(&[env.ix_bid(&a, None, AUCTION_MIN_OPENING_BID_LAMPORTS - 1)], &[&alice]), PixelError::BidTooLow);
    let a0 = env.lamports(&a);
    ok(env.send(&[env.ix_bid(&a, None, 100_000_000)], &[&alice]));
    let a_after_bid = env.lamports(&a);
    assert!(a0 - a_after_bid >= 100_000_000);
    let rent = env.svm.minimum_balance_for_rent_exemption(8 + Auction::INIT_SPACE);
    assert_eq!(env.lamports(&auction_pda()), rent + 100_000_000);
    assert_err(env.send(&[env.ix_bid(&a, Some(a), 200_000_000)], &[&alice]), PixelError::AlreadyHighestBidder);

    // outbid needs +max(5%, 0.01 SOL) and the right previous bidder account
    assert_err(env.send(&[env.ix_bid(&b, Some(a), 109_999_999)], &[&bob]), PixelError::BidTooLow);
    assert_err(env.send(&[env.ix_bid(&b, None, 110_000_000)], &[&bob]), PixelError::InvalidPreviousBidder);
    assert_err(env.send(&[env.ix_bid(&b, Some(whale.pubkey()), 110_000_000)], &[&bob]), PixelError::InvalidPreviousBidder);
    let a_before_outbid = env.lamports(&a); // failed txs above still charged alice fees
    assert!(a_before_outbid <= a_after_bid);
    let m = ok(env.send(&[env.ix_bid(&b, Some(a), 110_000_000)], &[&bob]));
    assert_eq!(env.lamports(&a), a_before_outbid + 100_000_000, "alice refunded in the same ix");
    assert_eq!(env.lamports(&auction_pda()), rent + 110_000_000);
    let ev = &events::<AuctionBid>(&m)[0];
    assert_eq!((ev.bidder, ev.lamports), (b, 110_000_000));

    // not over yet
    assert_err(env.send(&[env.ix_settle(&b)], &[&bob]), PixelError::AuctionNotEnded);

    // anti-sniping: a bid 5 minutes before the end extends to now + 10 min
    let end = env.auction().end_ts;
    let now = env.now();
    env.warp(end - now - 300);
    ok(env.send(&[env.ix_bid(&a, Some(b), 200_000_000)], &[&alice]));
    let au = env.auction();
    assert_eq!(au.end_ts, env.now() + AUCTION_EXTENSION_SECS);
    assert_eq!(au.bid_count, 3);
    assert_eq!(au.highest_bidder, a);

    // paused => no bids and no settle; unpausing extends the end by the paused time (see security::m1_*)
    let admin = env.admin.insecure_clone();
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), true)], &[&admin]));
    assert_err(env.send(&[env.ix_bid(&b, Some(a), 300_000_000)], &[&bob]), PixelError::Paused);
    env.warp(AUCTION_EXTENSION_SECS);
    assert_err(env.send(&[env.ix_settle(&b)], &[&bob]), PixelError::Paused);
    ok(env.send(&[env.ix_set_paused(&admin.pubkey(), false)], &[&admin]));
    assert!(env.auction().end_ts > env.now());
    let end = env.auction().end_ts;
    env.warp(end - env.now());
    assert_err(env.send(&[env.ix_bid(&b, Some(a), 300_000_000)], &[&bob]), PixelError::AuctionEnded);
    // restart only allowed with no bids
    assert_err(env.send(&[env.ix_restart_auction()], &[&bob]), PixelError::InvalidParam);

    let vault0 = env.lamports(&vault_pda());
    let canvas0 = env.canvas();
    let ad_id = canvas0.next_ad_id;
    let m = ok(env.send(&[env.ix_settle(&b)], &[&bob])); // anyone can settle
    assert_eq!(env.lamports(&vault_pda()) - vault0, 200_000_000, "100% of the winning bid to buyback");
    assert_eq!(env.lamports(&auction_pda()), rent);
    let c = env.canvas();
    assert_eq!(c.sold_blocks, TOTAL_BLOCKS);
    assert!(c.bitmap.iter().all(|b| *b == 0xff));
    assert_eq!(c.lamports_to_buyback - canvas0.lamports_to_buyback, 200_000_000);
    assert_eq!(c.lamports_raised - canvas0.lamports_raised, 200_000_000);
    let ad: Ad = env.load(&auction_ad_pda());
    assert_eq!(ad.id, ad_id);
    assert_eq!(ad.owner, a);
    assert_eq!(ad.kind, AdKind::AuctionLot);
    assert_eq!(ad.pay_mode, PayMode::Auction);
    assert_eq!(ad.paid_lamports, 200_000_000);
    let au = env.auction();
    assert_eq!(au.status, AuctionStatus::Settled);
    assert_eq!(au.ad_id, ad_id);
    let ev = &events::<AuctionSettled>(&m)[0];
    assert_eq!((ev.winner, ev.lamports, ev.ad_id), (a, 200_000_000, ad_id));
    assert_eq!(events::<AdPurchased>(&m)[0].pay_mode, PayMode::Auction);

    // no double settle, no more bids
    // second settle: the ["ad_auction"] account already exists, so `init` rejects it (code 0) before the handler
    assert_eq!(custom_code(&env.send(&[env.ix_settle(&b)], &[&bob])), Some(0));
    assert_eq!(env.lamports(&vault_pda()) - vault0, 200_000_000, "no double payout");
    assert_err(env.send(&[env.ix_bid(&b, Some(a), 1_000_000_000)], &[&bob]), PixelError::AuctionNotActive);
    // winner sets content
    ok(env.send(&[env.ix_update_ad(&a, auction_ad_pda(), "https://winner.io")], &[&alice]));
    assert_eq!(env.load::<Ad>(&auction_ad_pda()).link, "https://winner.io");
}

#[test]
fn auction_without_bids_restarts() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let whale = fill_to_threshold(&mut env);
    let w = whale.pubkey();
    ok(env.send(&[env.ix_start_auction(&w)], &[&whale]));
    assert_err(env.send(&[env.ix_restart_auction()], &[&whale]), PixelError::AuctionNotEnded);
    env.warp(AUCTION_DURATION_SECS);
    assert_err(env.send(&[env.ix_settle(&w)], &[&whale]), PixelError::BidTooLow);
    ok(env.send(&[env.ix_restart_auction()], &[&whale]));
    assert_eq!(env.auction().end_ts, env.now() + AUCTION_DURATION_SECS);
    ok(env.send(&[env.ix_bid(&w, None, 100_000_000)], &[&whale]));
    env.warp(AUCTION_DURATION_SECS);
    ok(env.send(&[env.ix_settle(&w)], &[&whale]));
    assert_eq!(env.canvas().sold_blocks, TOTAL_BLOCKS);
}

#[test]
fn nothing_to_auction_when_sold_out() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (whale, _) = env.new_user(20_000_000_000_000, 0);
    let w = whale.pubkey();
    // one purchase of the entire canvas (sold 0 < 9_900 before the buy)
    let m = ok(env.send(&[env.ix_buy_sol(&w, 0, 0, 100, 100, u64::MAX)], &[&whale]));
    println!("CU for a 100x100 buy: {}", m.compute_units_consumed);
    assert_eq!(env.canvas().sold_blocks, TOTAL_BLOCKS);
    assert_err(env.send(&[env.ix_start_auction(&w)], &[&whale]), PixelError::NothingToAuction);
}
