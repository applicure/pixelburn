use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{constants::*, error::PixelError, events::*, math, oracle, state::*};

/// Validates rect + content, checks sales are open and the rect is free, then marks it sold.
#[allow(clippy::too_many_arguments)]
fn claim_rect(
    canvas: &mut Canvas,
    x: u8,
    y: u8,
    w: u8,
    h: u8,
    title: &str,
    link: &str,
    image_uri: &str,
) -> Result<u16> {
    require!(
        canvas.sold_blocks < AUCTION_THRESHOLD_BLOCKS,
        PixelError::SalesClosed
    );
    math::validate_rect(x, y, w, h)?;
    math::validate_content(title, link, image_uri)?;
    require!(
        math::is_rect_free(&canvas.bitmap, x, y, w, h),
        PixelError::Overlap
    );
    math::mark_rect(&mut canvas.bitmap, x, y, w, h);
    let blocks = math::rect_blocks(w, h);
    canvas.sold_blocks = canvas
        .sold_blocks
        .checked_add(blocks)
        .ok_or(PixelError::MathOverflow)?;
    require!(canvas.sold_blocks <= TOTAL_BLOCKS, PixelError::MathOverflow);
    Ok(blocks)
}

#[allow(clippy::too_many_arguments)]
fn write_ad(
    ad: &mut Ad,
    id: u32,
    owner: Pubkey,
    bump: u8,
    x: u8,
    y: u8,
    w: u8,
    h: u8,
    title: String,
    link: String,
    image_uri: String,
    image_sha256: [u8; 32],
    pay_mode: PayMode,
    paid_lamports: u64,
    paid_tokens: u64,
    usd_micro: u64,
    now: i64,
) {
    ad.id = id;
    ad.owner = owner;
    ad.kind = AdKind::Rect;
    ad.x = x;
    ad.y = y;
    ad.w = w;
    ad.h = h;
    ad.title = title;
    ad.link = link;
    ad.image_uri = image_uri;
    ad.image_sha256 = image_sha256;
    ad.pay_mode = pay_mode;
    ad.paid_lamports = paid_lamports;
    ad.paid_tokens = paid_tokens;
    ad.usd_micro = usd_micro;
    ad.created_at = now;
    ad.updated_at = now;
    ad.bump = bump;
}

// ------------------------------------------------------------------ buy_with_sol

#[derive(Accounts)]
#[instruction(x: u8, y: u8)]
pub struct BuyWithSol<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury @ PixelError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CANVAS_SEED], bump = canvas.bump)]
    pub canvas: Box<Account<'info, Canvas>>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Ad::INIT_SPACE,
        seeds = [AD_SEED, &math::block_index_le(x, y)],
        bump
    )]
    pub ad: Box<Account<'info, Ad>>,
    /// CHECK: bound to config.treasury via has_one; only receives lamports.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [BUYBACK_VAULT_SEED], bump = config.buyback_vault_bump)]
    pub buyback_vault: SystemAccount<'info>,
    /// Pyth receiver-owned PriceUpdateV2 (owner + discriminator checked by Account<>).
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_buy_with_sol(
    ctx: Context<BuyWithSol>,
    x: u8,
    y: u8,
    w: u8,
    h: u8,
    title: String,
    link: String,
    image_uri: String,
    image_sha256: [u8; 32],
    max_lamports: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, PixelError::Paused);
    let clock = Clock::get()?;

    let canvas = &mut ctx.accounts.canvas;
    claim_rect(canvas, x, y, w, h, &title, &link, &image_uri)?;

    let usd_micro = math::quote_usd_micro(w, h)?;
    let (price, expo) = oracle::read_sol_usd(&ctx.accounts.price_update, config, &clock)?;
    let lamports = math::usd_to_lamports(usd_micro, price, expo)?;
    require!(lamports <= max_lamports, PixelError::SlippageExceeded);
    let (to_treasury, to_buyback) = math::split_sol(lamports)?;

    if to_treasury > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            to_treasury,
        )?;
    }
    if to_buyback > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.buyback_vault.to_account_info(),
                },
            ),
            to_buyback,
        )?;
    }

    let ad_id = canvas.next_ad_id;
    canvas.next_ad_id = ad_id.checked_add(1).ok_or(PixelError::MathOverflow)?;
    canvas.usd_micro_raised = canvas
        .usd_micro_raised
        .checked_add(usd_micro)
        .ok_or(PixelError::MathOverflow)?;
    canvas.lamports_raised = canvas
        .lamports_raised
        .checked_add(lamports)
        .ok_or(PixelError::MathOverflow)?;
    canvas.lamports_to_treasury = canvas
        .lamports_to_treasury
        .checked_add(to_treasury)
        .ok_or(PixelError::MathOverflow)?;
    canvas.lamports_to_buyback = canvas
        .lamports_to_buyback
        .checked_add(to_buyback)
        .ok_or(PixelError::MathOverflow)?;

    let owner = ctx.accounts.buyer.key();
    write_ad(
        &mut ctx.accounts.ad,
        ad_id,
        owner,
        ctx.bumps.ad,
        x,
        y,
        w,
        h,
        title,
        link,
        image_uri,
        image_sha256,
        PayMode::Sol,
        lamports,
        0,
        usd_micro,
        clock.unix_timestamp,
    );

    emit!(AdPurchased {
        ad_id,
        ad: ctx.accounts.ad.key(),
        owner,
        x,
        y,
        w,
        h,
        pay_mode: PayMode::Sol,
        lamports,
        tokens_burned: 0,
        usd_micro,
        ts: clock.unix_timestamp,
    });
    Ok(())
}

