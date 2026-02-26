use soroban_sdk::{Address, Env};

use crate::storage_types::DataKey;

pub fn read_sac_token(env: &Env) -> Address {
    let key = DataKey::SacToken;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_sac_token(env: &Env, addr: &Address) {
    let key = DataKey::SacToken;
    env.storage().instance().set(&key, addr);
}
