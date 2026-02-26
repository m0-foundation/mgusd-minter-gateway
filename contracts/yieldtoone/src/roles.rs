use soroban_sdk::{Address, Env};

use crate::admin::read_admin;
use crate::errors::YieldTokenError;
use crate::storage_types::DataKey;

/// Verifies that `caller` has authorized this invocation and is either
/// the admin or the specified role holder.
pub fn require_admin_or(
    env: &Env,
    caller: &Address,
    role_holder: &Address,
) -> Result<(), YieldTokenError> {
    caller.require_auth();
    let admin = read_admin(env);
    if *caller != admin && *caller != *role_holder {
        return Err(YieldTokenError::UnauthorizedError);
    }
    Ok(())
}

// =============================================================================
// Minter - Can mint/burn tokens and set rate
// =============================================================================

pub fn read_minter(env: &Env) -> Address {
    let key = DataKey::Minter;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_minter(env: &Env, addr: &Address) {
    let key = DataKey::Minter;
    env.storage().instance().set(&key, addr);
}

// =============================================================================
// Yield Recipient Manager - Can set the yield recipient address
// =============================================================================

pub fn read_yield_recipient_manager(env: &Env) -> Address {
    let key = DataKey::YieldRecipientManager;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_yield_recipient_manager(env: &Env, addr: &Address) {
    let key = DataKey::YieldRecipientManager;
    env.storage().instance().set(&key, addr);
}

// =============================================================================
// Yield Recipient - Can claim yield (minted to this address)
// =============================================================================

pub fn read_yield_recipient(env: &Env) -> Address {
    let key = DataKey::YieldRecipient;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_yield_recipient(env: &Env, addr: &Address) {
    let key = DataKey::YieldRecipient;
    env.storage().instance().set(&key, addr);
}

// =============================================================================
// Forced Transfer Manager - Can authorize accounts and transfer tokens
// =============================================================================

pub fn read_forced_transfer_manager(env: &Env) -> Address {
    let key = DataKey::ForcedTransferManager;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_forced_transfer_manager(env: &Env, addr: &Address) {
    let key = DataKey::ForcedTransferManager;
    env.storage().instance().set(&key, addr);
}

