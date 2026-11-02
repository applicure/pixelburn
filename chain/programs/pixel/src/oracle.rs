//! Oracle reads: Pyth SOL/USD (pull oracle) and the token spot price from pump.fun / PumpSwap.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{constants::*, error::PixelError, math, state::*};

/// SOL/USD with staleness, feed-id, Full-verification and confidence checks. Returns (price, expo).
pub fn read_sol_usd(price_update: &PriceUpdateV2, config: &Config, clock: &Clock) -> Result<(i64, i32)> {
    let p = price_update
        .get_price_no_older_than(clock, config.max_price_age_secs, &config.pyth_feed_id)
        .map_err(|_| error!(PixelError::StalePrice))?;
    require!(p.price > 0, PixelError::InvalidOraclePrice);
    let conf_limit = (p.price as u128)
        .checked_mul(MAX_CONF_BPS as u128)
        .ok_or(PixelError::MathOverflow)?
        / BPS_DENOMINATOR as u128;
    require!(
        (p.conf as u128) <= conf_limit,
        PixelError::OracleConfidenceTooWide
    );
    Ok((p.price, p.exponent))
}

fn read_u64(d: &[u8], off: usize) -> Result<u64> {
    let s = d
        .get(off..off + 8)
        .ok_or(PixelError::InvalidPriceSource)?;
    let mut b = [0u8; 8];
    b.copy_from_slice(s);
    Ok(u64::from_le_bytes(b))
}

fn read_pubkey(d: &[u8], off: usize) -> Result<Pubkey> {
    let s = d
        .get(off..off + 32)
        .ok_or(PixelError::InvalidPriceSource)?;
    let mut b = [0u8; 32];
    b.copy_from_slice(s);
    Ok(Pubkey::new_from_array(b))
}

// pump.fun BondingCurve layout (pump IDL, after the 8-byte discriminator):
//   8  virtual_token_reserves u64
//  16  virtual_quote_reserves u64 (formerly virtual_sol_reserves)
//  24  real_token_reserves u64
//  32  real_quote_reserves u64
//  40  token_total_supply u64
//  48  complete bool
//  49  creator pubkey
//  81  is_mayhem_mode bool
//  82  is_cashback_coin bool
//  83  quote_mint pubkey (appended; missing => default => SOL)
pub const CURVE_MIN_LEN: usize = 49;
pub const CURVE_QUOTE_MINT_OFFSET: usize = 83;

/// Returns (quote_lamports, base_units) from a pump.fun bonding curve.
pub fn parse_bonding_curve(owner: &Pubkey, data: &[u8]) -> Result<(u64, u64)> {
    require_keys_eq!(*owner, PUMP_PROGRAM_ID, PixelError::InvalidPriceSource);
    require!(data.len() >= CURVE_MIN_LEN, PixelError::InvalidPriceSource);
    require!(
        data[..8] == PUMP_BONDING_CURVE_DISCRIMINATOR,
        PixelError::InvalidPriceSource
    );
    require!(data[48] == 0, PixelError::CurveComplete);
    if data.len() >= CURVE_QUOTE_MINT_OFFSET + 32 {
        let quote_mint = read_pubkey(data, CURVE_QUOTE_MINT_OFFSET)?;
        // SOL-paired coins store Pubkey::default(); anything else is quoted in another token.
        require!(
            quote_mint == Pubkey::default() || quote_mint == WSOL_MINT,
            PixelError::InvalidPriceSource
        );
    }
    let vtr = read_u64(data, 8)?;
    let vqr = read_u64(data, 16)?;
    Ok((vqr, vtr))
}

// PumpSwap Pool layout (pump_amm IDL, after discriminator):
//   8 pool_bump u8, 9 index u16, 11 creator, 43 base_mint, 75 quote_mint, 107 lp_mint,
// 139 pool_base_token_account, 171 pool_quote_token_account, 203 lp_supply u64,
// 211 coin_creator, 243 is_mayhem_mode, 244 is_cashback_coin,
// 245 virtual_quote_reserves i128 (appended; missing => 0)
pub const POOL_MIN_LEN: usize = 203;
pub const POOL_VQR_OFFSET: usize = 245;

pub struct ParsedPool {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub virtual_quote_reserves: i128,
}

