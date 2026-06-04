use soroban_sdk::{Address, Env};

use crate::storage_types::DataKey;

// =============================================================================
// Block list — contract-level compliance hold set, separate from SAC auth.
// =============================================================================

pub fn is_on_block_list(env: &Env, addr: &Address) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::BlockListed(addr.clone()))
}

pub fn add_to_block_list(env: &Env, addr: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::BlockListed(addr.clone()), &());
}

pub fn remove_from_block_list(env: &Env, addr: &Address) {
    env.storage()
        .instance()
        .remove(&DataKey::BlockListed(addr.clone()));
}

// =============================================================================
// Onboarded set — monotonic. Written once by onboard_user, never cleared.
// unblock_user gates SAC set_authorized(true) behind this flag so that
// the unblock-operator cannot manufacture an activated state for accounts
// that were never explicitly approved by an onboarder.
// =============================================================================

pub fn is_onboarded(env: &Env, addr: &Address) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::Onboarded(addr.clone()))
}

pub fn insert_onboarded(env: &Env, addr: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::Onboarded(addr.clone()), &());
}
