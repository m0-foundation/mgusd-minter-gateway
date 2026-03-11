use soroban_sdk::{Address, Env};

use crate::storage_types::DataKey;

pub fn has_admin(env: &Env) -> bool {
    let key = DataKey::Admin;
    env.storage().instance().has(&key)
}

pub fn read_admin(env: &Env) -> Address {
    let key = DataKey::Admin;
    env.storage().instance().get(&key).unwrap()
}

pub fn write_admin(env: &Env, admin: &Address) {
    let key = DataKey::Admin;
    env.storage().instance().set(&key, admin);
}

pub fn require_admin(env: &Env) -> Address {
    let admin = read_admin(env);
    admin.require_auth();
    admin
}
