use crate::common::*;
use pixel::{error::PixelError, events::*};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn update_and_transfer_owner_only() {
    let mut env = Env::ready(SPL_TOKEN, Source::Curve);
    let (alice, _) = env.new_user(100_000_000_000, 0);
    let (bob, _) = env.new_user(1_000_000_000, 0);
    ok(env.send(&[env.ix_buy_sol(&alice.pubkey(), 0, 0, 1, 1, u64::MAX)], &[&alice]));

    assert_err(env.send(&[env.ix_update_ad(&bob.pubkey(), ad_pda(0, 0), "https://evil.io")], &[&bob]), PixelError::Unauthorized);
    assert_err(env.send(&[env.ix_transfer_ad(&bob.pubkey(), ad_pda(0, 0), bob.pubkey())], &[&bob]), PixelError::Unauthorized);
    assert_err(env.send(&[env.ix_update_ad(&alice.pubkey(), ad_pda(0, 0), "javascript:x")], &[&alice]), PixelError::InvalidLink);

    let m = ok(env.send(&[env.ix_update_ad(&alice.pubkey(), ad_pda(0, 0), "https://new.io")], &[&alice]));
    assert_eq!(events::<AdUpdated>(&m)[0].ad_id, 0);
    let ad = env.ad_at(0, 0);
    assert_eq!(ad.link, "https://new.io");
    assert_eq!(ad.title, "Updated");
    assert_eq!(ad.image_sha256, [1u8; 32]);
    // rect is immutable
    assert_eq!((ad.x, ad.y, ad.w, ad.h), (0, 0, 1, 1));

    assert_err(env.send(&[env.ix_transfer_ad(&alice.pubkey(), ad_pda(0, 0), anchor_lang::prelude::Pubkey::default())], &[&alice]), PixelError::InvalidParam);
    let m = ok(env.send(&[env.ix_transfer_ad(&alice.pubkey(), ad_pda(0, 0), bob.pubkey())], &[&alice]));
    let ev = &events::<AdTransferred>(&m)[0];
    assert_eq!((ev.from, ev.to), (alice.pubkey(), bob.pubkey()));
    assert_eq!(env.ad_at(0, 0).owner, bob.pubkey());
    assert_err(env.send(&[env.ix_update_ad(&alice.pubkey(), ad_pda(0, 0), "https://x.io")], &[&alice]), PixelError::Unauthorized);
    ok(env.send(&[env.ix_update_ad(&bob.pubkey(), ad_pda(0, 0), "https://bob.io")], &[&bob]));

    // unsigned owner cannot be spoofed: a tx signed by someone else listing alice as owner fails sig verification
    let eve = Keypair::new();
    env.svm.airdrop(&eve.pubkey(), 1_000_000_000).unwrap();
    let ix = env.ix_update_ad(&bob.pubkey(), ad_pda(0, 0), "https://eve.io");
    let msg = solana_message::Message::new_with_blockhash(&[ix], Some(&eve.pubkey()), &env.svm.latest_blockhash());
    let tx = solana_transaction::versioned::VersionedTransaction::try_new(solana_message::VersionedMessage::Legacy(msg), &[&eve]);
    assert!(tx.is_err(), "cannot build a tx missing bob's signature");
}
