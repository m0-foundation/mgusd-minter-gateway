#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

#[contracttype]
pub enum DataKey {
    Admin,
    SacToken,
}

#[contract]
pub struct SacAdminContract;

#[contractimpl]
impl SacAdminContract {
    pub fn __constructor(env: Env, sac_token: Address, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SacToken, &sac_token);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if amount < 0 {
            panic!("amount must be non-negative");
        }

        let sac_addr: Address = env.storage().instance().get(&DataKey::SacToken).unwrap();
        let sac = token::StellarAssetClient::new(&env, &sac_addr);
        sac.mint(&to, &amount);

        env.storage().instance().extend_ttl(50, 100);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();

        if amount < 0 {
            panic!("amount must be non-negative");
        }

        let sac_addr: Address = env.storage().instance().get(&DataKey::SacToken).unwrap();
        let sac = token::StellarAssetClient::new(&env, &sac_addr);
        sac.clawback(&from, &amount);

        env.storage().instance().extend_ttl(50, 100);
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn sac_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::SacToken).unwrap()
    }
}

mod test;
