use soroban_sdk::{Address, Env};

use crate::storage_types::{DataKey, PERSISTENT_BUMP_AMOUNT, PERSISTENT_LIFETIME_THRESHOLD};

// =============================================================================
// Block list — contract-level compliance hold set, separate from SAC auth.
// =============================================================================

pub fn is_on_block_list(env: &Env, addr: &Address) -> bool {
    let key = DataKey::BlockListed(addr.clone());
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

pub fn add_to_block_list(env: &Env, addr: &Address) {
    let key = DataKey::BlockListed(addr.clone());
    env.storage().persistent().set(&key, &());
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

pub fn remove_from_block_list(env: &Env, addr: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::BlockListed(addr.clone()));
}

// =============================================================================
// Onboarded set — monotonic. Written once by onboard_user, never cleared.
// unblock_user gates SAC set_authorized(true) behind this flag so that
// the unblock-operator cannot manufacture an activated state for accounts
// that were never explicitly approved by an onboarder.
// =============================================================================

pub fn is_onboarded(env: &Env, addr: &Address) -> bool {
    let key = DataKey::Onboarded(addr.clone());
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

pub fn insert_onboarded(env: &Env, addr: &Address) {
    let key = DataKey::Onboarded(addr.clone());
    env.storage().persistent().set(&key, &());
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}
