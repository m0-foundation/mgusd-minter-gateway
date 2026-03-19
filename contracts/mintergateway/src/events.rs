use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol};

// Event topic symbols
const SET_ADMIN: Symbol = symbol_short!("set_admin");
const INT_RATE: Symbol = symbol_short!("int_rate");
const YLD_CLAIM: Symbol = symbol_short!("yld_clm");
const SET_MINTER: Symbol = symbol_short!("set_mntr");
const SET_YIELD_RCPT_MGR: Symbol = symbol_short!("set_yrmr");
const SET_YIELD_RCPT: Symbol = symbol_short!("set_yrcp");
const SUP_CHG: Symbol = symbol_short!("sup_chg");
const FREEZE: Symbol = symbol_short!("freeze");
const UNFREEZE: Symbol = symbol_short!("unfreeze");
const SET_FTM: Symbol = symbol_short!("set_ftmr");
const SET_DIST: Symbol = symbol_short!("set_dist");
const FORCE_TX: Symbol = symbol_short!("force_tx");
const UPGRADED: Symbol = symbol_short!("upgraded");
const SET_COL: Symbol = symbol_short!("set_col");
const COL_UNLK: Symbol = symbol_short!("col_unlk");

pub fn emit_set_admin(env: &Env, admin: Address, new_admin: Address) {
    env.events().publish((SET_ADMIN,), (admin, new_admin));
}

pub fn emit_interest_rate_set(env: &Env, rate_bps: u32) {
    env.events().publish((INT_RATE,), rate_bps);
}

pub fn emit_yield_claimed(env: &Env, recipient: Address, amount: i128) {
    env.events().publish((YLD_CLAIM,), (recipient, amount));
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
        .publish((SUP_CHG,), (delta, new_total_principal, new_total_supply));
}

pub fn emit_account_frozen(env: &Env, account: Address) {
    env.events().publish((FREEZE,), account);
}

pub fn emit_account_unfrozen(env: &Env, account: Address) {
    env.events().publish((UNFREEZE,), account);
}

pub fn emit_forced_transfer_manager_set(env: &Env, old: Address, new: Address) {
    env.events().publish((SET_FTM,), (old, new));
}

pub fn emit_distributor_set(env: &Env, old: Address, new: Address) {
    env.events().publish((SET_DIST,), (old, new));
}

pub fn emit_force_transfer(env: &Env, from: Address, to: Address, amount: i128) {
    env.events().publish((FORCE_TX,), (from, to, amount));
}

pub fn emit_upgraded(env: &Env, by: Address, new_wasm_hash: BytesN<32>) {
    env.events().publish((UPGRADED,), (by, new_wasm_hash));
}

pub fn emit_collateral_token_set(env: &Env, old: Option<Address>, new: Address) {
    env.events().publish((SET_COL,), (old, new));
}

pub fn emit_collateral_unlocked(env: &Env, to: Address, amount: i128) {
    env.events().publish((COL_UNLK,), (to, amount));
}
