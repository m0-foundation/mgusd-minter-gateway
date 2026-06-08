use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MinterGatewayError {
    // Common errors — codes align with Soroban SDK built-in error ranges.
    // Codes 2, 5-7 are reserved/unused to avoid collision with SDK conventions.
    InternalError = 1,
    AlreadyInitializedError = 3,
    UnauthorizedError = 4,
    InvalidAmountError = 8, // rejects amount <= 0 in mint/burn/force_transfer
    // Domain-specific (start at 100)
    BurnExceedsPrincipal = 100,
    RateExceedsMax = 101,
    BatchTooLargeError = 102,
    BurnExceedsSupply = 103,
    NoTrustline = 104, // SAC destination has no trustline or trustline is not authorized
    UnknownSourceError = 105, // block/unblock called with a source that has no registered blocker
}
