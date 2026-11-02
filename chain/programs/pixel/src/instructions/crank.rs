use anchor_lang::prelude::*;

use crate::{constants::*, error::PixelError, events::*, math, oracle, state::*};

#[derive(Accounts)]
pub struct CrankTokenPrice<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: validated in oracle::read_spot_price.
    pub price_source: UncheckedAccount<'info>,
    /// CHECK: validated in oracle::read_spot_price.
    pub pool_base_vault: Option<UncheckedAccount<'info>>,
    /// CHECK: validated in oracle::read_spot_price.
    pub pool_quote_vault: Option<UncheckedAccount<'info>>,
}

pub fn handle_crank_token_price(ctx: Context<CrankTokenPrice>) -> Result<()> {
    let clock = Clock::get()?;
    let spot = oracle::read_spot_price(
        &ctx.accounts.config,
        &ctx.accounts.price_source.to_account_info(),
        ctx.accounts.pool_base_vault.as_ref().map(|a| a.as_ref()),
        ctx.accounts.pool_quote_vault.as_ref().map(|a| a.as_ref()),
    )?;
    let config = &mut ctx.accounts.config;
    // No single-read seeding: the admin seeds the EMA (initialize / set_price_source).
    require!(config.token_ema_price_sol > 0, PixelError::EmaUnavailable);
    let dt = clock
        .unix_timestamp
        .checked_sub(config.ema_updated_at)
        .ok_or(PixelError::MathOverflow)?;
    require!(dt >= EMA_MIN_INTERVAL_SECS, PixelError::CrankTooSoon);
    // Never two updates in one slot (prev must stay the pre-slot value).
    require!(config.ema_updated_slot != clock.slot, PixelError::CrankTooSoon);
    if config.ema_warmup_cranks == 0 {
        // First crank after (re)seeding: the admin's seed must be close to the market.
        require!(
            math::within_band(spot, config.token_ema_price_sol, EMA_SEED_BAND_BPS)?,
            PixelError::EmaSeedMismatch
        );
        config.ema_warmup_started_at = clock.unix_timestamp;
    }
    config.ema_warmup_cranks = config.ema_warmup_cranks.saturating_add(1);
    let new_ema = math::ema_update(config.token_ema_price_sol, spot)?;
    let new_slow = math::slow_ema_update(config.token_slow_ema_price_sol, spot)?;
    config.token_ema_prev_price_sol = config.token_ema_price_sol;
    config.token_ema_price_sol = new_ema;
    config.token_slow_ema_prev_price_sol = config.token_slow_ema_price_sol;
    config.token_slow_ema_price_sol = new_slow;
    config.token_spot_price_sol = spot;
    config.ema_updated_at = clock.unix_timestamp;
    config.ema_updated_slot = clock.slot;

    emit!(TokenPriceUpdated {
        spot,
        ema: new_ema,
        slow_ema: new_slow,
        ts: clock.unix_timestamp,
    });
    Ok(())
}
