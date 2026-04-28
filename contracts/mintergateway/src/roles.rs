use soroban_sdk::{Address, Env};

use crate::errors::MinterGatewayError;
use crate::storage_types::DataKey;

/// Verifies that `caller` has authorized this invocation and is the specified role holder.
pub fn require_role_holder(
    caller: &Address,
    role_holder: &Address,
) -> Result<(), MinterGatewayError> {
    caller.require_auth();
    if *caller != *role_holder {
        return Err(MinterGatewayError::UnauthorizedError);
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
// Block / Unblock operators — separate membership sets. Block operators can
// block accounts; unblock operators can unblock. Either role may be held alone
// or both by the same address.
// =============================================================================

pub fn is_block_operator(env: &Env, addr: &Address) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::BlockOperator(addr.clone()))
}

/// Returns true if this call added a new block operator (false if already present).
pub fn insert_block_operator(env: &Env, addr: &Address) -> bool {
    let key = DataKey::BlockOperator(addr.clone());
    if env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().set(&key, &());
    true
}

/// Returns true if this call removed an existing block operator (false if not present).
pub fn delete_block_operator(env: &Env, addr: &Address) -> bool {
    let key = DataKey::BlockOperator(addr.clone());
    if !env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().remove(&key);
    true
}

pub fn require_block_operator(env: &Env, caller: &Address) -> Result<(), MinterGatewayError> {
    caller.require_auth();
    if !is_block_operator(env, caller) {
        return Err(MinterGatewayError::UnauthorizedError);
    }
    Ok(())
}

pub fn is_unblock_operator(env: &Env, addr: &Address) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::UnblockOperator(addr.clone()))
}

/// Returns true if this call added a new unblock operator (false if already present).
pub fn insert_unblock_operator(env: &Env, addr: &Address) -> bool {
    let key = DataKey::UnblockOperator(addr.clone());
    if env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().set(&key, &());
    true
}

/// Returns true if this call removed an existing unblock operator (false if not present).
pub fn delete_unblock_operator(env: &Env, addr: &Address) -> bool {
    let key = DataKey::UnblockOperator(addr.clone());
    if !env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().remove(&key);
    true
}

pub fn require_unblock_operator(env: &Env, caller: &Address) -> Result<(), MinterGatewayError> {
    caller.require_auth();
    if !is_unblock_operator(env, caller) {
        return Err(MinterGatewayError::UnauthorizedError);
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
