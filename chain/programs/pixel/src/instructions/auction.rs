use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{constants::*, error::PixelError, events::*, math, state::*};

// ------------------------------------------------------------------ start

#[derive(Accounts)]
pub struct StartFinalAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [CANVAS_SEED], bump = canvas.bump)]
    pub canvas: Box<Account<'info, Canvas>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Auction::INIT_SPACE,
        seeds = [AUCTION_SEED],
        bump
    )]
    pub auction: Box<Account<'info, Auction>>,
    pub system_program: Program<'info, System>,
}

/// Permissionless once sold_blocks >= 9_900. The lot is every block still free at this moment
/// (fixed-price sales are already closed, so this set cannot change afterwards).
pub fn handle_start_final_auction(ctx: Context<StartFinalAuction>) -> Result<()> {
    require!(!ctx.accounts.config.paused, PixelError::Paused);
    let canvas = &ctx.accounts.canvas;
    require!(
        canvas.sold_blocks >= AUCTION_THRESHOLD_BLOCKS,
        PixelError::AuctionThresholdNotReached
    );
    require!(canvas.sold_blocks < TOTAL_BLOCKS, PixelError::NothingToAuction);
    let lot_blocks = TOTAL_BLOCKS
        .checked_sub(canvas.sold_blocks)
        .ok_or(PixelError::MathOverflow)?;

    let now = Clock::get()?.unix_timestamp;
    let auction = &mut ctx.accounts.auction;
    for (dst, src) in auction.lot_bitmap.iter_mut().zip(canvas.bitmap.iter()) {
        *dst = !*src;
    }
    // Invariant: bitmap popcount == sold_blocks, so the complement has exactly lot_blocks bits.
    require!(
        math::count_set(&auction.lot_bitmap) == lot_blocks,
        PixelError::MathOverflow
    );
    auction.status = AuctionStatus::Active;
    auction.start_ts = now;
    auction.end_ts = now
        .checked_add(AUCTION_DURATION_SECS)
        .ok_or(PixelError::MathOverflow)?;
    auction.highest_bidder = Pubkey::default();
    auction.highest_bid = 0;
    auction.bid_count = 0;
    auction.lot_blocks = lot_blocks;
    auction.ad_id = 0;
    auction.bump = ctx.bumps.auction;

    emit!(AuctionStarted {
        lot_blocks,
        start_ts: now,
        end_ts: auction.end_ts,
    });
    Ok(())
}

// ------------------------------------------------------------------ bid

#[derive(Accounts)]
pub struct BidFinalAuction<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [AUCTION_SEED], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: must equal auction.highest_bidder (checked in handler); only receives the refund.
    #[account(mut)]
    pub previous_bidder: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_bid_final_auction(ctx: Context<BidFinalAuction>, lamports: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, PixelError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let bidder_key = ctx.accounts.bidder.key();
    {
        let auction = &ctx.accounts.auction;
        require!(
            auction.status == AuctionStatus::Active,
            PixelError::AuctionNotActive
        );
        require!(now < auction.end_ts, PixelError::AuctionEnded);
        require!(
            lamports >= math::min_next_bid(auction.highest_bid)?,
            PixelError::BidTooLow
        );
        if auction.highest_bid > 0 {
            require_keys_neq!(
                bidder_key,
                auction.highest_bidder,
                PixelError::AlreadyHighestBidder
            );
        }
    }

    // Escrow the new bid in the auction PDA.
    system_program::transfer(
        CpiContext::new(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.bidder.to_account_info(),
                to: ctx.accounts.auction.to_account_info(),
            },
        ),
        lamports,
    )?;

    // Refund the previous highest bidder in the same instruction.
    let prev_bid = ctx.accounts.auction.highest_bid;
    if prev_bid > 0 {
        let prev = ctx
            .accounts
            .previous_bidder
            .as_ref()
            .ok_or(PixelError::InvalidPreviousBidder)?;
        require_keys_eq!(
            prev.key(),
            ctx.accounts.auction.highest_bidder,
            PixelError::InvalidPreviousBidder
        );
        ctx.accounts.auction.sub_lamports(prev_bid)?;
        prev.add_lamports(prev_bid)?;
    }

    let auction = &mut ctx.accounts.auction;
    auction.highest_bid = lamports;
    auction.highest_bidder = bidder_key;
    auction.bid_count = auction
        .bid_count
        .checked_add(1)
        .ok_or(PixelError::MathOverflow)?;
    let remaining = auction
        .end_ts
        .checked_sub(now)
        .ok_or(PixelError::MathOverflow)?;
    if remaining < AUCTION_EXTENSION_SECS {
        auction.end_ts = now
            .checked_add(AUCTION_EXTENSION_SECS)
            .ok_or(PixelError::MathOverflow)?;
    }

    emit!(AuctionBid {
        bidder: bidder_key,
        lamports,
        end_ts: auction.end_ts,
        ts: now,
    });
    Ok(())
}

