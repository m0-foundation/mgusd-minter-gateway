use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol};

// Event topic symbols
const SET_ADMIN: Symbol = symbol_short!("set_admin");
const INT_RATE: Symbol = symbol_short!("int_rate");
const YIELD: Symbol = symbol_short!("yield");
const SET_MINTER: Symbol = symbol_short!("set_mntr");
const SET_YIELD_RCPT_MGR: Symbol = symbol_short!("set_yrmr");
const SET_YIELD_RCPT: Symbol = symbol_short!("set_yrcp");
const SUP_SYNC: Symbol = symbol_short!("sup_sync");
const FREEZE: Symbol = symbol_short!("freeze");
const UNFREEZE: Symbol = symbol_short!("unfreeze");
const CLAWBACK: Symbol = symbol_short!("clawback");
const SET_FTM: Symbol = symbol_short!("set_ftmr");
const AUTH_XFR: Symbol = symbol_short!("auth_xfr");
const UPGRADED: Symbol = symbol_short!("upgraded");

pub fn emit_set_admin(env: &Env, admin: Address, new_admin: Address) {
    env.events().publish((SET_ADMIN,), (admin, new_admin));
}

pub fn emit_interest_rate_set(env: &Env, rate_bps: u32) {
    env.events().publish((INT_RATE,), rate_bps);
}

pub fn emit_yield_claimed(env: &Env, recipient: Address, amount: i128) {
    env.events().publish((YIELD,), (recipient, amount));
}

pub fn emit_minter_set(env: &Env, old: Address, new: Address) {
    env.events().publish((SET_MINTER,), (old, new));
}

pub fn emit_yield_recipient_manager_set(env: &Env, old: Address, new: Address) {
    env.events().publish((SET_YIELD_RCPT_MGR,), (old, new));
}

pub fn emit_yield_recipient_set(env: &Env, old: Address, new: Address) {
    env.events().publish((SET_YIELD_RCPT,), (old, new));
}

pub fn emit_supply_synced(env: &Env, delta: i128, new_total_principal: i128, new_total_supply: i128) {
    env.events()
        .publish((SUP_SYNC,), (delta, new_total_principal, new_total_supply));
}

pub fn emit_account_frozen(env: &Env, account: Address) {
    env.events().publish((FREEZE,), account);
}

pub fn emit_account_unfrozen(env: &Env, account: Address) {
    env.events().publish((UNFREEZE,), account);
}

pub fn emit_clawback(env: &Env, from: Address, amount: i128) {
    env.events().publish((CLAWBACK,), (from, amount));
}

pub fn emit_forced_transfer_manager_set(env: &Env, old: Address, new: Address) {
    env.events().publish((SET_FTM,), (old, new));
}

pub fn emit_authorize_and_transfer(env: &Env, from: Address, to: Address, amount: i128) {
    env.events().publish((AUTH_XFR,), (from, to, amount));
}

pub fn emit_upgraded(env: &Env, by: Address, new_wasm_hash: BytesN<32>) {
    env.events().publish((UPGRADED,), (by, new_wasm_hash));
}
