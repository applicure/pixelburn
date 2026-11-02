use anchor_lang::prelude::*;

use crate::{constants::*, error::PixelError, instructions::initialize::validate_params, oracle, state::*};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PixelError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ PixelError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the auction PDA (may not exist yet). If it holds an active Auction, unpausing extends its end by the
    /// paused duration so a pause can never decide the auction.
    #[account(mut, seeds = [AUCTION_SEED], bump)]
    pub auction: UncheckedAccount<'info>,
}

pub fn handle_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    if paused && !config.paused {
        config.paused_at = now;
    } else if !paused && config.paused {
        let ai = ctx.accounts.auction.to_account_info();
        if ai.owner == &crate::ID && !ai.data_is_empty() {
            let mut data = ai.try_borrow_mut_data()?;
            let mut auction = Auction::try_deserialize(&mut &data[..])?;
            // Only an auction that was still live when the pause began gets its clock back. An auction that had
            // already ended (end_ts <= paused_at) stays ended, so a pause can never reopen a won auction.
            if auction.status == AuctionStatus::Active && auction.end_ts > config.paused_at {
                let paused_for = now
                    .checked_sub(config.paused_at)
                    .ok_or(PixelError::MathOverflow)?
                    .max(0);
                let extended = auction
                    .end_ts
                    .checked_add(paused_for)
                    .ok_or(PixelError::MathOverflow)?;
                let floor = now
                    .checked_add(AUCTION_EXTENSION_SECS)
                    .ok_or(PixelError::MathOverflow)?;
                auction.end_ts = extended.max(floor);
                let mut out: &mut [u8] = &mut data[..];
                auction.try_serialize(&mut out)?;
                emit!(crate::events::AuctionResumed {
                    end_ts: auction.end_ts,
                    paused_secs: paused_for,
                });
            }
        }
        config.paused_at = 0;
    }
    config.paused = paused;
    Ok(())
}

pub fn handle_set_treasury(ctx: Context<AdminOnly>, treasury: Pubkey) -> Result<()> {
    require_keys_neq!(treasury, Pubkey::default(), PixelError::InvalidParam);
    ctx.accounts.config.treasury = treasury;
    Ok(())
}

pub fn handle_set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
    require_keys_neq!(keeper, Pubkey::default(), PixelError::InvalidParam);
    let c = &mut ctx.accounts.config;
    // A keeper that never reconciles must not be able to block rotation (liveness). Any unreconciled release is
    // written off (kept on-chain as an audit figure) and the new keeper starts clean.
    if c.buyback_outstanding_lamports > 0 {
        let lost = c.buyback_outstanding_lamports;
        c.buyback_written_off_lamports = c
            .buyback_written_off_lamports
            .checked_add(lost)
            .ok_or(PixelError::MathOverflow)?;
        c.buyback_outstanding_lamports = 0;
        emit!(crate::events::BuybackWrittenOff {
            keeper: c.keeper,
            lamports: lost,
            ts: Clock::get()?.unix_timestamp,
        });
    }
    c.keeper = keeper;
    Ok(())
}

/// Switch price source (e.g. curve -> canonical PumpSwap pool at migration). The admin supplies the EMA seed
/// (typically the current EMA); it is checked against spot at the next crank and warm-up restarts.
pub fn handle_set_price_source(
    ctx: Context<AdminOnly>,
    price_source: PriceSource,
    initial_ema_price_sol: u128,
) -> Result<()> {
    let clock = Clock::get()?;
    let c = &mut ctx.accounts.config;
    oracle::validate_price_source(&price_source, &c.token_mint, &c.token_program)?;
    c.price_source = price_source;
    oracle::seed_ema(c, initial_ema_price_sol, &clock);
    Ok(())
}

pub fn handle_set_params(
    ctx: Context<AdminOnly>,
    max_price_age_secs: u64,
    buyback_cap_lamports_per_hour: u64,
    buyback_max_slippage_bps: u16,
    token_blocks_cap_per_hour: u16,
) -> Result<()> {
    validate_params(
        max_price_age_secs,
        buyback_cap_lamports_per_hour,
        buyback_max_slippage_bps,
        token_blocks_cap_per_hour,
    )?;
    let now = Clock::get()?.unix_timestamp;
    let c = &mut ctx.accounts.config;
    // settle the bucket at the old rate, then cap it at the new size
    crate::instructions::buyback::refill_allowance(c, now)?;
    c.buyback_allowance = c.buyback_allowance.min(buyback_cap_lamports_per_hour);
    c.max_price_age_secs = max_price_age_secs;
    c.buyback_cap_lamports_per_hour = buyback_cap_lamports_per_hour;
    c.buyback_max_slippage_bps = buyback_max_slippage_bps;
    // token-blocks bucket: settle at the old rate, then cap at the new size
    let elapsed = now
        .checked_sub(c.token_blocks_allowance_updated_at)
        .ok_or(PixelError::MathOverflow)?;
    let refilled = crate::math::bucket_refill(
        c.token_blocks_allowance as u64,
        c.token_blocks_cap_per_hour as u64,
        elapsed,
    )?;
    c.token_blocks_allowance = refilled.min(token_blocks_cap_per_hour as u64) as u32;
    c.token_blocks_allowance_updated_at = now;
    c.token_blocks_cap_per_hour = token_blocks_cap_per_hour;
    Ok(())
}

pub fn handle_propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_admin == new_admin.key() @ PixelError::Unauthorized,
        constraint = config.pending_admin != Pubkey::default() @ PixelError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.new_admin.key();
    c.pending_admin = Pubkey::default();
    Ok(())
}
