use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// FREEZE / UNFREEZE TESTS
// =============================================================================

#[test]
fn test_freeze_account_prevents_transfer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    s.contract.freeze_account(&s.admin, &user);
    assert!(!s.contract.is_authorized(&user));

    // Frozen user cannot transfer
    let result = s.sac_token.try_transfer(&user, &recipient, &100_0000000);
    assert!(result.is_err());
}

#[test]
fn test_unfreeze_account_restores_transfer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    s.contract.freeze_account(&s.admin, &user);
    assert!(!s.contract.is_authorized(&user));

    s.contract.unfreeze_account(&s.admin, &user);
    assert!(s.contract.is_authorized(&user));

    // Authorize recipient so they can receive (AUTH_REQUIRED mode)
    s.contract.unfreeze_account(&s.admin, &recipient);

    // Unfrozen user can transfer again
    s.sac_token.transfer(&user, &recipient, &100_0000000);
    assert_eq!(s.sac_token.balance(&recipient), 100_0000000);
}

#[test]
fn test_is_authorized_default_false() {
    let s = setup();
    let user = Address::generate(&s.env);

    // New accounts are unauthorized by default with AUTH_REQUIRED
    assert!(!s.contract.is_authorized(&user));
}

#[test]
fn test_freeze_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    // Freezing twice doesn't panic
    s.contract.freeze_account(&s.admin, &user);
    s.contract.freeze_account(&s.admin, &user);
    assert!(!s.contract.is_authorized(&user));
}

#[test]
fn test_unfreeze_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Authorize the account first
    s.contract.unfreeze_account(&s.admin, &user);
    assert!(s.contract.is_authorized(&user));

    // Unfreezing an already-authorized account doesn't panic
    s.contract.unfreeze_account(&s.admin, &user);
    assert!(s.contract.is_authorized(&user));
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_freeze_account_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let user = Address::generate(&s.env);
    let result = s.contract.try_freeze_account(&s.admin, &user);
    assert_eq!(result.unwrap_err().unwrap_err(), soroban_sdk::InvokeError::Abort);
}

#[test]
fn test_unfreeze_account_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let user = Address::generate(&s.env);
    let result = s.contract.try_unfreeze_account(&s.admin, &user);
    assert_eq!(result.unwrap_err().unwrap_err(), soroban_sdk::InvokeError::Abort);
}

#[test]
fn test_freeze_account_rejects_unauthorized_role() {
    let s = setup();
    let user = Address::generate(&s.env);
    let random = Address::generate(&s.env);
    let result = s.contract.try_freeze_account(&random, &user);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_unfreeze_account_rejects_unauthorized_role() {
    let s = setup();
    let user = Address::generate(&s.env);
    let random = Address::generate(&s.env);
    let result = s.contract.try_unfreeze_account(&random, &user);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_distributor_can_freeze_account() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    assert!(s.contract.is_authorized(&user));

    s.contract.freeze_account(&s.distributor, &user);
    assert!(!s.contract.is_authorized(&user));
}

#[test]
fn test_distributor_can_unfreeze_account() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.distributor, &user);
    assert!(s.contract.is_authorized(&user));
}

// =============================================================================
// COMPLIANCE INTEGRATION TEST
// =============================================================================

#[test]
fn test_compliance_flow_freeze_burn_unfreeze() {
    let s = setup();
    let user = Address::generate(&s.env);
    let principal = 1_000_0000000i128;

    // Step 1: Mint tokens
    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &user, &principal);
    assert_eq!(s.sac_token.balance(&user), principal);
    assert!(s.contract.is_authorized(&user));

    // Step 2: Freeze the account
    s.contract.freeze_account(&s.admin, &user);
    assert!(!s.contract.is_authorized(&user));

    // Step 3: Burn half
    s.contract.burn(&s.minter, &user, &(principal / 2));
    assert_eq!(s.sac_token.balance(&user), principal / 2);
    assert_eq!(s.contract.total_principal(), principal / 2);
    assert_eq!(s.contract.total_supply(), principal / 2);

    // Step 4: Unfreeze the account
    s.contract.unfreeze_account(&s.admin, &user);
    assert!(s.contract.is_authorized(&user));

    // Step 5: User can transfer remaining balance
    let recipient = Address::generate(&s.env);
    s.contract.unfreeze_account(&s.admin, &recipient); // Authorize recipient (AUTH_REQUIRED mode)
    s.sac_token.transfer(&user, &recipient, &100_0000000);
    assert_eq!(s.sac_token.balance(&recipient), 100_0000000);
}

#[test]
fn test_freeze_blocks_subsequent_direct_sac_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    // Authorize both and mint
    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &alice, &amount);

    // Direct SAC transfer works while both are authorized
    s.sac_token.transfer(&alice, &bob, &100_0000000);
    assert_eq!(s.sac_token.balance(&bob), 100_0000000);

    // Admin freezes alice via our contract
    s.contract.freeze_account(&s.admin, &alice);

    // Alice tries another direct SAC transfer — BLOCKED
    let result = s.sac_token.try_transfer(&alice, &bob, &100_0000000);
    assert!(result.is_err());

    // Alice's remaining balance is locked
    assert_eq!(s.sac_token.balance(&alice), amount - 100_0000000);
}

