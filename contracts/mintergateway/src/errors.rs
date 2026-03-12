use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum YieldTokenError {
    // Common (match Soroban built-in ranges)
    InternalError = 1,
    AlreadyInitializedError = 3,
    UnauthorizedError = 4,
    NegativeAmountError = 8,
    // Domain-specific (start at 100)
    BurnExceedsPrincipal = 100,
    RateExceedsMax = 101,
    BatchTooLargeError = 102,
}
