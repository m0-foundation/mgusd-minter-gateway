/// Scaling factor for index values (1.0 = 1e12)
pub const INDEX_SCALE: i128 = 1_000_000_000_000;

/// Scaling factor for rate values (1.0 = 1e12, so 5% = 0.05e12 = 50_000_000_000)
pub const RATE_SCALE: i128 = 1_000_000_000_000;

/// Seconds in a year (365 days)
pub const SECONDS_PER_YEAR: i128 = 31_536_000;

/// Maximum number of accounts in a batch freeze/unfreeze operation
pub const MAX_BATCH_SIZE: u32 = 20;
