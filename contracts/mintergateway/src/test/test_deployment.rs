use soroban_sdk::testutils::storage::Instance as _;
use soroban_sdk::testutils::Address as _;

use super::setup::*;
use crate::storage_types::INSTANCE_LIFETIME_THRESHOLD;
use crate::yield_state::read_yield_state;

// =============================================================================
// INITIALIZATION TESTS
// =============================================================================

#[test]
fn test_double_initialization_returns_error() {
    let s = setup();

    let sac_addr = s.sac_token.address.clone();
    let admin = s.admin.clone();
    let minter = s.minter.clone();
    let yrm = s.yield_recipient_manager.clone();
    let yr = s.yield_recipient.clone();
    let ftm = s.forced_transfer_manager.clone();
    let pauser = s.pauser.clone();

    // Re-invoke __constructor inside the contract's storage context
    // The admin already exists, so this should return AlreadyInitializedError
    let result = s.env.as_contract(&s.contract.address, || {
        YieldToken::__constructor(s.env.clone(), sac_addr, admin, minter, yrm, yr, ftm, pauser)
    });

    assert_eq!(
        result,
        Err(crate::MinterGatewayError::AlreadyInitializedError)
    );
}

// FIND-002: Constructor must bump instance TTL so storage doesn't sit at the
// network minimum (~hours) between deploy and the first state-changing call.
// Every other state-changing entrypoint calls `extend_instance_ttl`; the
// constructor should match.
//
// This test isolates the constructor — it deploys via `env.register(...)` but
// does NOT invoke any other entrypoint, so the TTL we observe is exactly what
// the constructor leaves behind.
#[test]
fn test_constructor_extends_instance_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);

    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let yield_recipient_manager = Address::generate(&env);
    let yield_recipient = Address::generate(&env);
    let forced_transfer_manager = Address::generate(&env);
    let pauser = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_addr = sac.address();

    let contract_addr = env.register(
        YieldToken,
        (
            &sac_addr,
            &admin,
            &minter,
            &yield_recipient_manager,
            &yield_recipient,
            &forced_transfer_manager,
            &pauser,
        ),
    );

    let ttl = env.as_contract(&contract_addr, || env.storage().instance().get_ttl());

    assert!(
        ttl >= INSTANCE_LIFETIME_THRESHOLD,
        "instance TTL after constructor = {} ledgers, expected >= {} \
         (constructor should call extend_instance_ttl like every other entrypoint)",
        ttl,
        INSTANCE_LIFETIME_THRESHOLD,
    );
}

#[test]
fn test_yield_state_defaults_to_zero_on_fresh_contract() {
    let s = setup();

    let state = s
        .env
        .as_contract(&s.contract.address, || read_yield_state(&s.env));

    assert_eq!(state.total_principal, 0);
    assert_eq!(state.total_supply, 0);
    assert_eq!(state.rate_bps, 0);
    assert_eq!(state.latest_index, INDEX_SCALE);
    assert_eq!(state.last_update_timestamp, 0);
}

// =============================================================================
// UPGRADE TESTS
// =============================================================================

#[test]
#[should_panic]
fn test_upgrade_requires_admin_auth() {
    // Setup WITHOUT mock_all_auths — admin.require_auth() will fail
    let env = Env::default();
    env.ledger().set_timestamp(T0);

    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let yield_recipient_manager = Address::generate(&env);
    let yield_recipient = Address::generate(&env);
    let forced_transfer_manager = Address::generate(&env);
    let pauser = Address::generate(&env);

    // Register SAC — env.register* helpers don't need auth
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_addr = sac.address();

    let contract_addr = env.register(
        YieldToken,
        (
            &sac_addr,
            &admin,
            &minter,
            &yield_recipient_manager,
            &yield_recipient,
            &forced_transfer_manager,
            &pauser,
        ),
    );
    let contract = YieldTokenClient::new(&env, &contract_addr);

    // Call upgrade without any auth — should panic at require_admin
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    contract.upgrade(&hash);
}

#[test]
fn test_upgrade_fails_with_invalid_wasm_hash() {
    let s = setup();
    let hash = BytesN::from_array(&s.env, &[1u8; 32]);

    // With mock_all_auths, admin auth passes. The call should fail at
    // update_current_contract_wasm because the hash doesn't correspond
    // to any uploaded WASM — proving auth was satisfied (not an auth error).
    let result = s.contract.try_upgrade(&hash);
    assert!(
        result.is_err(),
        "upgrade with non-existent WASM hash should fail"
    );
}