// ------------------------------------------------------------------ restart (no bids)

#[derive(Accounts)]
pub struct RestartFinalAuction<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [AUCTION_SEED], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
}

/// Permissionless: an auction that ended without any bid runs again for another 72h.
pub fn handle_restart_final_auction(ctx: Context<RestartFinalAuction>) -> Result<()> {
    require!(!ctx.accounts.config.paused, PixelError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let auction = &mut ctx.accounts.auction;
    require!(
        auction.status == AuctionStatus::Active,
        PixelError::AuctionNotActive
    );
    require!(now >= auction.end_ts, PixelError::AuctionNotEnded);
    require!(auction.highest_bid == 0, PixelError::InvalidParam);
    auction.start_ts = now;
    auction.end_ts = now
        .checked_add(AUCTION_DURATION_SECS)
        .ok_or(PixelError::MathOverflow)?;
    emit!(AuctionRestarted {
        end_ts: auction.end_ts
    });
    Ok(())
}

// ------------------------------------------------------------------ settle

#[derive(Accounts)]
pub struct SettleFinalAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CANVAS_SEED], bump = canvas.bump)]
    pub canvas: Box<Account<'info, Canvas>>,
    #[account(mut, seeds = [AUCTION_SEED], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Ad::INIT_SPACE,
        seeds = [AD_AUCTION_SEED],
        bump
    )]
    pub ad: Box<Account<'info, Ad>>,
    #[account(mut, seeds = [BUYBACK_VAULT_SEED], bump = config.buyback_vault_bump)]
    pub buyback_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Permissionless after end_ts. 100% of the winning bid goes to the buyback vault; the winner gets one
/// Ad (kind = AuctionLot) covering every block in `auction.lot_bitmap`. The winner sets content via update_ad.
pub fn handle_settle_final_auction(ctx: Context<SettleFinalAuction>) -> Result<()> {
    // A pause stops the clock for bidders (end_ts is extended on unpause), so settlement must wait too.
    require!(!ctx.accounts.config.paused, PixelError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let (bid, winner, lot_blocks) = {
        let a = &ctx.accounts.auction;
        require!(a.status == AuctionStatus::Active, PixelError::AuctionNotActive);
        require!(now >= a.end_ts, PixelError::AuctionNotEnded);
        require!(a.highest_bid > 0, PixelError::BidTooLow);
        (a.highest_bid, a.highest_bidder, a.lot_blocks)
    };

    ctx.accounts.auction.sub_lamports(bid)?;
    ctx.accounts.buyback_vault.add_lamports(bid)?;

    let canvas = &mut ctx.accounts.canvas;
    {
        let lot = &ctx.accounts.auction.lot_bitmap;
        for (c, l) in canvas.bitmap.iter_mut().zip(lot.iter()) {
            require!(*c & *l == 0, PixelError::Overlap);
            *c |= *l;
        }
    }
    canvas.sold_blocks = canvas
        .sold_blocks
        .checked_add(lot_blocks)
        .ok_or(PixelError::MathOverflow)?;
    require!(canvas.sold_blocks == TOTAL_BLOCKS, PixelError::MathOverflow);
    canvas.lamports_raised = canvas
        .lamports_raised
        .checked_add(bid)
        .ok_or(PixelError::MathOverflow)?;
    canvas.lamports_to_buyback = canvas
        .lamports_to_buyback
        .checked_add(bid)
        .ok_or(PixelError::MathOverflow)?;
    let ad_id = canvas.next_ad_id;
    canvas.next_ad_id = ad_id.checked_add(1).ok_or(PixelError::MathOverflow)?;

    let ad = &mut ctx.accounts.ad;
    ad.id = ad_id;
    ad.owner = winner;
    ad.kind = AdKind::AuctionLot;
    ad.x = 0;
    ad.y = 0;
    ad.w = 0;
    ad.h = 0;
    ad.title = String::new();
    ad.link = String::new();
    ad.image_uri = String::new();
    ad.image_sha256 = [0u8; 32];
    ad.pay_mode = PayMode::Auction;
    ad.paid_lamports = bid;
    ad.paid_tokens = 0;
    ad.usd_micro = 0;
    ad.created_at = now;
    ad.updated_at = now;
    ad.bump = ctx.bumps.ad;

    let auction = &mut ctx.accounts.auction;
    auction.status = AuctionStatus::Settled;
    auction.ad_id = ad_id;

    let ad_key = ctx.accounts.ad.key();
    emit!(AdPurchased {
        ad_id,
        ad: ad_key,
        owner: winner,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        pay_mode: PayMode::Auction,
        lamports: bid,
        tokens_burned: 0,
        usd_micro: 0,
        ts: now,
    });
    emit!(AuctionSettled {
        winner,
        lamports: bid,
        ad_id,
        ad: ad_key,
    });
    Ok(())
}
