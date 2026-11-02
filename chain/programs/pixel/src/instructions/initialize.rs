use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::{constants::*, error::PixelError, oracle, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeParams {
    pub treasury: Pubkey,
    pub keeper: Pubkey,
    pub pyth_feed_id: [u8; 32],
    pub price_source: PriceSource,
    pub max_price_age_secs: u64,
    pub buyback_cap_lamports_per_hour: u64,
    pub buyback_max_slippage_bps: u16,
    /// Admin-supplied EMA seed (lamports per base unit * 1e18). 0 = token pricing disabled until set_price_source.
    pub initial_token_ema_price_sol: u128,
    /// Token-paid blocks per hour (1..=5000; default 1000).
    pub token_blocks_cap_per_hour: u16,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = admin,
        space = 8 + Canvas::INIT_SPACE,
        seeds = [CANVAS_SEED],
        bump
    )]
    pub canvas: Box<Account<'info, Canvas>>,
    #[account(mut, seeds = [BUYBACK_VAULT_SEED], bump)]
    pub buyback_vault: SystemAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// Only the program's upgrade authority may initialise (prevents init front-running).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ PixelError::Unauthorized)]
    pub program: Program<'info, crate::program::Pixel>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ PixelError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn validate_params(
    max_price_age_secs: u64,
    buyback_cap_lamports_per_hour: u64,
    buyback_max_slippage_bps: u16,
    token_blocks_cap_per_hour: u16,
) -> Result<()> {
    require!(
        token_blocks_cap_per_hour <= MAX_TOKEN_BLOCKS_CAP_PER_HOUR,
        PixelError::InvalidParam
    );
    require!(
        buyback_cap_lamports_per_hour <= MAX_BUYBACK_CAP_LAMPORTS_PER_HOUR,
        PixelError::InvalidParam
    );
    require!(
        max_price_age_secs > 0 && max_price_age_secs <= MAX_PRICE_AGE_LIMIT_SECS,
        PixelError::InvalidParam
    );
    require!(
        buyback_max_slippage_bps <= MAX_BUYBACK_SLIPPAGE_BPS_LIMIT,
        PixelError::InvalidParam
    );
    Ok(())
}

pub fn handle_initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    validate_params(
        params.max_price_age_secs,
        params.buyback_cap_lamports_per_hour,
        params.buyback_max_slippage_bps,
        params.token_blocks_cap_per_hour,
    )?;
    require_keys_neq!(params.treasury, Pubkey::default(), PixelError::InvalidParam);
    require_keys_neq!(params.keeper, Pubkey::default(), PixelError::InvalidParam);
    oracle::validate_price_source(
        &params.price_source,
        &ctx.accounts.token_mint.key(),
        &ctx.accounts.token_program.key(),
    )?;
    let clock = Clock::get()?;

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = Pubkey::default();
    config.treasury = params.treasury;
    config.keeper = params.keeper;
    config.token_mint = ctx.accounts.token_mint.key();
    config.token_program = ctx.accounts.token_program.key();
    config.token_decimals = ctx.accounts.token_mint.decimals;
    config.pyth_feed_id = params.pyth_feed_id;
    config.price_source = params.price_source;
    oracle::seed_ema(config, params.initial_token_ema_price_sol, &clock);
    config.max_price_age_secs = params.max_price_age_secs;
    config.paused = false;
    config.buyback_cap_lamports_per_hour = params.buyback_cap_lamports_per_hour;
    config.buyback_max_slippage_bps = params.buyback_max_slippage_bps;
    config.buyback_allowance_updated_at = clock.unix_timestamp;
    config.buyback_allowance = params.buyback_cap_lamports_per_hour;
    config.buyback_outstanding_lamports = 0;
    config.bump = ctx.bumps.config;
    config.canvas_bump = ctx.bumps.canvas;
    config.buyback_vault_bump = ctx.bumps.buyback_vault;
    config.buyback_written_off_lamports = 0;
    config.paused_at = 0;
    config.token_blocks_cap_per_hour = params.token_blocks_cap_per_hour;
    config.token_blocks_allowance = params.token_blocks_cap_per_hour as u32;
    config.token_blocks_allowance_updated_at = clock.unix_timestamp;
    config._reserved = [0u8; 32];

    let canvas = &mut ctx.accounts.canvas;
    canvas.bitmap = [0u8; BITMAP_BYTES];
    canvas.sold_blocks = 0;
    canvas.next_ad_id = 0;
    canvas.bump = ctx.bumps.canvas;

    // Make the SOL vault rent-exempt so small first deposits/withdrawals never trip rent checks.
    let rent_min = Rent::get()?.minimum_balance(0);
    let have = ctx.accounts.buyback_vault.lamports();
    if have < rent_min {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.buyback_vault.to_account_info(),
                },
            ),
            rent_min - have,
        )?;
    }
    Ok(())
}
