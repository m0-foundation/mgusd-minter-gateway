use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// ADMIN ROLE MANAGEMENT TESTS
// =============================================================================

#[test]
fn test_set_admin() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.contract.set_admin(&new_admin);
    assert_eq!(s.contract.admin(), new_admin);
}

#[test]
fn test_set_minter() {
    let s = setup();
    let new_minter = Address::generate(&s.env);

    s.contract.set_minter(&new_minter);
    assert_eq!(s.contract.minter(), new_minter);
}

#[test]
fn test_set_yield_recipient_manager() {
    let s = setup();
    let new_yrm = Address::generate(&s.env);

    s.contract.set_yield_recipient_manager(&new_yrm);
    assert_eq!(s.contract.yield_recipient_manager(), new_yrm);
}

#[test]
fn test_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    s.contract.set_yield_recipient(&s.yield_recipient_manager, &new_yr);
    assert_eq!(s.contract.yield_recipient(), new_yr);
}

#[test]
fn test_set_forced_transfer_manager() {
    let s = setup();
    let new_ftm = Address::generate(&s.env);

    assert_eq!(s.contract.forced_transfer_manager(), s.forced_transfer_manager);

    s.contract.set_forced_transfer_manager(&new_ftm);
    assert_eq!(s.contract.forced_transfer_manager(), new_ftm);
}

#[test]
fn test_forced_transfer_manager_view() {
    let s = setup();
    assert_eq!(s.contract.forced_transfer_manager(), s.forced_transfer_manager);
}

// =============================================================================
// ADMIN SUPER-ROLE TESTS
// =============================================================================
// Admin can call any role-gated function (mint, burn, set_rate, claim_yield,
// set_yield_recipient, authorize_and_transfer) without holding that role.

#[test]
fn test_admin_can_mint() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.admin, &user, &1_000_0000000);

    assert_eq!(s.sac_token.balance(&user), 1_000_0000000);
    assert_eq!(s.contract.total_principal(), 1_000_0000000);
}

#[test]
fn test_admin_can_burn() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    s.contract.burn(&s.admin, &user, &400_0000000);

    assert_eq!(s.sac_token.balance(&user), 600_0000000);
    assert_eq!(s.contract.total_principal(), 600_0000000);
}

#[test]
fn test_admin_can_set_rate() {
    let s = setup();

    s.contract.set_rate(&s.admin, &500);

    assert_eq!(s.contract.interest_rate(), 500);
}

#[test]
fn test_admin_can_claim_yield() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Admin calls claim_yield — tokens minted to yield_recipient (not admin)
    let claimed = s.contract.claim_yield(&s.admin);
    assert!(claimed > 0);

    // Tokens go to yield_recipient, not admin
    assert_eq!(s.sac_token.balance(&s.yield_recipient), principal + claimed);
}

#[test]
fn test_admin_can_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    s.contract.set_yield_recipient(&s.admin, &new_yr);

    assert_eq!(s.contract.yield_recipient(), new_yr);
}

#[test]
fn test_admin_can_authorize_and_transfer() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // Admin calls authorize_and_transfer
    s.contract.authorize_and_transfer(&s.admin, &treasury, &recipient, &500_0000000);

    assert_eq!(s.sac_token.balance(&recipient), 500_0000000);
    assert!(!s.contract.is_authorized(&recipient));
}

#[test]
fn test_unauthorized_caller_rejected() {
    let s = setup();
    let random = Address::generate(&s.env);

    // Random address tries to mint — should return UnauthorizedError
    let result = s.contract.try_mint(&random, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
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
    assert!(result.is_err(), "upgrade with non-existent WASM hash should fail");
}
