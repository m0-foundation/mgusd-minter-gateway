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

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    s.contract.freeze_account(&user);
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

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    s.contract.freeze_account(&user);
    assert!(!s.contract.is_authorized(&user));

    s.contract.unfreeze_account(&user);
    assert!(s.contract.is_authorized(&user));

    // Authorize recipient so they can receive (AUTH_REQUIRED mode)
    s.contract.unfreeze_account(&recipient);

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

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    // Freezing twice doesn't panic
    s.contract.freeze_account(&user);
    s.contract.freeze_account(&user);
    assert!(!s.contract.is_authorized(&user));
}

#[test]
fn test_unfreeze_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Authorize the account first
    s.contract.unfreeze_account(&user);
    assert!(s.contract.is_authorized(&user));

    // Unfreezing an already-authorized account doesn't panic
    s.contract.unfreeze_account(&user);
    assert!(s.contract.is_authorized(&user));
}

// =============================================================================
// CLAWBACK TESTS
// =============================================================================

#[test]
fn test_clawback_removes_tokens_and_updates_accumulators() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    s.contract.clawback(&user, &400_0000000);

    assert_eq!(s.contract.total_principal(), 600_0000000);
    assert_eq!(s.contract.total_supply(), 600_0000000);
    assert_eq!(s.sac_token.balance(&user), 600_0000000);
}

#[test]
fn test_clawback_full_balance() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    s.contract.clawback(&user, &1_000_0000000);

    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);
    assert_eq!(s.sac_token.balance(&user), 0);
}

#[test]
fn test_clawback_exceeding_principal_reverts() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    // Clawback more than principal should fail
    let result = s.contract.try_clawback(&user, &1_001_0000000);
    assert!(result.is_err());
}

#[test]
fn test_clawback_finalizes_yield_before_decreasing() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_000_0000000);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_before = s.contract.accrued_yield();
    assert!(yield_before > 0);

    // Clawback should finalize yield first, then decrease principal
    s.contract.clawback(&user, &500_000_0000000);

    // Yield is preserved (accrued before the clawback)
    assert!(s.contract.accrued_yield() >= yield_before);
    assert_eq!(s.contract.total_principal(), 500_000_0000000);
}

#[test]
fn test_clawback_from_frozen_account() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    // Freeze then clawback
    s.contract.freeze_account(&user);
    s.contract.clawback(&user, &500_0000000);

    assert_eq!(s.contract.total_principal(), 500_0000000);
    assert_eq!(s.sac_token.balance(&user), 500_0000000);
    assert!(!s.contract.is_authorized(&user));
}

#[test]
fn test_clawback_then_yield_accrues_on_reduced_principal() {
    let s = setup();
    let user = Address::generate(&s.env);
    let principal = 1_000_000_0000000i128;

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Claim yield first to get a clean baseline
    let first_year_yield = s.contract.claim_yield(&s.yield_recipient);
    assert!(first_year_yield > 0);

    // Clawback half the principal
    s.contract.clawback(&user, &(principal / 2));
    assert_eq!(s.contract.total_principal(), principal / 2);

    // Advance another year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let second_year_yield = s.contract.accrued_yield();
    // Yield on half principal should be roughly half
    let ratio = (second_year_yield as f64) / (first_year_yield as f64);
    assert!(
        ratio > 0.45 && ratio < 0.55,
        "Expected ~0.5 ratio, got {}",
        ratio
    );
}

// =============================================================================
// COMPLIANCE INTEGRATION TEST
// =============================================================================

#[test]
fn test_compliance_flow_freeze_clawback_unfreeze() {
    let s = setup();
    let user = Address::generate(&s.env);
    let principal = 1_000_0000000i128;

    // Step 1: Mint tokens
    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &principal);
    assert_eq!(s.sac_token.balance(&user), principal);
    assert!(s.contract.is_authorized(&user));

    // Step 2: Freeze the account
    s.contract.freeze_account(&user);
    assert!(!s.contract.is_authorized(&user));

    // Step 3: Clawback half
    s.contract.clawback(&user, &(principal / 2));
    assert_eq!(s.sac_token.balance(&user), principal / 2);
    assert_eq!(s.contract.total_principal(), principal / 2);
    assert_eq!(s.contract.total_supply(), principal / 2);

    // Step 4: Unfreeze the account
    s.contract.unfreeze_account(&user);
    assert!(s.contract.is_authorized(&user));

    // Step 5: User can transfer remaining balance
    let recipient = Address::generate(&s.env);
    s.contract.unfreeze_account(&recipient); // Authorize recipient (AUTH_REQUIRED mode)
    s.sac_token.transfer(&user, &recipient, &100_0000000);
    assert_eq!(s.sac_token.balance(&recipient), 100_0000000);
}

// =============================================================================
// ALLOWLIST (AUTH_REQUIRED) TESTS
// =============================================================================

#[test]
fn test_unauthorized_account_cannot_receive_mint() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Do NOT authorize — user is unauthorized by default (AUTH_REQUIRED)
    assert!(!s.contract.is_authorized(&user));

    // Minting to unauthorized account should fail
    let result = s.contract.try_mint(&s.minter, &user, &1_000_0000000);
    assert!(result.is_err());
}

#[test]
fn test_authorized_account_can_receive_mint() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Authorize via unfreeze_account (allowlist)
    s.contract.unfreeze_account(&user);
    assert!(s.contract.is_authorized(&user));

    // Minting to authorized account succeeds
    s.contract.mint(&s.minter, &user, &1_000_0000000);
    assert_eq!(s.sac_token.balance(&user), 1_000_0000000);
}

#[test]
fn test_unauthorized_recipient_cannot_receive_transfer() {
    let s = setup();
    let sender = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    // Authorize and mint to sender
    s.contract.unfreeze_account(&sender);
    s.contract.mint(&s.minter, &sender, &1_000_0000000);
    assert!(s.contract.is_authorized(&sender));

    // Recipient is NOT authorized (AUTH_REQUIRED default)
    assert!(!s.contract.is_authorized(&recipient));

    // Transfer to unauthorized recipient should fail
    let result = s.sac_token.try_transfer(&sender, &recipient, &100_0000000);
    assert!(result.is_err());
}
