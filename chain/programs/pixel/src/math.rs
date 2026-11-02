//! Pure, side-effect-free helpers (geometry, bitmap, pricing). Unit tested on the host.
use anchor_lang::prelude::*;

use crate::{constants::*, error::PixelError};

// ============================================================ geometry / bitmap

/// Validates a rectangle in block units: w,h >= 1, x+w <= 100, y+h <= 100.
pub fn validate_rect(x: u8, y: u8, w: u8, h: u8) -> Result<()> {
    require!(w >= 1 && h >= 1, PixelError::OutOfBounds);
    let x_end = (x as u16).checked_add(w as u16).ok_or(PixelError::MathOverflow)?;
    let y_end = (y as u16).checked_add(h as u16).ok_or(PixelError::MathOverflow)?;
    require!(x_end <= GRID && y_end <= GRID, PixelError::OutOfBounds);
    Ok(())
}

/// Block index of (x, y) = y*100 + x as u16 LE (ad PDA seed). Never overflows for u8 inputs; out-of-range
/// coordinates are rejected by `validate_rect` in the handler.
pub fn block_index_le(x: u8, y: u8) -> [u8; 2] {
    ((y as u16) * GRID + x as u16).to_le_bytes()
}

/// Number of blocks in a (validated) rectangle.
pub fn rect_blocks(w: u8, h: u8) -> u16 {
    // w,h <= 100 after validation, product <= 10_000 fits u16.
    (w as u16) * (h as u16)
}

#[inline]
fn byte_mask(lo: usize, hi: usize) -> u8 {
    // bits [lo, hi) of a byte, 0 <= lo < hi <= 8
    let hi_mask: u16 = (1u16 << hi) - 1;
    let lo_mask: u16 = (1u16 << lo) - 1;
    (hi_mask ^ lo_mask) as u8
}

/// Calls `f(byte_index, mask)` for every byte touched by the rectangle (one call per byte per row).
/// Caller must have validated the rectangle.
fn for_each_rect_mask<F: FnMut(usize, u8) -> bool>(x: u8, y: u8, w: u8, h: u8, mut f: F) -> bool {
    let grid = GRID as usize;
    for row in (y as usize)..(y as usize + h as usize) {
        let start = row * grid + x as usize;
        let end = start + w as usize; // exclusive
        let mut b = start / 8;
        let last = (end - 1) / 8;
        while b <= last {
            let base = b * 8;
            let lo = start.max(base) - base;
            let hi = end.min(base + 8) - base;
            if !f(b, byte_mask(lo, hi)) {
                return false;
            }
            b += 1;
        }
    }
    true
}

/// True when none of the rectangle's blocks are set. Rectangle must be validated.
pub fn is_rect_free(bitmap: &[u8; BITMAP_BYTES], x: u8, y: u8, w: u8, h: u8) -> bool {
    for_each_rect_mask(x, y, w, h, |b, m| bitmap[b] & m == 0)
}

/// Sets all of the rectangle's blocks. Rectangle must be validated.
pub fn mark_rect(bitmap: &mut [u8; BITMAP_BYTES], x: u8, y: u8, w: u8, h: u8) {
    for_each_rect_mask(x, y, w, h, |b, m| {
        bitmap[b] |= m;
        true
    });
}

pub fn count_set(bitmap: &[u8; BITMAP_BYTES]) -> u16 {
    // 1250 * 8 = 10_000 fits u16
    bitmap.iter().map(|b| b.count_ones() as u16).sum()
}

// ============================================================ ad content

/// Unicode general category Cf (format) code points: bidi controls, zero-width chars, BOM, tags…
/// (`char::is_control` only covers Cc.) Source: Unicode 15 DerivedGeneralCategory, Cf.
pub fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// Title: no control (Cc) and no format (Cf) characters; ordinary spaces allowed.
fn bad_title(s: &str) -> bool {
    s.chars().any(|c| c.is_control() || is_format_char(c))
}