pub fn parse_pool(owner: &Pubkey, data: &[u8]) -> Result<ParsedPool> {
    require_keys_eq!(*owner, PUMP_AMM_PROGRAM_ID, PixelError::InvalidPriceSource);
    require!(data.len() >= POOL_MIN_LEN, PixelError::InvalidPriceSource);
    require!(
        data[..8] == PUMP_AMM_POOL_DISCRIMINATOR,
        PixelError::InvalidPriceSource
    );
    let vqr = match data.get(POOL_VQR_OFFSET..POOL_VQR_OFFSET + 16) {
        Some(s) => {
            let mut b = [0u8; 16];
            b.copy_from_slice(s);
            i128::from_le_bytes(b)
        }
        None => 0,
    };
    Ok(ParsedPool {
        base_mint: read_pubkey(data, 43)?,
        quote_mint: read_pubkey(data, 75)?,
        base_vault: read_pubkey(data, 139)?,
        quote_vault: read_pubkey(data, 171)?,
        virtual_quote_reserves: vqr,
    })
}

fn read_token_amount(ai: &AccountInfo, expected_mint: &Pubkey) -> Result<u64> {
    require!(
        *ai.owner == anchor_spl::token::ID || *ai.owner == anchor_spl::token_2022::ID,
        PixelError::InvalidPriceSource
    );
    let data = ai.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let acc = <TokenAccount as anchor_lang::AccountDeserialize>::try_deserialize(&mut slice)
        .map_err(|_| error!(PixelError::InvalidPriceSource))?;
    require_keys_eq!(acc.mint, *expected_mint, PixelError::InvalidPriceSource);
    Ok(acc.amount)
}

