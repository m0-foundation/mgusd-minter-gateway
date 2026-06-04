use soroban_sdk::{contracttype, Address};

// TTL Constants
pub const DAY_IN_LEDGERS: u32 = 17280;
pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

#[derive(Clone)]
#[contracttype]
pub struct YieldStateValue {
    pub rate_bps: u32,              // Current rate in basis points (10000 = 100%)
    pub latest_index: i128,         // Last stored index (1.0 = 1e12)
    pub last_update_timestamp: u64, // Unix timestamp of last index update
    pub total_principal: i128,      // Yield-earning base (mints - burns, excludes claimed yield)
    pub total_supply: i128, // Total outstanding tokens (principal + cumulative claimed yield)
}

impl Default for YieldStateValue {
    fn default() -> Self {
        Self {
            rate_bps: 0,
            latest_index: crate::constants::INDEX_SCALE, // 1.0 scaled by 1e12
            last_update_timestamp: 0,
            total_principal: 0,
            total_supply: 0,
        }
    }
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    // Core state
    Admin,      // Instance: Address (top-level authority)
    YieldState, // Instance: YieldStateValue
    SacToken,   // Instance: Address (the SAC token contract)

    // Role addresses
    Minter,                // Instance: Address (can mint/burn tokens and set rate)
    YieldRecipientManager, // Instance: Address (can set yield recipient)
    YieldRecipient,        // Instance: Address (can claim yield)
    ForcedTransferManager, // Instance: Address (can authorize + transfer tokens)
    /// Instance: () — membership set; presence allows `block_user` / `batch_block_users`
    BlockOperator(Address),
    /// Instance: () — membership set; presence allows `unblock_user` / `batch_unblock_users`
    UnblockOperator(Address),
    /// Instance: () — membership set; presence allows `pause` / `unpause`
    Pauser(Address),
    /// Instance: () — membership set; presence allows `onboard_user`
    Onboarder(Address),
    /// Instance: () — compliance block list; presence means this account is currently held back by compliance
    BlockListed(Address),
    /// Instance: () — monotonic onboarding record; set on first `onboard_user`, never cleared.
    /// `unblock_user` only restores SAC authorization when this key is present.
    Onboarded(Address),
}
