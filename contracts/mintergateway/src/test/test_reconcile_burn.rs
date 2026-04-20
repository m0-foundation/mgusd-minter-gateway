use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use super::setup::{advance_time, give_collateral, setup, SECONDS_PER_YEAR, DECIMALS};
use crate::errors::YieldTokenError;

// =============================================================================
// HAPPY PATH
// =============================================================================

#[test]
fn test_reconcile_burn_decreases_both_accumulators() {
    let s = setup();
    let user = Address::generate(&s.env);
    let mint_amount = 1_000 * DECIMALS;
    let reconcile_amount = 400 * DECIMALS;
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &user, &mint_amount);

    // Simulate accidental token destruction (send to issuer)
    s.sac_token.transfer(&user, &s.issuer, &reconcile_amount);

    // Accumulators are stale — still reflect full mint
    assert_eq!(s.contract.total_principal(), mint_amount);
    assert_eq!(s.contract.total_supply(), mint_amount);

    // Admin reconciles
    s.contract.reconcile_burn(&reconcile_amount, &treasury);

    // Both accumulators decreased
    assert_eq!(s.contract.total_principal(), mint_amount - reconcile_amount);
    assert_eq!(s.contract.total_supply(), mint_amount - reconcile_amount);
}

#[test]
fn test_reconcile_burn_after_yield_accrual() {
    let s = setup();
    let user = Address::generate(&s.env);
    let mint_amount = 1_000 * DECIMALS;
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &user, &mint_amount);

    // Set 5% rate and advance 1 year
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, 365 * 24 * 3600);

    let principal_before = s.contract.total_principal();
    let supply_before = s.contract.total_supply();

    // Reconcile a portion — should work with grown index
    let reconcile_amount = 200 * DECIMALS;
    s.contract.reconcile_burn(&reconcile_amount, &treasury);

    // Both accumulators decreased (PV conversion applied to principal)
    assert!(s.contract.total_principal() < principal_before);
    assert!(s.contract.total_supply() < supply_before);
}

#[test]
fn test_reconcile_burn_full_amount_to_zero() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // Reconcile entire amount
    s.contract.reconcile_burn(&amount, &treasury);

    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);

    // Can mint again after zeroing out
    give_collateral(&s, &s.minter, 500 * DECIMALS);
    s.contract.mint(&s.minter, &user, &(500 * DECIMALS));
    assert_eq!(s.contract.total_principal(), 500 * DECIMALS);
    assert_eq!(s.contract.total_supply(), 500 * DECIMALS);
}

#[test]
fn test_reconcile_burn_real_world_send_to_issuer_flow() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let destroyed = 600 * DECIMALS;
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // User accidentally sends tokens to issuer — tokens are destroyed
    s.sac_token.transfer(&user, &s.issuer, &destroyed);
    assert_eq!(s.sac_token.balance(&user), amount - destroyed);

    // Accumulators are stale
    assert_eq!(s.contract.total_principal(), amount);

    // Admin detects the discrepancy off-chain and reconciles
    s.contract.reconcile_burn(&destroyed, &treasury);

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
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000 * DECIMALS);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    let result = s.contract.try_reconcile_burn(&0, &treasury);
    assert_eq!(result.unwrap_err().unwrap(), YieldTokenError::InvalidAmountError);
}

#[test]
fn test_reconcile_burn_rejects_negative_amount() {
    let s = setup();
    let user = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000 * DECIMALS);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    let result = s.contract.try_reconcile_burn(&-100, &treasury);
    assert_eq!(result.unwrap_err().unwrap(), YieldTokenError::InvalidAmountError);
}

#[test]
fn test_reconcile_burn_rejects_exceeding_principal() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // Try to reconcile more than principal
    let result = s.contract.try_reconcile_burn(&(amount + 1), &treasury);
    assert!(result.is_err());
}

// =============================================================================
// ACCESS CONTROL — only admin can call reconcile_burn
// =============================================================================

/// `reconcile_burn` uses `require_admin()` (not `require_admin_or`), so it
/// always demands admin auth regardless of caller. Verify that the call
/// reverts when auth is disabled — even with real supply in the contract.
#[test]
fn test_reconcile_burn_requires_admin_auth() {
    let s = setup(); // mock_all_auths — allows mint setup
    let user = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000 * DECIMALS);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    // Disable all auth — simulates a call without admin signature
    s.env.mock_auths(&[]);

    let result = s.contract.try_reconcile_burn(&(100 * DECIMALS), &treasury);
    assert!(result.is_err(), "reconcile_burn should revert without admin auth");

    // Accumulators unchanged
    assert_eq!(s.contract.total_principal(), 1_000 * DECIMALS);
    assert_eq!(s.contract.total_supply(), 1_000 * DECIMALS);
}

// =============================================================================
// ACCUMULATOR INTEGRITY
// =============================================================================

#[test]
fn test_reconcile_burn_does_not_touch_sac_tokens() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let reconcile_amount = 400 * DECIMALS;
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    let balance_before = s.sac_token.balance(&user);

    // reconcile_burn only adjusts accumulators — no clawback, no mint
    // but DOES release collateral (RD) to treasury
    s.contract.reconcile_burn(&reconcile_amount, &treasury);

    // User's SAC balance is unchanged
    assert_eq!(s.sac_token.balance(&user), balance_before);

    // Collateral released to treasury
    assert_eq!(s.collateral_token.balance(&treasury), reconcile_amount);
    assert_eq!(
        s.collateral_token.balance(&s.contract.address),
        amount - reconcile_amount
    );
}

#[test]
fn test_reconcile_burn_multiple_calls() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    // Multiple reconcile burns
    s.contract.reconcile_burn(&(200 * DECIMALS), &treasury);
    assert_eq!(s.contract.total_principal(), 800 * DECIMALS);

    s.contract.reconcile_burn(&(300 * DECIMALS), &treasury);
    assert_eq!(s.contract.total_principal(), 500 * DECIMALS);

    s.contract.reconcile_burn(&(500 * DECIMALS), &treasury);
    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);
}

/// Regression test: when index > 1.0, PV conversion shrinks the amount
/// (`pv = amount * INDEX_SCALE / latest_index < amount`). Without a nominal
/// guard, an amount exceeding `total_supply` could pass the PV check and
/// create negative `total_supply`. The `BurnExceedsSupply` guard prevents this.
#[test]
fn test_reconcile_burn_rejects_amount_exceeding_total_supply() {
    let s = setup();
    let user = Address::generate(&s.env);
    let mint_amount = 1_000 * DECIMALS; // 1000 tokens (7 decimals)

    let treasury = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);

    // Mint at index = 1.0 → total_principal = 1000, total_supply = 1000
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &user, &mint_amount);
    assert_eq!(s.contract.total_principal(), mint_amount);
    assert_eq!(s.contract.total_supply(), mint_amount);

    // Grow index via 5% rate for 1 year → index ≈ 1.0513
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // reconcile_burn with amount = total_supply + 1
    // PV ≈ 951 which is < 1000 (total_principal), so the PV guard alone would pass.
    // The nominal guard must catch this before total_supply goes negative.
    let overshoot = mint_amount + 1;
    let result = s.contract.try_reconcile_burn(&overshoot, &treasury);
    assert_eq!(
        result.unwrap_err().unwrap(),
        YieldTokenError::BurnExceedsSupply,
    );

    // Accumulators unchanged
    assert_eq!(s.contract.total_principal(), mint_amount);
    assert_eq!(s.contract.total_supply(), mint_amount);
}
