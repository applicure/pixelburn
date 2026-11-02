//! Keeper-based buyback (SPEC fallback). See NOTES.md "Buyback design".
//!
//! 1. `release_buyback(lamports)`: keeper-only, rate-limited (cap per rolling hour window), and only when the
//!    previous release has been reconciled. Lamports move vault -> keeper wallet.
//! 2. Keeper buys the token on pump.fun / PumpSwap off-chain-orchestrated.
//! 3. `record_buyback_burn(lamports_spent, tokens)`: the program itself burns `tokens` from the keeper's token
//!    account (so the burn is verified on-chain: supply drops in this ix), requires
//!    tokens >= lamports_spent / EMA * (1 - max_slippage) (pre-slot EMA, not spot, so the keeper cannot
//!    lower the bar by pumping spot in the same tx), and pulls unspent lamports back into the vault.
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::{constants::*, error::PixelError, events::*, math, oracle, state::*};


#[derive(Accounts)]
pub struct ReleaseBuyback<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ PixelError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BUYBACK_VAULT_SEED], bump = config.buyback_vault_bump)]
    pub buyback_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Token bucket: refills linearly at cap per hour, capped at `cap`. Burst <= cap; sustained <= cap/hour;
/// any 1-hour window <= 2 * cap (full bucket + one hour of refill).
pub fn refill_allowance(config: &mut Config, now: i64) -> Result<()> {
    let elapsed = now
        .checked_sub(config.buyback_allowance_updated_at)
        .ok_or(PixelError::MathOverflow)?
        .max(0) as u128;
    let cap = config.buyback_cap_lamports_per_hour as u128;
    let refill = cap
        .checked_mul(elapsed)
        .ok_or(PixelError::MathOverflow)?
        / BUYBACK_WINDOW_SECS as u128;
    let new = (config.buyback_allowance as u128)
        .checked_add(refill)
        .ok_or(PixelError::MathOverflow)?
        .min(cap);
    config.buyback_allowance = new as u64;
    config.buyback_allowance_updated_at = now;
    Ok(())
}

pub fn handle_release_buyback(ctx: Context<ReleaseBuyback>, lamports: u64) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;
    require!(!config.paused, PixelError::Paused);
    require!(lamports > 0, PixelError::InvalidParam);
    require!(
        config.buyback_outstanding_lamports == 0,
        PixelError::BuybackOutstanding
    );

    refill_allowance(config, clock.unix_timestamp)?;
    require!(
        lamports <= config.buyback_allowance,
        PixelError::BuybackCapExceeded
    );

    let rent_min = Rent::get()?.minimum_balance(0);
    let available = ctx
        .accounts
        .buyback_vault
        .lamports()
        .saturating_sub(rent_min);
    require!(lamports <= available, PixelError::InsufficientVaultFunds);

    let bump = [config.buyback_vault_bump];
    let seeds: &[&[u8]] = &[BUYBACK_VAULT_SEED, &bump];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.buyback_vault.to_account_info(),
                to: ctx.accounts.keeper.to_account_info(),
            },
            &[seeds],
        ),
        lamports,
    )?;

    config.buyback_allowance -= lamports;
    config.buyback_outstanding_lamports = lamports;
    emit!(BuybackReleased {
        keeper: ctx.accounts.keeper.key(),
        lamports,
        ts: clock.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RecordBuybackBurn<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = keeper @ PixelError::Unauthorized,
        has_one = token_mint @ PixelError::InvalidParam,
        has_one = token_program @ PixelError::InvalidParam,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CANVAS_SEED], bump = canvas.bump)]
    pub canvas: Box<Account<'info, Canvas>>,
    #[account(mut, seeds = [BUYBACK_VAULT_SEED], bump = config.buyback_vault_bump)]
    pub buyback_vault: SystemAccount<'info>,
    #[account(mut, mint::token_program = token_program)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = keeper,
        token::token_program = token_program,
    )]
    pub keeper_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_record_buyback_burn(
    ctx: Context<RecordBuybackBurn>,
    lamports_spent: u64,
    tokens_burned: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let outstanding = ctx.accounts.config.buyback_outstanding_lamports;
    require!(outstanding > 0, PixelError::InvalidParam);
    require!(
        lamports_spent <= outstanding,
        PixelError::BuybackAmountTooHigh
    );

    // A pure refund (nothing spent) needs no price; anything spent is checked against a fresh pre-slot EMA.
    let min_tokens = if lamports_spent == 0 {
        0
    } else {
        oracle::ema_warm(&ctx.accounts.config, &clock)?;
        let ema = oracle::usable_ema(&ctx.accounts.config, &clock)?;
        math::min_buyback_tokens(
            lamports_spent,
            ema,
            ctx.accounts.config.buyback_max_slippage_bps,
        )?
    };
    require!(tokens_burned >= min_tokens, PixelError::BuybackRateTooLow);

    // Return unspent SOL to the vault.
    let unspent = outstanding - lamports_spent;
    if unspent > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.keeper.to_account_info(),
                    to: ctx.accounts.buyback_vault.to_account_info(),
                },
            ),
            unspent,
        )?;
    }

    if tokens_burned > 0 {
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.keeper_token_account.to_account_info(),
                    authority: ctx.accounts.keeper.to_account_info(),
                },
            ),
            tokens_burned,
        )?;
    }

    ctx.accounts.config.buyback_outstanding_lamports = 0;
    let canvas = &mut ctx.accounts.canvas;
    canvas.lamports_spent_buyback = canvas
        .lamports_spent_buyback
        .checked_add(lamports_spent)
        .ok_or(PixelError::MathOverflow)?;
    canvas.tokens_burned_buyback = canvas
        .tokens_burned_buyback
        .checked_add(tokens_burned)
        .ok_or(PixelError::MathOverflow)?;

    emit!(BuybackBurned {
        lamports_in: lamports_spent,
        tokens_burned,
        ts: clock.unix_timestamp,
    });
    Ok(())
}
