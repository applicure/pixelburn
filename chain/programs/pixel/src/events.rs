use anchor_lang::prelude::*;

use crate::state::PayMode;

#[event]
pub struct AdPurchased {
    pub ad_id: u32,
    /// Ad account address (rect: ["ad", y*100+x u16 LE]; auction lot: ["ad_auction"]).
    pub ad: Pubkey,
    pub owner: Pubkey,
    pub x: u8,
    pub y: u8,
    pub w: u8,
    pub h: u8,
    pub pay_mode: PayMode,
    pub lamports: u64,
    pub tokens_burned: u64,
    pub usd_micro: u64,
    pub ts: i64,
}

#[event]
pub struct AdUpdated {
    pub ad_id: u32,
    pub ad: Pubkey,
    pub ts: i64,
}

#[event]
pub struct AdTransferred {
    pub ad_id: u32,
    pub ad: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub ts: i64,
}

#[event]
pub struct TokenPriceUpdated {
    /// lamports per token base unit * 1e18
    pub spot: u128,
    /// lamports per token base unit * 1e18
    pub ema: u128,
    /// slow (4 h) EMA, same unit
    pub slow_ema: u128,
    pub ts: i64,
}

#[event]
pub struct BuybackReleased {
    pub keeper: Pubkey,
    pub lamports: u64,
    pub ts: i64,
}

#[event]
pub struct BuybackWrittenOff {
    pub keeper: Pubkey,
    pub lamports: u64,
    pub ts: i64,
}

#[event]
pub struct BuybackBurned {
    pub lamports_in: u64,
    pub tokens_burned: u64,
    pub ts: i64,
}

#[event]
pub struct AuctionStarted {
    pub lot_blocks: u16,
    pub start_ts: i64,
    pub end_ts: i64,
}

#[event]
pub struct AuctionBid {
    pub bidder: Pubkey,
    pub lamports: u64,
    pub end_ts: i64,
    pub ts: i64,
}

#[event]
pub struct AuctionSettled {
    pub winner: Pubkey,
    pub lamports: u64,
    pub ad_id: u32,
    pub ad: Pubkey,
}

#[event]
pub struct AuctionResumed {
    pub end_ts: i64,
    pub paused_secs: i64,
}

#[event]
pub struct AuctionRestarted {
    pub end_ts: i64,
}
