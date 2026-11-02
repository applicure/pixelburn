use anchor_lang::prelude::*;

#[error_code]
pub enum PixelError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Rectangle is out of bounds or empty")]
    OutOfBounds,
    #[msg("Rectangle overlaps already sold blocks")]
    Overlap,
    #[msg("Fixed-price sales are closed: final auction threshold reached")]
    SalesClosed,
    #[msg("Title too long or contains control characters")]
    InvalidTitle,
    #[msg("Link must be https:// and at most 200 bytes, no whitespace/control chars")]
    InvalidLink,
    #[msg("Image URI must be ar:// or https:// and at most 200 bytes, no whitespace/control chars")]
    InvalidImageUri,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Price exceeds max_lamports / max_tokens slippage guard")]
    SlippageExceeded,
    #[msg("Pyth price is stale, unverified, or for the wrong feed")]
    StalePrice,
    #[msg("Pyth price is non-positive or has an unsupported exponent")]
    InvalidOraclePrice,
    #[msg("Pyth confidence interval too wide")]
    OracleConfidenceTooWide,
    #[msg("Price source account does not match config or has an unexpected layout")]
    InvalidPriceSource,
    #[msg("Bonding curve is complete (migrated); switch price source to the pool")]
    CurveComplete,
    #[msg("Reserves are zero")]
    EmptyReserves,
    #[msg("Token price crank called too soon")]
    CrankTooSoon,
    #[msg("Token EMA not initialised or too old; crank the price first")]
    EmaUnavailable,
    #[msg("Token EMA is warming up (needs 10 cranks over >= 10 minutes after seeding)")]
    EmaWarmingUp,
    #[msg("Spot price deviates too far from the EMA; token buys paused until they converge")]
    PriceDeviationTooHigh,
    #[msg("First crank after seeding: spot is outside the seed band; admin must re-seed the EMA")]
    EmaSeedMismatch,
    #[msg("Hourly limit for token-paid blocks reached; try later or pay in SOL")]
    TokenBuyCapExceeded,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid parameter")]
    InvalidParam,
    #[msg("Final auction threshold not reached")]
    AuctionThresholdNotReached,
    #[msg("No free blocks left to auction")]
    NothingToAuction,
    #[msg("Auction is not active")]
    AuctionNotActive,
    #[msg("Auction has ended")]
    AuctionEnded,
    #[msg("Auction has not ended yet")]
    AuctionNotEnded,
    #[msg("Bid too low")]
    BidTooLow,
    #[msg("Previous bidder account missing or wrong")]
    InvalidPreviousBidder,
    #[msg("Current highest bidder cannot outbid themselves")]
    AlreadyHighestBidder,
    #[msg("Buyback hourly cap exceeded")]
    BuybackCapExceeded,
    #[msg("Previous buyback release not yet recorded")]
    BuybackOutstanding,
    #[msg("Buyback amount exceeds outstanding released lamports")]
    BuybackAmountTooHigh,
    #[msg("Too few tokens burned for the lamports spent")]
    BuybackRateTooLow,
    #[msg("Insufficient funds in buyback vault")]
    InsufficientVaultFunds,
}
