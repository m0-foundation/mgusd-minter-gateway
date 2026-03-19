use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// HAPPY PATH — force_transfer moves tokens between accounts
// =============================================================================

#[test]
fn test_force_transfer_moves_tokens() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &500_0000000);

    assert_eq!(s.sac_token.balance(&alice), 500_0000000);
    assert_eq!(s.sac_token.balance(&bob), 500_0000000);
}

#[test]
fn test_force_transfer_full_balance() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &amount);

    assert_eq!(s.sac_token.balance(&alice), 0);
    assert_eq!(s.sac_token.balance(&bob), amount);
}

#[test]
fn test_force_transfer_partial_balance() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &100_0000000);

    assert_eq!(s.sac_token.balance(&alice), 900_0000000);
    assert_eq!(s.sac_token.balance(&bob), 100_0000000);
}

#[test]
fn test_force_transfer_does_not_change_accumulators() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let mint_amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &mint_amount);

    let principal_before = s.contract.total_principal();
    let supply_before = s.contract.total_supply();

    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &500_0000000);

    assert_eq!(s.contract.total_principal(), principal_before);
    assert_eq!(s.contract.total_supply(), supply_before);
}

#[test]
fn test_force_transfer_with_yield_accrued() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    // Set rate and advance time to accrue yield
    s.contract.set_rate(&s.minter, &500); // 5%
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let principal_before = s.contract.total_principal();
    let supply_before = s.contract.total_supply();

    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &500_0000000);

    // Accumulators unchanged (net zero)
    assert_eq!(s.contract.total_principal(), principal_before);
    assert_eq!(s.contract.total_supply(), supply_before);

    // Balances moved
    assert_eq!(s.sac_token.balance(&alice), 500_0000000);
    assert_eq!(s.sac_token.balance(&bob), 500_0000000);

    // Deposit reserves to back yield distribution
    let accrued = s.contract.accrued_yield();
    deposit_reserves(&s, &s.minter, accrued);

    // Yield can still be claimed (distributes RD, not MGUSD mint)
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);
}

#[test]
fn test_force_transfer_from_frozen_account() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    // Freeze alice
    s.contract.freeze_account(&s.admin, &alice);
    assert!(!s.contract.is_authorized(&alice));

    // Force transfer still works — clawback bypasses freeze
    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &500_0000000);

    assert_eq!(s.sac_token.balance(&alice), 500_0000000);
    assert_eq!(s.sac_token.balance(&bob), 500_0000000);
}

#[test]
fn test_force_transfer_admin_can_call() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    // Admin can also call force_transfer
    s.contract
        .force_transfer(&s.admin, &alice, &bob, &500_0000000);

    assert_eq!(s.sac_token.balance(&alice), 500_0000000);
    assert_eq!(s.sac_token.balance(&bob), 500_0000000);
}

#[test]
fn test_force_transfer_manager_can_call() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &500_0000000);

    assert_eq!(s.sac_token.balance(&alice), 500_0000000);
    assert_eq!(s.sac_token.balance(&bob), 500_0000000);
}

// =============================================================================
// EDGE CASES
// =============================================================================

#[test]
fn test_force_transfer_zero_amount() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&s.forced_transfer_manager, &alice, &bob, &0);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::InvalidAmountError)));
}

#[test]
fn test_force_transfer_to_self() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&s.admin, &alice);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &alice, &amount);

    // Self-transfer — balance unchanged
    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &alice, &500_0000000);

    assert_eq!(s.sac_token.balance(&alice), amount);
}

// =============================================================================
// ERROR PATHS
// =============================================================================

#[test]
fn test_force_transfer_negative_amount_reverts() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&s.forced_transfer_manager, &alice, &bob, &(-100));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::InvalidAmountError)));
}

#[test]
fn test_force_transfer_works_when_amount_exceeds_principal() {
    let s = setup();
    let bob = Address::generate(&s.env);
    let mint_amount = 1_000_0000000i128;

    // Mint to yield_recipient (already authorized in setup)
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &mint_amount);

    // Accrue yield: 50% rate, 1 year
    s.contract.set_rate(&s.minter, &5000);
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Deposit reserves to back yield distribution
    let accrued = s.contract.accrued_yield();
    deposit_reserves(&s, &s.minter, accrued);

    // Claim yield — distributes RD, does NOT mint more MGUSD to yield_recipient
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // yield_recipient's MGUSD balance stays at mint_amount (claim doesn't add MGUSD)
    assert_eq!(s.sac_token.balance(&s.yield_recipient), mint_amount);

    // Force transfer the full mint balance
    s.contract.unfreeze_account(&s.admin, &bob);
    s.contract.force_transfer(
        &s.forced_transfer_manager,
        &s.yield_recipient,
        &bob,
        &mint_amount,
    );

    assert_eq!(s.sac_token.balance(&s.yield_recipient), 0);
    assert_eq!(s.sac_token.balance(&bob), mint_amount);
}

#[test]
fn test_force_transfer_exceeds_balance_reverts() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, 500_0000000);
    s.contract.mint(&s.minter, &s.minter, &alice, &500_0000000);

    // Mint more to bob so total principal > alice's balance
    give_collateral(&s, &s.minter, 500_0000000);
    s.contract.mint(&s.minter, &s.minter, &bob, &500_0000000);

    // Try to force transfer more than alice has (but within principal)
    let result = s.contract.try_force_transfer(
        &s.forced_transfer_manager,
        &alice,
        &bob,
        &600_0000000,
    );
    // SAC clawback will fail — alice only has 500
    assert!(result.is_err());
}

#[test]
fn test_force_transfer_to_unauthorized_account_reverts() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env); // NOT authorized

    s.contract.unfreeze_account(&s.admin, &alice);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &s.minter, &alice, &1_000_0000000);

    // Bob is unauthorized (AUTH_REQUIRED mode) — mint to bob will fail
    assert!(!s.contract.is_authorized(&bob));
    let result = s.contract.try_force_transfer(
        &s.forced_transfer_manager,
        &alice,
        &bob,
        &500_0000000,
    );
    assert!(result.is_err());
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_force_transfer_reverts_without_caller_auth() {
    let s = setup_no_mock_auth();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&s.forced_transfer_manager, &alice, &bob, &1_000_0000000);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

// =============================================================================
// ACCESS CONTROL — force_transfer (admin or forced_transfer_manager only)
// =============================================================================

#[test]
fn test_minter_cannot_force_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&s.minter, &alice, &bob, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_force_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&s.yield_recipient, &alice, &bob, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_manager_cannot_force_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&s.yield_recipient_manager, &alice, &bob, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_distributor_cannot_force_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&s.distributor, &alice, &bob, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_force_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let random = Address::generate(&s.env);

    let result = s
        .contract
        .try_force_transfer(&random, &alice, &bob, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}
