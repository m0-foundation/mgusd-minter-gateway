use soroban_sdk::{Address, Env};

use crate::errors::YieldTokenError;
use crate::storage_types::DataKey;

/// Verifies that `caller` has authorized this invocation and is the specified role holder.
pub fn require_role_holder(caller: &Address, role_holder: &Address) -> Result<(), YieldTokenError> {
    caller.require_auth();
    if *caller != *role_holder {
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

// =============================================================================
// Blocker - Can block/unblock accounts (individually or in batches).
// Stored as a membership set: one instance-storage entry per blocker address.
// =============================================================================

pub fn is_blocker(env: &Env, addr: &Address) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::Blocker(addr.clone()))
}

/// Returns true if this call added a new blocker (false if already present).
pub fn insert_blocker(env: &Env, addr: &Address) -> bool {
    let key = DataKey::Blocker(addr.clone());
    if env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().set(&key, &());
    true
}

/// Returns true if this call removed an existing blocker (false if not present).
pub fn delete_blocker(env: &Env, addr: &Address) -> bool {
    let key = DataKey::Blocker(addr.clone());
    if !env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().remove(&key);
    true
}

pub fn require_blocker(env: &Env, caller: &Address) -> Result<(), YieldTokenError> {
    caller.require_auth();
    if !is_blocker(env, caller) {
        return Err(YieldTokenError::UnauthorizedError);
    }
    Ok(())
}

// =============================================================================
// Pauser - Can pause/unpause the contract
// =============================================================================

pub fn read_pauser(env: &Env) -> Address {
    let key = DataKey::Pauser;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_pauser(env: &Env, addr: &Address) {
    let key = DataKey::Pauser;
    env.storage().instance().set(&key, addr);
}
