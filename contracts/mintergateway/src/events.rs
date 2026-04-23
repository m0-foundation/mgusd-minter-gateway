use soroban_sdk::{contractevent, Address, BytesN, Env};

#[contractevent]
pub struct AdminSet {
    #[topic]
    pub old: Address,
    pub new: Address,
}

pub fn emit_set_admin(env: &Env, old: Address, new: Address) {
    AdminSet { old, new }.publish(env);
}

#[contractevent]
pub struct InterestRateSet {
    pub rate_bps: u32,
}

pub fn emit_interest_rate_set(env: &Env, rate_bps: u32) {
    InterestRateSet { rate_bps }.publish(env);
}

#[contractevent]
pub struct YieldClaimed {
    pub recipient: Address,
    pub amount: i128,
}

pub fn emit_yield_claimed(env: &Env, recipient: Address, amount: i128) {
    YieldClaimed { recipient, amount }.publish(env);
}

#[contractevent]
pub struct MinterSet {
    #[topic]
    pub old: Address,
    pub new: Address,
}

pub fn emit_minter_set(env: &Env, old: Address, new: Address) {
    MinterSet { old, new }.publish(env);
}

#[contractevent]
pub struct YieldRecipientManagerSet {
    #[topic]
    pub old: Address,
    pub new: Address,
}

pub fn emit_yield_recipient_manager_set(env: &Env, old: Address, new: Address) {
    YieldRecipientManagerSet { old, new }.publish(env);
}

#[contractevent]
pub struct YieldRecipientSet {
    #[topic]
    pub old: Address,
    pub new: Address,
}

pub fn emit_yield_recipient_set(env: &Env, old: Address, new: Address) {
    YieldRecipientSet { old, new }.publish(env);
}

#[contractevent]
pub struct SupplySynced {
    pub delta: i128,
    pub new_total_principal: i128,
    pub new_total_supply: i128,
}

pub fn emit_supply_synced(
    env: &Env,
    delta: i128,
    new_total_principal: i128,
    new_total_supply: i128,
) {
    SupplySynced {
        delta,
        new_total_principal,
        new_total_supply,
    }
    .publish(env);
}

#[contractevent]
pub struct ForcedTransferManagerSet {
    #[topic]
    pub old: Address,
    pub new: Address,
}

pub fn emit_forced_transfer_manager_set(env: &Env, old: Address, new: Address) {
    ForcedTransferManagerSet { old, new }.publish(env);
}

#[contractevent]
pub struct BlockerAdded {
    #[topic]
    pub addr: Address,
}

pub fn emit_blocker_added(env: &Env, addr: Address) {
    BlockerAdded { addr }.publish(env);
}

#[contractevent]
pub struct BlockerRemoved {
    #[topic]
    pub addr: Address,
}

pub fn emit_blocker_removed(env: &Env, addr: Address) {
    BlockerRemoved { addr }.publish(env);
}

#[contractevent]
pub struct ForceTransfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

pub fn emit_force_transfer(env: &Env, from: Address, to: Address, amount: i128) {
    ForceTransfer { from, to, amount }.publish(env);
}

#[contractevent]
pub struct Upgraded {
    #[topic]
    pub by: Address,
    pub new_wasm_hash: BytesN<32>,
}

pub fn emit_upgraded(env: &Env, by: Address, new_wasm_hash: BytesN<32>) {
    Upgraded { by, new_wasm_hash }.publish(env);
}

#[contractevent]
pub struct PauserSet {
    #[topic]
    pub old: Address,
    pub new: Address,
}

pub fn emit_pauser_set(env: &Env, old: Address, new: Address) {
    PauserSet { old, new }.publish(env);
}