/// URLs: printable ASCII only (0x21..=0x7E): no spaces, no Unicode look-alikes, no bidi/zero-width tricks.
fn bad_url(s: &str) -> bool {
    !s.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

pub fn validate_content(title: &str, link: &str, image_uri: &str) -> Result<()> {
    require!(
        title.len() <= MAX_TITLE_LEN && !bad_title(title),
        PixelError::InvalidTitle
    );
    require!(
        link.len() <= MAX_LINK_LEN
            && link.len() > "https://".len()
            && link.starts_with("https://")
            && !bad_url(link),
        PixelError::InvalidLink
    );
    require!(
        image_uri.len() <= MAX_IMAGE_URI_LEN
            && ((image_uri.starts_with("ar://") && image_uri.len() > "ar://".len())
                || (image_uri.starts_with("https://") && image_uri.len() > "https://".len()))
            && !bad_url(image_uri),
        PixelError::InvalidImageUri
    );
    Ok(())
}

// ============================================================ pricing

#[inline]
fn ceil_div_u128(a: u128, b: u128) -> Option<u128> {
    if b == 0 {
        return None;
    }
    let q = a / b;
    if a % b == 0 {
        Some(q)
    } else {
        q.checked_add(1)
    }
}

/// Fixed USD price of w*h blocks in micro-USD.
pub fn quote_usd_micro(w: u8, h: u8) -> Result<u64> {
    (rect_blocks(w, h) as u64)
        .checked_mul(PRICE_PER_BLOCK_USD_MICRO)
        .ok_or(error!(PixelError::MathOverflow))
}

/// USD after the token discount, rounded up (never under-charges).
pub fn apply_token_discount(usd_micro: u64) -> Result<u64> {
    let v = ceil_div_u128(
        (usd_micro as u128)
            .checked_mul((BPS_DENOMINATOR - TOKEN_DISCOUNT_BPS) as u128)
            .ok_or(PixelError::MathOverflow)?,
        BPS_DENOMINATOR as u128,
    )
    .ok_or(PixelError::MathOverflow)?;
    u64::try_from(v).map_err(|_| error!(PixelError::MathOverflow))
}

/// Splits a SOL payment: treasury gets floor(lamports * TREASURY_BPS / 10_000), buyback gets the rest.
/// The two parts always sum to `lamports` exactly.
pub fn split_sol(lamports: u64) -> Result<(u64, u64)> {
    let treasury = (lamports as u128)
        .checked_mul(TREASURY_BPS as u128)
        .ok_or(PixelError::MathOverflow)?
        / BPS_DENOMINATOR as u128;
    let treasury = u64::try_from(treasury).map_err(|_| error!(PixelError::MathOverflow))?;
    let buyback = lamports
        .checked_sub(treasury)
        .ok_or(PixelError::MathOverflow)?;
    Ok((treasury, buyback))
}

/// Pyth SOL/USD = price * 10^expo. lamports = ceil(usd_micro * 10^(3 - expo) / price).
pub fn usd_to_lamports(usd_micro: u64, price: i64, expo: i32) -> Result<u64> {
    require!(price > 0, PixelError::InvalidOraclePrice);
    require!((-18..=6).contains(&expo), PixelError::InvalidOraclePrice);
    let price = price as u128;
    let shift = 3i32.checked_sub(expo).ok_or(PixelError::MathOverflow)?;
    let lamports = if shift >= 0 {
        let scale = 10u128
            .checked_pow(shift as u32)
            .ok_or(PixelError::MathOverflow)?;
        let num = (usd_micro as u128)
            .checked_mul(scale)
            .ok_or(PixelError::MathOverflow)?;
        ceil_div_u128(num, price).ok_or(PixelError::MathOverflow)?
    } else {
        let scale = 10u128
            .checked_pow((-shift) as u32)
            .ok_or(PixelError::MathOverflow)?;
        let den = price.checked_mul(scale).ok_or(PixelError::MathOverflow)?;
        ceil_div_u128(usd_micro as u128, den).ok_or(PixelError::MathOverflow)?
    };
    require!(lamports > 0, PixelError::InvalidOraclePrice);
    u64::try_from(lamports).map_err(|_| error!(PixelError::MathOverflow))
}

/// tokens (base units) = ceil(lamports * 1e18 / price_q), price_q = lamports per base unit * 1e18.
pub fn lamports_to_tokens(lamports: u64, price_q: u128) -> Result<u64> {
    require!(price_q > 0, PixelError::EmaUnavailable);
    let num = (lamports as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(PixelError::MathOverflow)?;
    let t = ceil_div_u128(num, price_q).ok_or(PixelError::MathOverflow)?;
    u64::try_from(t).map_err(|_| error!(PixelError::MathOverflow))
}

/// Spot price = quote (lamports) * 1e18 / base (token base units), floored (favours the protocol).
pub fn spot_price_q(quote_reserves: u64, base_reserves: u64) -> Result<u128> {
    require!(quote_reserves > 0 && base_reserves > 0, PixelError::EmptyReserves);
    let p = (quote_reserves as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(PixelError::MathOverflow)?
        / base_reserves as u128;
    require!(p > 0, PixelError::EmptyReserves);
    Ok(p)
}

fn bps_of(v: u128, bps: u64) -> Result<u128> {
    Ok(v.checked_mul(bps as u128).ok_or(PixelError::MathOverflow)? / BPS_DENOMINATOR as u128)
}

/// One crank step of an EMA with alpha = num/den. The EMA must already be seeded (> 0): no single-read seeding.
/// spot is clamped to ema * (1 +/- EMA_SPOT_CLAMP_BPS), then ema += alpha * (spot_c - ema), alpha FIXED (no dt).
pub fn ema_step(ema: u128, spot: u128, alpha_num: u128, alpha_den: u128) -> Result<u128> {
    require!(ema > 0, PixelError::EmaUnavailable);
    let band = bps_of(ema, EMA_SPOT_CLAMP_BPS)?;
    let lo = ema.checked_sub(band).ok_or(PixelError::MathOverflow)?;
    let hi = ema.checked_add(band).ok_or(PixelError::MathOverflow)?;
    let s = spot.clamp(lo, hi);
    let step = |d: u128| -> Result<u128> {
        Ok(d.checked_mul(alpha_num).ok_or(PixelError::MathOverflow)? / alpha_den)
    };
    let new = if s >= ema {
        ema.checked_add(step(s - ema)?).ok_or(PixelError::MathOverflow)?
    } else {
        ema.checked_sub(step(ema - s)?).ok_or(PixelError::MathOverflow)?
    };
    require!(new > 0, PixelError::EmaUnavailable);
    Ok(new)
}

/// Slow EMA step: alpha = EMA_MIN_INTERVAL_SECS / SLOW_EMA_WINDOW_SECS = 1/480.
pub fn slow_ema_update(ema: u128, spot: u128) -> Result<u128> {
    ema_step(ema, spot, EMA_MIN_INTERVAL_SECS as u128, SLOW_EMA_WINDOW_SECS as u128)
}

/// Fast EMA step (legacy implementation kept for exact rounding: bps_of based).
/// spot is clamped to ema * (1 +/- EMA_SPOT_CLAMP_BPS), then ema += alpha * (spot_c - ema) with a FIXED alpha
/// (EMA_ALPHA_BPS), independent of the time since the last crank. Max move per crank = MAX_EMA_STEP_BPS (2%).
pub fn ema_update(ema: u128, spot: u128) -> Result<u128> {
    require!(ema > 0, PixelError::EmaUnavailable);
    let band = bps_of(ema, EMA_SPOT_CLAMP_BPS)?;
    let lo = ema.checked_sub(band).ok_or(PixelError::MathOverflow)?;
    let hi = ema.checked_add(band).ok_or(PixelError::MathOverflow)?;
    let s = spot.clamp(lo, hi);
    let new = if s >= ema {
        ema.checked_add(bps_of(s - ema, EMA_ALPHA_BPS)?)
            .ok_or(PixelError::MathOverflow)?
    } else {
        ema.checked_sub(bps_of(ema - s, EMA_ALPHA_BPS)?)
            .ok_or(PixelError::MathOverflow)?
    };
    // 0 would disable token buys forever; impossible with the 40% clamp, but keep the invariant explicit.
    require!(new > 0, PixelError::EmaUnavailable);
    Ok(new)
}

/// |a - b| <= b * bps / 10_000
pub fn within_band(a: u128, b: u128, bps: u64) -> Result<bool> {
    let diff = a.abs_diff(b);
    Ok(diff <= bps_of(b, bps)?)
}

/// Price used to charge token buyers: the lower of spot and EMA (=> more tokens owed).
pub fn buy_price_q(spot: u128, ema: u128) -> Result<u128> {
    require!(ema > 0, PixelError::EmaUnavailable);
    Ok(spot.min(ema))
}

/// Token-bucket refill: allowance + cap * elapsed / 3600, capped at cap.
pub fn bucket_refill(allowance: u64, cap: u64, elapsed_secs: i64) -> Result<u64> {
    let elapsed = elapsed_secs.max(0) as u128;
    let refill = (cap as u128).checked_mul(elapsed).ok_or(PixelError::MathOverflow)? / 3_600;
    Ok(((allowance as u128).checked_add(refill).ok_or(PixelError::MathOverflow)?).min(cap as u128) as u64)
}

/// Minimum tokens the keeper must burn for `lamports` spent, priced at the (pre-slot) EMA.
/// Spot is deliberately NOT used: the keeper could pump spot inside its own tx to lower the bar.
pub fn min_buyback_tokens(lamports: u64, ema: u128, slippage_bps: u16) -> Result<u64> {
    let reference = ema;
    require!(reference > 0, PixelError::EmaUnavailable);
    let fair = (lamports as u128)
        .checked_mul(PRICE_SCALE)
        .ok_or(PixelError::MathOverflow)?
        / reference;
    let min = fair
        .checked_mul((BPS_DENOMINATOR - slippage_bps as u64) as u128)
        .ok_or(PixelError::MathOverflow)?
        / BPS_DENOMINATOR as u128;
    u64::try_from(min).map_err(|_| error!(PixelError::MathOverflow))
}

/// Minimum acceptable next bid.
pub fn min_next_bid(highest_bid: u64) -> Result<u64> {
    if highest_bid == 0 {
        return Ok(AUCTION_MIN_OPENING_BID_LAMPORTS);
    }
    let pct = (highest_bid as u128)
        .checked_mul(AUCTION_MIN_INCREMENT_BPS as u128)
        .ok_or(PixelError::MathOverflow)?
        / BPS_DENOMINATOR as u128;
    let inc = (pct as u64).max(AUCTION_MIN_INCREMENT_LAMPORTS);
    highest_bid
        .checked_add(inc)
        .ok_or(error!(PixelError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive_free(bm: &[u8; BITMAP_BYTES], x: u8, y: u8, w: u8, h: u8) -> bool {
        for by in y as usize..(y + h) as usize {
            for bx in x as usize..(x + w) as usize {
                let i = by * 100 + bx;
                if bm[i / 8] & (1 << (i % 8)) != 0 {
                    return false;
                }
            }
        }
        true
    }
    fn naive_mark(bm: &mut [u8; BITMAP_BYTES], x: u8, y: u8, w: u8, h: u8) {
        for by in y as usize..(y + h) as usize {
            for bx in x as usize..(x + w) as usize {
                let i = by * 100 + bx;
                bm[i / 8] |= 1 << (i % 8);
            }
        }
    }

    #[test]
    fn rect_bounds() {
        assert!(validate_rect(0, 0, 100, 100).is_ok());
        assert!(validate_rect(99, 99, 1, 1).is_ok());
        assert!(validate_rect(0, 99, 100, 1).is_ok());
        assert!(validate_rect(99, 0, 1, 100).is_ok());
        assert!(validate_rect(99, 0, 2, 1).is_err());
        assert!(validate_rect(0, 99, 1, 2).is_err());
        assert!(validate_rect(100, 0, 1, 1).is_err());
        assert!(validate_rect(0, 0, 0, 1).is_err());
        assert!(validate_rect(0, 0, 1, 0).is_err());
        assert!(validate_rect(255, 255, 255, 255).is_err());
        assert!(validate_rect(1, 0, 255, 1).is_err());
    }

    #[test]
    fn bitmap_matches_naive_exhaustive_edges() {
        // Every 1-wide/1-tall rect along every edge + a pseudo-random sweep.
        let mut seed: u64 = 0x1234_5678_9abc_def0;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _round in 0..200 {
            let mut a = [0u8; BITMAP_BYTES];
            let mut b = [0u8; BITMAP_BYTES];
            for _ in 0..(rnd() % 20) {
                let w = (rnd() % 30 + 1) as u8;
                let h = (rnd() % 30 + 1) as u8;
                let x = (rnd() % (101 - w as u64)) as u8;
                let y = (rnd() % (101 - h as u64)) as u8;
                mark_rect(&mut a, x, y, w, h);
                naive_mark(&mut b, x, y, w, h);
            }
            assert_eq!(a, b);
            for _ in 0..500 {
                let w = (rnd() % 100 + 1) as u8;
                let h = (rnd() % 100 + 1) as u8;
                let x = (rnd() % (101 - w as u64)) as u8;
                let y = (rnd() % (101 - h as u64)) as u8;
                assert_eq!(is_rect_free(&a, x, y, w, h), naive_free(&a, x, y, w, h));
            }
        }
    }

    #[test]
    fn bitmap_edges() {
        let mut bm = [0u8; BITMAP_BYTES];
        mark_rect(&mut bm, 99, 99, 1, 1);
        assert_eq!(bm[1249], 0b1000_0000);
        assert_eq!(count_set(&bm), 1);
        assert!(!is_rect_free(&bm, 0, 0, 100, 100));
        assert!(is_rect_free(&bm, 0, 0, 99, 100));
        assert!(is_rect_free(&bm, 0, 0, 100, 99));
        mark_rect(&mut bm, 0, 0, 100, 1);
        assert_eq!(count_set(&bm), 101);
        assert!(!is_rect_free(&bm, 50, 0, 1, 1));
        assert!(is_rect_free(&bm, 0, 1, 100, 98));
        // adjacent but not overlapping on all four sides of a centre rect
        let mut bm = [0u8; BITMAP_BYTES];
        mark_rect(&mut bm, 10, 10, 5, 5);
        assert!(is_rect_free(&bm, 5, 10, 5, 5)); // left, x+w == 10
        assert!(is_rect_free(&bm, 15, 10, 5, 5)); // right
        assert!(is_rect_free(&bm, 10, 5, 5, 5)); // above
        assert!(is_rect_free(&bm, 10, 15, 5, 5)); // below
        assert!(!is_rect_free(&bm, 6, 10, 5, 5));
        assert!(!is_rect_free(&bm, 14, 14, 5, 5));
        mark_rect(&mut bm, 0, 0, 100, 100);
        assert_eq!(count_set(&bm), 10_000);
    }

    #[test]
    fn split_no_leak() {
        for l in [0u64, 1, 2, 3, 999, 1_000_000_001, u64::MAX] {
            let (t, b) = split_sol(l).unwrap();
            assert_eq!(t + b, l);
            assert!(b >= t);
            assert!(b - t <= 1);
        }
        assert_eq!(split_sol(3).unwrap(), (1, 2));
    }

    #[test]
    fn lamports_quote() {
        // $100 at $150.00000000 (expo -8) => 0.6666.. SOL => ceil
        let l = usd_to_lamports(100_000_000, 15_000_000_000, -8).unwrap();
        assert_eq!(l, 666_666_667);
        // $1 at $1 (expo 0)
        assert_eq!(usd_to_lamports(1_000_000, 1, 0).unwrap(), 1_000_000_000);
        // positive expo path: $1 at price 1, expo 4 ($10k/SOL) => 1e5 lamports
        assert_eq!(usd_to_lamports(1_000_000, 1, 4).unwrap(), 100_000);
        assert!(usd_to_lamports(1, 0, -8).is_err());
        assert!(usd_to_lamports(1, -5, -8).is_err());
        // whole canvas at a tiny price does not overflow silently
        assert!(usd_to_lamports(1_000_000_000_000, 1, -18).is_err());
    }

    #[test]
    fn token_quote() {
        // price: 1 lamport per base unit
        assert_eq!(lamports_to_tokens(1_000, PRICE_SCALE).unwrap(), 1_000);
        // rounding up
        assert_eq!(lamports_to_tokens(1, 3 * PRICE_SCALE).unwrap(), 1);
        assert!(lamports_to_tokens(1, 0).is_err());
        assert_eq!(apply_token_discount(100_000_000).unwrap(), 90_000_000);
        assert_eq!(apply_token_discount(1).unwrap(), 1);
    }

    #[test]
    fn ema_and_min() {
        let p = PRICE_SCALE;
        // no seeding from spot
        assert!(ema_update(0, p).is_err());
        // within the clamp: 5% of the gap
        assert_eq!(ema_update(p, p + p / 10).unwrap(), p + p / 200);
        assert_eq!(ema_update(p, p - p / 10).unwrap(), p - p / 200);
        // far outside the clamp: at most +/-2% per crank, however big the move (no dt term at all)
        assert_eq!(ema_update(p, 100 * p).unwrap(), p + p / 50);
        assert_eq!(ema_update(p, 1).unwrap(), p - p / 50);
        // 10 cranks of a held 4x pump: <= 1.02^10 ~ +21.9%
        let mut e = p;
        for _ in 0..10 {
            e = ema_update(e, 4 * p).unwrap();
        }
        assert!(e <= p * 1219 / 1000, "{e}");
        // slow EMA: <= 0.0833% per crank
        assert_eq!(slow_ema_update(p, 100 * p).unwrap(), p + (p * 4_000 / 10_000) * 30 / 14_400);
        let mut s = p;
        for _ in 0..120 {
            s = slow_ema_update(s, 100 * s).unwrap();
        }
        assert!(s <= p * 1_106 / 1_000, "1h of max ratchet <= +10.6%: {s}");
        assert!(slow_ema_update(0, p).is_err());
        assert_eq!(bucket_refill(0, 1_000, 1_800).unwrap(), 500);
        assert_eq!(bucket_refill(900, 1_000, 3_600).unwrap(), 1_000);
        assert_eq!(bucket_refill(5, 1_000, -10).unwrap(), 5);
        assert!(within_band(p + p * 15 / 100, p, 1_500).unwrap());
        assert!(!within_band(p + p * 15 / 100 + 1, p, 1_500).unwrap());
        assert!(!within_band(p - p * 15 / 100 - 1, p, 1_500).unwrap());
        // manipulation: pumping spot 100x never lowers the price below the honest one
        let honest = p;
        let pumped = 100 * p;
        assert_eq!(buy_price_q(pumped, honest).unwrap(), honest);
        assert_eq!(buy_price_q(honest / 2, honest).unwrap(), honest / 2);
        assert!(buy_price_q(p, 0).is_err());
    }

    #[test]
    fn spot_and_buyback() {
        assert_eq!(spot_price_q(30_000_000_000, 1_073_000_000_000_000).unwrap(), 27_958_993_476_234);
        assert!(spot_price_q(0, 1).is_err());
        assert!(spot_price_q(1, 0).is_err());
        assert_eq!(min_buyback_tokens(1_000, PRICE_SCALE, 1_000).unwrap(), 900);
        assert!(min_buyback_tokens(1_000, 0, 1_000).is_err());
    }

    #[test]
    fn bids() {
        assert_eq!(min_next_bid(0).unwrap(), AUCTION_MIN_OPENING_BID_LAMPORTS);
        assert_eq!(min_next_bid(100_000_000).unwrap(), 110_000_000);
        assert_eq!(min_next_bid(1_000_000_000).unwrap(), 1_050_000_000);
        assert!(min_next_bid(u64::MAX).is_err());
    }

    #[test]
    fn content() {
        assert!(validate_content("hi", "https://a.b", "ar://x").is_ok());
        assert!(validate_content("", "https://a.b", "https://x").is_ok());
        assert!(validate_content("hi", "http://a.b", "ar://x").is_err());
        assert!(validate_content("hi", "https://", "ar://x").is_err());
        assert!(validate_content("hi", "https://a b", "ar://x").is_err());
        assert!(validate_content("hi", "javascript:alert(1)", "ar://x").is_err());
        assert!(validate_content("hi", "https://a.b", "ipfs://x").is_err());
        assert!(validate_content("a\nb", "https://a.b", "ar://x").is_err());
        assert!(validate_content(&"a".repeat(65), "https://a.b", "ar://x").is_err());
        assert!(validate_content(&"a".repeat(64), "https://a.b", "ar://x").is_ok());
        // L-2: format chars / non-ASCII URLs
        assert!(validate_content("evil\u{202E}gnp.exe", "https://a.b", "ar://x").is_err());
        assert!(validate_content("zero\u{200B}width", "https://a.b", "ar://x").is_err());
        assert!(validate_content("bom\u{FEFF}", "https://a.b", "ar://x").is_err());
        assert!(validate_content("héllo wörld ✓", "https://a.b", "ar://x").is_ok());
        assert!(validate_content("t", "https://exаmple.com", "ar://x").is_err()); // Cyrillic а
        assert!(validate_content("t", "https://a.b/\u{202E}", "ar://x").is_err());
        assert!(validate_content("t", "https://a.b", "ar://x\u{200B}").is_err());
        let long = format!("https://{}", "a".repeat(193));
        assert!(validate_content("t", &long, "ar://x").is_err());
    }
}
