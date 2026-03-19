use soroban_sdk::{Address, Env};

use crate::storage_types::DataKey;

pub fn has_collateral_token(env: &Env) -> bool {
    let key = DataKey::CollateralToken;
    env.storage().instance().has(&key)
}

pub fn read_collateral_token(env: &Env) -> Address {
    let key = DataKey::CollateralToken;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_collateral_token(env: &Env, addr: &Address) {
    let key = DataKey::CollateralToken;
    env.storage().instance().set(&key, addr);
}
