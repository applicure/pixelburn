use anchor_lang::prelude::*;

use crate::constants::*;

/// Where the token spot price is read from.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PriceSource {
    /// pump.fun bonding curve account (virtual reserves).
    BondingCurve { curve: Pubkey },
    /// PumpSwap pool: pool account (for `virtual_quote_reserves` and vault binding) + base/quote vaults.
    Pool {
        pool: Pubkey,
        base_vault: Pubkey,
        quote_vault: Pubkey,
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PayMode {
    Sol,
    Token,
    Auction,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AdKind {
    /// Axis-aligned rectangle x,y,w,h.
    Rect,
    /// Final-auction lot: the block set is `Auction.lot_bitmap`; x,y,w,h are 0.
    AuctionLot,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AuctionStatus {
    Active,
    Settled,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Config {
    pub admin: Pubkey,
    /// Two-step admin transfer; `Pubkey::default()` when none pending.
    pub pending_admin: Pubkey,
    pub treasury: Pubkey,
    pub keeper: Pubkey,
    pub token_mint: Pubkey,
    pub token_program: Pubkey,
    pub token_decimals: u8,
    pub pyth_feed_id: [u8; 32],
    pub price_source: PriceSource,
    /// lamports per token base unit * 1e18.
    pub token_ema_price_sol: u128,
    /// EMA value before the most recent crank. Used by buys in the same slot as a crank.
    pub token_ema_prev_price_sol: u128,
    /// Slow EMA (4 h window), same unit; and its pre-slot value.
    pub token_slow_ema_price_sol: u128,
    pub token_slow_ema_prev_price_sol: u128,
    /// Last spot read by the crank (informational).
    pub token_spot_price_sol: u128,
    pub ema_updated_at: i64,
    pub ema_updated_slot: u64,
    pub max_price_age_secs: u64,
    pub paused: bool,
    pub buyback_cap_lamports_per_hour: u64,
    pub buyback_max_slippage_bps: u16,
    /// Token bucket for buyback releases: refills at cap/hour, holds at most `cap`.
    pub buyback_allowance_updated_at: i64,
    pub buyback_allowance: u64,
    /// Lamports released to the keeper that have not yet been reconciled by `record_buyback_burn`.
    pub buyback_outstanding_lamports: u64,
    /// Outstanding releases written off when the admin rotated a keeper that never reconciled (audit trail).
    pub buyback_written_off_lamports: u64,
    pub bump: u8,
    pub canvas_bump: u8,
    pub buyback_vault_bump: u8,
    /// Cranks since the EMA was (re)seeded by the admin, and the time of the first of them.
    pub ema_warmup_cranks: u16,
    pub ema_warmup_started_at: i64,
    /// Set when pausing; used to extend a running auction by the paused duration on unpause.
    pub paused_at: i64,
    /// Token bucket limiting blocks bought with tokens: refills at cap/hour, holds at most cap.
    pub token_blocks_cap_per_hour: u16,
    pub token_blocks_allowance: u32,
    pub token_blocks_allowance_updated_at: i64,
    pub _reserved: [u8; 32],
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Canvas {
    pub bitmap: [u8; BITMAP_BYTES],
    pub sold_blocks: u16,
    pub next_ad_id: u32,
    pub usd_micro_raised: u64,
    pub lamports_raised: u64,
    pub lamports_to_treasury: u64,
    pub lamports_to_buyback: u64,
    pub tokens_burned_direct: u64,
    pub tokens_burned_buyback: u64,
    pub lamports_spent_buyback: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Ad {
    pub id: u32,
    pub owner: Pubkey,
    pub kind: AdKind,
    pub x: u8,
    pub y: u8,
    pub w: u8,
    pub h: u8,
    #[max_len(MAX_TITLE_LEN)]
    pub title: String,
    #[max_len(MAX_LINK_LEN)]
    pub link: String,
    #[max_len(MAX_IMAGE_URI_LEN)]
    pub image_uri: String,
    pub image_sha256: [u8; 32],
    pub pay_mode: PayMode,
    pub paid_lamports: u64,
    pub paid_tokens: u64,
    pub usd_micro: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Auction {
    pub status: AuctionStatus,
    pub start_ts: i64,
    pub end_ts: i64,
    pub highest_bidder: Pubkey,
    pub highest_bid: u64,
    pub bid_count: u32,
    pub lot_blocks: u16,
    /// Blocks in the lot (free blocks when the auction started).
    pub lot_bitmap: [u8; BITMAP_BYTES],
    /// Ad id created at settlement (valid when status == Settled).
    pub ad_id: u32,
    pub bump: u8,
}