/// Config-time sanity check for a price source.
/// BondingCurve: must be the canonical pump.fun curve PDA ["bonding-curve", mint] of *our* mint (the curve
/// account itself does not store its mint, so this is the only binding). Pool: the pool's stored base mint and
/// vaults are re-checked on every read in `read_spot_price`.
pub fn validate_price_source(
    source: &PriceSource,
    token_mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<()> {
    match source {
        PriceSource::BondingCurve { curve } => {
            let (expected, _) = Pubkey::find_program_address(
                &[b"bonding-curve", token_mint.as_ref()],
                &PUMP_PROGRAM_ID,
            );
            require_keys_eq!(*curve, expected, PixelError::InvalidParam);
        }
        PriceSource::Pool {
            pool,
            base_vault,
            quote_vault,
        } => {
            // Only the canonical pump.fun migration pool (pump `migrate` IDL):
            //   pool_authority = PDA(["pool-authority", mint], pump)
            //   pool = PDA(["pool", 0u16 LE, pool_authority, mint, WSOL], pump_amm)
            //   vaults = ATAs of the pool (base: mint's token program; quote: SPL Token / WSOL)
            let (pool_authority, _) = Pubkey::find_program_address(
                &[b"pool-authority", token_mint.as_ref()],
                &PUMP_PROGRAM_ID,
            );
            let (expected_pool, _) = Pubkey::find_program_address(
                &[
                    b"pool",
                    &0u16.to_le_bytes(),
                    pool_authority.as_ref(),
                    token_mint.as_ref(),
                    WSOL_MINT.as_ref(),
                ],
                &PUMP_AMM_PROGRAM_ID,
            );
            require_keys_eq!(*pool, expected_pool, PixelError::InvalidParam);
            let (expected_base, _) = Pubkey::find_program_address(
                &[pool.as_ref(), token_program.as_ref(), token_mint.as_ref()],
                &ASSOCIATED_TOKEN_PROGRAM_ID,
            );
            let (expected_quote, _) = Pubkey::find_program_address(
                &[pool.as_ref(), anchor_spl::token::ID.as_ref(), WSOL_MINT.as_ref()],
                &ASSOCIATED_TOKEN_PROGRAM_ID,
            );
            require_keys_eq!(*base_vault, expected_base, PixelError::InvalidParam);
            require_keys_eq!(*quote_vault, expected_quote, PixelError::InvalidParam);
        }
    }
    Ok(())
}

/// Admin (re)seeds the EMA: value supplied by the admin (0 = token pricing disabled), checked against spot at the
/// first crank (EMA_SEED_BAND_BPS); warm-up restarts.
pub fn seed_ema(config: &mut Config, initial_ema: u128, clock: &Clock) {
    config.token_ema_price_sol = initial_ema;
    config.token_ema_prev_price_sol = initial_ema;
    config.token_slow_ema_price_sol = initial_ema;
    config.token_slow_ema_prev_price_sol = initial_ema;
    config.token_spot_price_sol = 0;
    config.ema_updated_at = clock.unix_timestamp;
    config.ema_updated_slot = clock.slot;
    config.ema_warmup_cranks = 0;
    config.ema_warmup_started_at = 0;
}

pub fn ema_warm(config: &Config, clock: &Clock) -> Result<()> {
    require!(
        config.ema_warmup_cranks >= EMA_WARMUP_CRANKS
            && clock
                .unix_timestamp
                .checked_sub(config.ema_warmup_started_at)
                .ok_or(PixelError::MathOverflow)?
                >= EMA_WARMUP_SECS,
        PixelError::EmaWarmingUp
    );
    Ok(())
}

/// Price token buyers are charged at: requires a warmed-up, fresh EMA and spot <= fast EMA * (1 + 15%); returns
/// min(spot, fast EMA, slow EMA) (pre-slot values). The band is ONE-SIDED: spot below the EMA is safe (min() makes
/// the buyer pay more tokens), so token buys keep working in a crash and the DoS surface is halved.
pub fn token_buy_price(config: &Config, clock: &Clock, spot: u128) -> Result<u128> {
    ema_warm(config, clock)?;
    let ema = usable_ema(config, clock)?;
    let ceiling = ema
        .checked_add(
            ema.checked_mul(EMA_MAX_DEVIATION_BPS as u128)
                .ok_or(PixelError::MathOverflow)?
                / BPS_DENOMINATOR as u128,
        )
        .ok_or(PixelError::MathOverflow)?;
    require!(spot <= ceiling, PixelError::PriceDeviationTooHigh);
    let slow = usable_slow_ema(config, clock)?;
    crate::math::buy_price_q(spot, ema.min(slow))
}

/// Slow EMA as of before this slot (same-slot rule as the fast one; freshness is shared via ema_updated_at).
pub fn usable_slow_ema(config: &Config, clock: &Clock) -> Result<u128> {
    let v = if config.ema_updated_slot == clock.slot {
        config.token_slow_ema_prev_price_sol
    } else {
        config.token_slow_ema_price_sol
    };
    require!(v > 0, PixelError::EmaUnavailable);
    Ok(v)
}

/// Reads the token spot price (lamports per base unit * 1e18) from the configured source.
/// `a` = curve or pool; `b`/`c` = pool base/quote vaults (Pool source only).
pub fn read_spot_price<'info>(
    config: &Config,
    a: &AccountInfo<'info>,
    b: Option<&AccountInfo<'info>>,
    c: Option<&AccountInfo<'info>>,
) -> Result<u128> {
    match config.price_source {
        PriceSource::BondingCurve { curve } => {
            require_keys_eq!(a.key(), curve, PixelError::InvalidPriceSource);
            let data = a.try_borrow_data()?;
            let (quote, base) = parse_bonding_curve(a.owner, &data)?;
            math::spot_price_q(quote, base)
        }
        PriceSource::Pool {
            pool,
            base_vault,
            quote_vault,
        } => {
            require_keys_eq!(a.key(), pool, PixelError::InvalidPriceSource);
            let b = b.ok_or(PixelError::InvalidPriceSource)?;
            let c = c.ok_or(PixelError::InvalidPriceSource)?;
            require_keys_eq!(b.key(), base_vault, PixelError::InvalidPriceSource);
            require_keys_eq!(c.key(), quote_vault, PixelError::InvalidPriceSource);
            let parsed = {
                let data = a.try_borrow_data()?;
                parse_pool(a.owner, &data)?
            };
            require_keys_eq!(parsed.base_mint, config.token_mint, PixelError::InvalidPriceSource);
            require_keys_eq!(parsed.quote_mint, WSOL_MINT, PixelError::InvalidPriceSource);
            require_keys_eq!(parsed.base_vault, base_vault, PixelError::InvalidPriceSource);
            require_keys_eq!(parsed.quote_vault, quote_vault, PixelError::InvalidPriceSource);
            let base = read_token_amount(b, &config.token_mint)?;
            let quote_raw = read_token_amount(c, &WSOL_MINT)?;
            let effective = (quote_raw as i128)
                .checked_add(parsed.virtual_quote_reserves)
                .ok_or(PixelError::MathOverflow)?;
            require!(effective > 0, PixelError::EmptyReserves);
            let quote = u64::try_from(effective).map_err(|_| error!(PixelError::MathOverflow))?;
            math::spot_price_q(quote, base)
        }
    }
}

/// EMA value buys may use: if the EMA was cranked in this very slot, use the pre-crank value so a
/// pump + crank + buy bundle in one slot can't benefit from the crank it just made.
pub fn usable_ema(config: &Config, clock: &Clock) -> Result<u128> {
    require!(config.token_ema_price_sol > 0, PixelError::EmaUnavailable);
    let age = clock
        .unix_timestamp
        .checked_sub(config.ema_updated_at)
        .ok_or(PixelError::MathOverflow)?;
    require!(age <= MAX_EMA_AGE_SECS, PixelError::EmaUnavailable);
    let ema = if config.ema_updated_slot == clock.slot {
        config.token_ema_prev_price_sol
    } else {
        config.token_ema_price_sol
    };
    require!(ema > 0, PixelError::EmaUnavailable);
    Ok(ema)
}
