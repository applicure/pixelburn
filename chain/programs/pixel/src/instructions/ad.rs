use anchor_lang::prelude::*;

use crate::{error::PixelError, events::*, math, state::*};

#[derive(Accounts)]
pub struct UpdateAd<'info> {
    pub owner: Signer<'info>,
    /// Any program-owned `Ad` (owner + discriminator checked by Account<>); authority via has_one.
    #[account(mut, has_one = owner @ PixelError::Unauthorized)]
    pub ad: Box<Account<'info, Ad>>,
}

pub fn handle_update_ad(
    ctx: Context<UpdateAd>,
    title: String,
    link: String,
    image_uri: String,
    image_sha256: [u8; 32],
) -> Result<()> {
    math::validate_content(&title, &link, &image_uri)?;
    let now = Clock::get()?.unix_timestamp;
    let ad = &mut ctx.accounts.ad;
    ad.title = title;
    ad.link = link;
    ad.image_uri = image_uri;
    ad.image_sha256 = image_sha256;
    ad.updated_at = now;
    emit!(AdUpdated {
        ad_id: ad.id,
        ad: ad.key(),
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct TransferAd<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ PixelError::Unauthorized)]
    pub ad: Box<Account<'info, Ad>>,
}

pub fn handle_transfer_ad(ctx: Context<TransferAd>, new_owner: Pubkey) -> Result<()> {
    require_keys_neq!(new_owner, Pubkey::default(), PixelError::InvalidParam);
    let now = Clock::get()?.unix_timestamp;
    let ad = &mut ctx.accounts.ad;
    let from = ad.owner;
    ad.owner = new_owner;
    ad.updated_at = now;
    emit!(AdTransferred {
        ad_id: ad.id,
        ad: ad.key(),
        from,
        to: new_owner,
        ts: now,
    });
    Ok(())
}
