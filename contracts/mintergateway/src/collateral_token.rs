use soroban_sdk::{Address, Env};

use crate::storage_types::DataKey;

pub fn has_collateral_token(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::CollateralToken)
}

pub fn read_collateral_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::CollateralToken).unwrap()
}

pub fn write_collateral_token(env: &Env, addr: &Address) {
    env.storage().instance().set(&DataKey::CollateralToken, addr);
}
