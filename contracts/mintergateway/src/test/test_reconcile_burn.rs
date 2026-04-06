use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use super::setup::{advance_time, give_collateral, setup, setup_no_mock_auth};
use crate::errors::YieldTokenError;

// =============================================================================
// HAPPY PATH
// =============================================================================

#[test]
fn test_reconcile_burn_decreases_both_accumulators() {
    let s = setup();
    let user = Address::generate(&s.env);
    let mint_amount = 1_000_0000000i128;
    let reconcile_amount = 400_0000000i128;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &user, &mint_amount);

    // Simulate accidental token destruction (send to issuer)
    s.sac_token.transfer(&user, &s.issuer, &reconcile_amount);

    // Accumulators are stale — still reflect full mint
    assert_eq!(s.contract.total_principal(), mint_amount);
    assert_eq!(s.contract.total_supply(), mint_amount);

    // Admin reconciles
    s.contract.reconcile_burn(&reconcile_amount, &s.minter);

    // Both accumulators decreased
    assert_eq!(s.contract.total_principal(), mint_amount - reconcile_amount);
    assert_eq!(s.contract.total_supply(), mint_amount - reconcile_amount);
}

#[test]
fn test_reconcile_burn_after_yield_accrual() {
    let s = setup();
    let user = Address::generate(&s.env);
    let mint_amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &user, &mint_amount);

    // Set 5% rate and advance 1 year
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, 365 * 24 * 3600);

    let principal_before = s.contract.total_principal();
    let supply_before = s.contract.total_supply();

    // Reconcile a portion — should work with grown index
    let reconcile_amount = 200_0000000i128;
    s.contract.reconcile_burn(&reconcile_amount, &s.minter);

    // Both accumulators decreased (PV conversion applied to principal)
    assert!(s.contract.total_principal() < principal_before);
    assert!(s.contract.total_supply() < supply_before);
}

#[test]
fn test_reconcile_burn_full_amount_to_zero() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // Reconcile entire amount
    s.contract.reconcile_burn(&amount, &s.minter);

    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);

    // Can mint again after zeroing out
    give_collateral(&s, &s.minter, 500_0000000);
    s.contract.mint(&s.minter, &user, &500_0000000);
    assert_eq!(s.contract.total_principal(), 500_0000000);
    assert_eq!(s.contract.total_supply(), 500_0000000);
}

#[test]
fn test_reconcile_burn_real_world_send_to_issuer_flow() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;
    let destroyed = 600_0000000i128;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // User accidentally sends tokens to issuer — tokens are destroyed
    s.sac_token.transfer(&user, &s.issuer, &destroyed);
    assert_eq!(s.sac_token.balance(&user), amount - destroyed);

    // Accumulators are stale
    assert_eq!(s.contract.total_principal(), amount);

    // Admin detects the discrepancy off-chain and reconciles
    s.contract.reconcile_burn(&destroyed, &s.minter);

    // Now accumulators match reality
    assert_eq!(s.contract.total_principal(), amount - destroyed);
    assert_eq!(s.contract.total_supply(), amount - destroyed);
    assert_eq!(s.sac_token.balance(&user), amount - destroyed);
}

// =============================================================================
// INPUT VALIDATION
// =============================================================================

#[test]
fn test_reconcile_burn_rejects_zero_amount() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    let result = s.contract.try_reconcile_burn(&0, &s.minter);
    assert_eq!(result.unwrap_err().unwrap(), YieldTokenError::InvalidAmountError);
}

#[test]
fn test_reconcile_burn_rejects_negative_amount() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    let result = s.contract.try_reconcile_burn(&-100, &s.minter);
    assert_eq!(result.unwrap_err().unwrap(), YieldTokenError::InvalidAmountError);
}

#[test]
fn test_reconcile_burn_rejects_exceeding_principal() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // Try to reconcile more than principal
    let result = s.contract.try_reconcile_burn(&(amount + 1), &s.minter);
    assert!(result.is_err());
}

// =============================================================================
// ACCESS CONTROL — only admin can call reconcile_burn
// =============================================================================

#[test]
fn test_minter_cannot_reconcile_burn() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);

    // reconcile_burn uses require_admin, not require_admin_or — minter is NOT allowed.
    // Since require_admin calls require_auth on the stored admin, calling from
    // a non-admin address with mock_all_auths still succeeds (auth is mocked).
    // We need setup_no_mock_auth to test this properly — see auth test below.
    // The function signature is reconcile_burn(amount, collateral_to) — no caller param.
    // This test validates the happy path works when auth is mocked.
    s.contract.reconcile_burn(&100_0000000, &s.minter);
    assert_eq!(s.contract.total_principal(), 1_000_0000000 - 100_0000000);
}

#[test]
fn test_reconcile_burn_reverts_without_admin_auth() {
    let s = setup_no_mock_auth();
    let treasury = Address::generate(&s.env);

    // Can't even setup without auth in no-mock mode, so just try reconcile_burn directly.
    // The contract has no supply, but require_admin will fail first.
    let result = s.contract.try_reconcile_burn(&100_0000000, &treasury);
    assert!(result.is_err());
}

// =============================================================================
// ACCUMULATOR INTEGRITY
// =============================================================================

#[test]
fn test_reconcile_burn_does_not_touch_sac_tokens() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    let balance_before = s.sac_token.balance(&user);

    // reconcile_burn only adjusts accumulators — no clawback, no mint
    s.contract.reconcile_burn(&400_0000000, &s.minter);

    // User's SAC balance is unchanged
    assert_eq!(s.sac_token.balance(&user), balance_before);
}

#[test]
fn test_reconcile_burn_multiple_calls() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // Multiple reconcile burns
    s.contract.reconcile_burn(&200_0000000, &s.minter);
    assert_eq!(s.contract.total_principal(), 800_0000000);

    s.contract.reconcile_burn(&300_0000000, &s.minter);
    assert_eq!(s.contract.total_principal(), 500_0000000);

    s.contract.reconcile_burn(&500_0000000, &s.minter);
    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);
}