// ------------------------------------------------------------------ buy_with_token

#[derive(Accounts)]
#[instruction(x: u8, y: u8)]
pub struct BuyWithToken<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = token_mint @ PixelError::InvalidParam,
        has_one = token_program @ PixelError::InvalidParam,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CANVAS_SEED], bump = canvas.bump)]
    pub canvas: Box<Account<'info, Canvas>>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Ad::INIT_SPACE,
        seeds = [AD_SEED, &math::block_index_le(x, y)],
        bump
    )]
    pub ad: Box<Account<'info, Ad>>,
    #[account(mut, mint::token_program = token_program)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = buyer,
        token::token_program = token_program,
    )]
    pub buyer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    /// CHECK: pump.fun curve or PumpSwap pool; key, owner, discriminator and layout validated in oracle::read_spot_price.
    pub price_source: UncheckedAccount<'info>,
    /// CHECK: PumpSwap base vault (Pool source only); validated in oracle::read_spot_price.
    pub pool_base_vault: Option<UncheckedAccount<'info>>,
    /// CHECK: PumpSwap quote vault (Pool source only); validated in oracle::read_spot_price.
    pub pool_quote_vault: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_buy_with_token(
    ctx: Context<BuyWithToken>,
    x: u8,
    y: u8,
    w: u8,
    h: u8,
    title: String,
    link: String,
    image_uri: String,
    image_sha256: [u8; 32],
    max_tokens: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, PixelError::Paused);
    let clock = Clock::get()?;

    let canvas = &mut ctx.accounts.canvas;
    claim_rect(canvas, x, y, w, h, &title, &link, &image_uri)?;

    let full_usd = math::quote_usd_micro(w, h)?;
    let usd_micro = math::apply_token_discount(full_usd)?;
    let (price, expo) = oracle::read_sol_usd(&ctx.accounts.price_update, config, &clock)?;
    let lamports_equiv = math::usd_to_lamports(usd_micro, price, expo)?;

    let spot = oracle::read_spot_price(
        config,
        &ctx.accounts.price_source.to_account_info(),
        ctx.accounts.pool_base_vault.as_ref().map(|a| a.as_ref()),
        ctx.accounts.pool_quote_vault.as_ref().map(|a| a.as_ref()),
    )?;
    let price_q = oracle::token_buy_price(config, &clock, spot)?;

    // Rate limit on token-paid blocks (bounds what one price-manipulation episode can extract; SOL buys uncapped).
    let blocks = math::rect_blocks(w, h) as u64;
    let config = &mut ctx.accounts.config;
    let elapsed = clock
        .unix_timestamp
        .checked_sub(config.token_blocks_allowance_updated_at)
        .ok_or(PixelError::MathOverflow)?;
    let allowance = math::bucket_refill(
        config.token_blocks_allowance as u64,
        config.token_blocks_cap_per_hour as u64,
        elapsed,
    )?;
    require!(blocks <= allowance, PixelError::TokenBuyCapExceeded);
    config.token_blocks_allowance = (allowance - blocks) as u32;
    config.token_blocks_allowance_updated_at = clock.unix_timestamp;
    let tokens = math::lamports_to_tokens(lamports_equiv, price_q)?;
    require!(tokens > 0, PixelError::InvalidOraclePrice);
    require!(tokens <= max_tokens, PixelError::SlippageExceeded);

    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.token_mint.to_account_info(),
                from: ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        tokens,
    )?;

    let ad_id = canvas.next_ad_id;
    canvas.next_ad_id = ad_id.checked_add(1).ok_or(PixelError::MathOverflow)?;
    canvas.usd_micro_raised = canvas
        .usd_micro_raised
        .checked_add(usd_micro)
        .ok_or(PixelError::MathOverflow)?;
    canvas.tokens_burned_direct = canvas
        .tokens_burned_direct
        .checked_add(tokens)
        .ok_or(PixelError::MathOverflow)?;

    let owner = ctx.accounts.buyer.key();
    write_ad(
        &mut ctx.accounts.ad,
        ad_id,
        owner,
        ctx.bumps.ad,
        x,
        y,
        w,
        h,
        title,
        link,
        image_uri,
        image_sha256,
        PayMode::Token,
        0,
        tokens,
        usd_micro,
        clock.unix_timestamp,
    );

    emit!(AdPurchased {
        ad_id,
        ad: ctx.accounts.ad.key(),
        owner,
        x,
        y,
        w,
        h,
        pay_mode: PayMode::Token,
        lamports: 0,
        tokens_burned: tokens,
        usd_micro,
        ts: clock.unix_timestamp,
    });
    Ok(())
}
