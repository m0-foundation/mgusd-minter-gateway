/// Scaling factor for index values (1.0 = 1e12)
pub const INDEX_SCALE: i128 = 1_000_000_000_000;

/// Scaling factor for rate values (1.0 = 1e12, so 5% = 0.05e12 = 50_000_000_000)
pub const RATE_SCALE: i128 = 1_000_000_000_000;

/// Seconds in a year (365 days)
pub const SECONDS_PER_YEAR: i128 = 31_536_000;

/// Maximum number of accounts in a batch onboard/block/unblock operation
pub const MAX_BATCH_SIZE: u32 = 100;

/// Maximum yield rate in basis points (5,000 bps = 50% APR).
/// Sized as a sanity bound on admin input, set well above any realistic
/// MGUSD yield. Keeps the Taylor-series exponent comfortably small.
pub const MAX_RATE_BPS: u32 = 5_000;
