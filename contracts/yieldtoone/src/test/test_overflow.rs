//! WASM-mode overflow test.
//!
//! This test registers the contract from its compiled WASM binary (not native
//! Rust) so that `overflow-checks = true` in `[profile.release]` is active.
//! Native `cargo test` builds use the `test` profile which does NOT enable
//! overflow checks, so only the WASM path catches arithmetic overflows.
//!
//! Prerequisite: run `stellar contract build` before `cargo test` so the WASM
//! binary exists at `target/wasm32v1-none/release/yieldtoone.wasm`.

use soroban_sdk::{
    testutils::{Address as _, IssuerFlags, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

use crate::contract::YieldTokenClient;

// Include the compiled WASM binary directly.
const WASM: &[u8] =
    include_bytes!("../../../../target/wasm32v1-none/release/yieldtoone.wasm");

const T0: u64 = 1_000_000;

#[test]
#[should_panic(expected = "Error(WasmVm, InvalidAction)")]
fn test_wasm_overflow_panics_on_mint() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);

    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let yield_recipient_manager = Address::generate(&env);
    let yield_recipient = Address::generate(&env);
    let forced_transfer_manager = Address::generate(&env);

    // Register SAC with issuer flags required for the yield contract.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer_handle = sac.issuer();
    issuer_handle.set_flag(IssuerFlags::RequiredFlag);
    issuer_handle.set_flag(IssuerFlags::RevocableFlag);
    issuer_handle.set_flag(IssuerFlags::ClawbackEnabledFlag);
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);

    // Register from WASM binary so overflow-checks are active.
    let contract_addr = env.register(
        WASM,
        (
            &sac_addr,
            &admin,
            &minter,
            &yield_recipient_manager,
            &yield_recipient,
            &forced_transfer_manager,
        ),
    );
    let contract = YieldTokenClient::new(&env, &contract_addr);
    sac_admin_client.set_admin(&contract_addr);
    contract.unfreeze_account(&yield_recipient);

    // Mint i128::MAX — succeeds.
    contract.mint(&minter, &yield_recipient, &i128::MAX);
    // Mint 1 more — triggers checked_add overflow and panics in WASM.
    contract.mint(&minter, &yield_recipient, &1);
}
