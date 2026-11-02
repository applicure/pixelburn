#![allow(clippy::result_large_err)]

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS");

// Embedded security contact (https://github.com/neodyme-labs/solana-security-txt). PLACEHOLDER values: confirm the
// contact, policy and source URLs with the customer before the verified mainnet build.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "The Million Pixel Burn (pixel)",
    project_url: "https://pixelburn.applicure.io",
    contacts: "email:security@applicure.io",
    policy: "https://pixelburn.applicure.io/security",
    preferred_languages: "en,de",
    source_code: "https://github.com/applicure/pixelburn",
    source_release: "",
    auditors: "Internal review 2026-11 (see chain/NOTES.md, audit rounds 1-4)"
}

#[program]
pub mod pixel {
    use super::*;

    // ---------------------------------------------------------------- admin
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, params)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_paused(ctx, paused)
    }

    pub fn set_treasury(ctx: Context<AdminOnly>, treasury: Pubkey) -> Result<()> {
        instructions::admin::handle_set_treasury(ctx, treasury)
    }

    pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
        instructions::admin::handle_set_keeper(ctx, keeper)
    }

    pub fn set_price_source(
        ctx: Context<AdminOnly>,
        price_source: PriceSource,
        initial_ema_price_sol: u128,
    ) -> Result<()> {
        instructions::admin::handle_set_price_source(ctx, price_source, initial_ema_price_sol)
    }

    pub fn set_params(
        ctx: Context<AdminOnly>,
        max_price_age_secs: u64,
        buyback_cap_lamports_per_hour: u64,
        buyback_max_slippage_bps: u16,
        token_blocks_cap_per_hour: u16,
    ) -> Result<()> {
        instructions::admin::handle_set_params(
            ctx,
            max_price_age_secs,
            buyback_cap_lamports_per_hour,
            buyback_max_slippage_bps,
            token_blocks_cap_per_hour,
        )
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::handle_accept_admin(ctx)
    }

    // ---------------------------------------------------------------- buying
    #[allow(clippy::too_many_arguments)]
    pub fn buy_with_sol(
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
        instructions::buy::handle_buy_with_sol(
            ctx, x, y, w, h, title, link, image_uri, image_sha256, max_lamports,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn buy_with_token(
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
        instructions::buy::handle_buy_with_token(
            ctx, x, y, w, h, title, link, image_uri, image_sha256, max_tokens,
        )
    }

    pub fn crank_token_price(ctx: Context<CrankTokenPrice>) -> Result<()> {
        instructions::crank::handle_crank_token_price(ctx)
    }

    // ---------------------------------------------------------------- buyback (keeper fallback)
    pub fn release_buyback(ctx: Context<ReleaseBuyback>, lamports: u64) -> Result<()> {
        instructions::buyback::handle_release_buyback(ctx, lamports)
    }

    pub fn record_buyback_burn(
        ctx: Context<RecordBuybackBurn>,
        lamports_spent: u64,
        tokens_burned: u64,
    ) -> Result<()> {
        instructions::buyback::handle_record_buyback_burn(ctx, lamports_spent, tokens_burned)
    }

    // ---------------------------------------------------------------- ads
    pub fn update_ad(
        ctx: Context<UpdateAd>,
        title: String,
        link: String,
        image_uri: String,
        image_sha256: [u8; 32],
    ) -> Result<()> {
        instructions::ad::handle_update_ad(ctx, title, link, image_uri, image_sha256)
    }

    pub fn transfer_ad(ctx: Context<TransferAd>, new_owner: Pubkey) -> Result<()> {
        instructions::ad::handle_transfer_ad(ctx, new_owner)
    }

    // ---------------------------------------------------------------- final auction
    pub fn start_final_auction(ctx: Context<StartFinalAuction>) -> Result<()> {
        instructions::auction::handle_start_final_auction(ctx)
    }

    pub fn bid_final_auction(ctx: Context<BidFinalAuction>, lamports: u64) -> Result<()> {
        instructions::auction::handle_bid_final_auction(ctx, lamports)
    }

    pub fn restart_final_auction(ctx: Context<RestartFinalAuction>) -> Result<()> {
        instructions::auction::handle_restart_final_auction(ctx)
    }

    pub fn settle_final_auction(ctx: Context<SettleFinalAuction>) -> Result<()> {
        instructions::auction::handle_settle_final_auction(ctx)
    }
}
