use soroban_sdk::{Address, Env, Symbol, Vec};

use crate::errors::MinterGatewayError;
use crate::storage_types::{DataKey, PERSISTENT_BUMP_AMOUNT, PERSISTENT_LIFETIME_THRESHOLD};

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
// Authorized blockers — maps a source name (Symbol) to the Address authorized
// to call block_user / unblock_user for that source. Admin manages this registry
// via set_authorized_blocker / remove_authorized_blocker.
// =============================================================================

pub fn get_authorized_blocker(env: &Env, source: &Symbol) -> Option<Address> {
    env.storage()
        .instance()
        .get(&DataKey::AuthorizedBlocker(source.clone()))
}

/// Returns true if the blocker was newly set or changed (false if already identical).
pub fn set_authorized_blocker_storage(env: &Env, source: &Symbol, blocker: &Address) -> bool {
    let key = DataKey::AuthorizedBlocker(source.clone());
    if let Some(existing) = env.storage().instance().get::<_, Address>(&key) {
        if existing == *blocker {
            return false;
        }
    }
    env.storage().instance().set(&key, blocker);
    true
}

/// Returns true if the source existed and was removed.
pub fn remove_authorized_blocker_storage(env: &Env, source: &Symbol) -> bool {
    let key = DataKey::AuthorizedBlocker(source.clone());
    if !env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().remove(&key);
    true
}

/// Verifies caller is auth'd and is the registered blocker for `source`.
/// Returns UnknownSourceError if the source has no registered blocker.
/// Returns UnauthorizedError if the caller is not that blocker.
pub fn require_authorized_blocker(
    env: &Env,
    caller: &Address,
    source: &Symbol,
) -> Result<(), MinterGatewayError> {
    caller.require_auth();
    match get_authorized_blocker(env, source) {
        None => Err(MinterGatewayError::UnknownSourceError),
        Some(registered) if registered != *caller => Err(MinterGatewayError::UnauthorizedError),
        _ => Ok(()),
    }
}

// =============================================================================
// Block registry — maps each user Address to the Vec<Symbol> of active block
// sources. SAC authorization is restored only when the vec is empty.
// =============================================================================

pub fn get_block_sources(env: &Env, user: &Address) -> Vec<Symbol> {
    let key = DataKey::BlockSources(user.clone());
    let sources = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if !sources.is_empty() {
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }
    sources
}

fn set_block_sources(env: &Env, user: &Address, sources: &Vec<Symbol>) {
    let key = DataKey::BlockSources(user.clone());
    if sources.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, sources);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }
}

/// Adds `source` to the user's block set. Returns true if newly added (was not present).
pub fn add_block_source(env: &Env, user: &Address, source: &Symbol) -> bool {
    let mut sources = get_block_sources(env, user);
    if sources.contains(source) {
        return false;
    }
    sources.push_back(source.clone());
    set_block_sources(env, user, &sources);
    true
}

/// Removes `source` from the user's block set. Returns true if it was present and removed.
pub fn remove_block_source(env: &Env, user: &Address, source: &Symbol) -> bool {
    let sources = get_block_sources(env, user);
    if !sources.contains(source) {
        return false;
    }
    let mut new_sources = Vec::new(env);
    for s in sources.iter() {
        if s != *source {
            new_sources.push_back(s);
        }
    }
    set_block_sources(env, user, &new_sources);
    true
}

/// Returns true if the user has any active block sources (SAC remains unauthorized).
pub fn has_any_block(env: &Env, user: &Address) -> bool {
    let key = DataKey::BlockSources(user.clone());
    if env.storage().persistent().has(&key) {
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        true
    } else {
        false
    }
}

// =============================================================================
// Pauser - Membership set. Any pauser can pause/unpause the contract.
// =============================================================================

pub fn is_pauser(env: &Env, addr: &Address) -> bool {
    env.storage().instance().has(&DataKey::Pauser(addr.clone()))
}

/// Returns true if this call added a new pauser (false if already present).
pub fn insert_pauser(env: &Env, addr: &Address) -> bool {
    let key = DataKey::Pauser(addr.clone());
    if env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().set(&key, &());
    true
}

/// Returns true if this call removed an existing pauser (false if not present).
pub fn delete_pauser(env: &Env, addr: &Address) -> bool {
    let key = DataKey::Pauser(addr.clone());
    if !env.storage().instance().has(&key) {
        return false;
    }
    env.storage().instance().remove(&key);
    true
}

pub fn require_pauser(env: &Env, caller: &Address) -> Result<(), MinterGatewayError> {
    caller.require_auth();
    if !is_pauser(env, caller) {
        return Err(MinterGatewayError::UnauthorizedError);
    }
    Ok(())
}
