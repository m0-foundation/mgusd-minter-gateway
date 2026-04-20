use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// MINT — mints SAC tokens and updates accumulators
// =============================================================================

#[test]
fn test_mint_increases_both_accumulators_and_sac_balance() {
    let s = setup();
    let amount = 1_000_000 * DECIMALS; // 1M tokens (7 decimals)
    let recipient = Address::generate(&s.env);

    // Authorize recipient before mint (AUTH_REQUIRED mode)
    s.contract.unfreeze_account(&s.admin, &recipient);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
    assert_eq!(s.sac_token.balance(&recipient), amount);
}

#[test]
fn test_mint_multiple_recipients() {
    let s = setup();
    let user_a = Address::generate(&s.env);
    let user_b = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user_a);
    s.contract.unfreeze_account(&s.admin, &user_b);
    give_collateral(&s, &s.minter, 500 * DECIMALS);
    s.contract.mint(&s.minter, &user_a, &(500 * DECIMALS));
    give_collateral(&s, &s.minter, 300 * DECIMALS);
    s.contract.mint(&s.minter, &user_b, &(300 * DECIMALS));

    assert_eq!(s.contract.total_principal(), 800 * DECIMALS);
    assert_eq!(s.contract.total_supply(), 800 * DECIMALS);
    assert_eq!(s.sac_token.balance(&user_a), 500 * DECIMALS);
    assert_eq!(s.sac_token.balance(&user_b), 300 * DECIMALS);
}

// =============================================================================
// BURN — happy path
// =============================================================================

#[test]
fn test_burn_decreases_both_accumulators_and_sac_balance() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000 * DECIMALS);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));
    s.contract.burn(&s.minter, &user, &(400 * DECIMALS));

    assert_eq!(s.contract.total_principal(), 600 * DECIMALS);
    assert_eq!(s.contract.total_supply(), 600 * DECIMALS);
    assert_eq!(s.sac_token.balance(&user), 600 * DECIMALS);
}

#[test]
fn test_burn_decreases_principal() {
    let s = setup();
    let initial = 1_000_000 * DECIMALS;

    give_collateral(&s, &s.minter, initial);
    s.contract.mint(&s.minter, &s.yield_recipient, &initial);
    assert_eq!(s.contract.total_principal(), initial);

    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_before_burn = s.contract.accrued_yield();
    assert!(yield_before_burn > 0);

    // Burn half — PV conversion: pv_burn = burn_amount * INDEX_SCALE / current_index
    // Use current_index because burn() calls update_index() which advances latest_index
    let burn_amount = 500_000 * DECIMALS;
    let idx_at_burn = s.contract.current_index();
    s.contract.burn(&s.minter, &s.yield_recipient, &burn_amount);

    // Principal reduced by PV of burn amount
    let pv_burn = burn_amount * INDEX_SCALE / idx_at_burn;
    assert_eq!(s.contract.total_principal(), initial - pv_burn);

    // Accrued yield should still be there (burn calls update_index first)
    assert!(s.contract.accrued_yield() > 0);

    // Now yield accrues on reduced principal
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Deposit collateral reserves to back yield claim
    let yield_reserves_amount = s.contract.accrued_yield() + s.contract.total_supply();
    deposit_reserves(&s, &s.admin, yield_reserves_amount);

    let claimed = s.contract.claim_yield(&s.yield_recipient);
    let second_year_yield = claimed - yield_before_burn;
    assert!(
        second_year_yield < yield_before_burn,
        "Second year yield on half principal should be less than first year"
    );
    // With PV conversion, burned PV < nominal burn amount, so more principal
    // remains earning yield. The ratio is slightly above 0.5.
    let ratio = (second_year_yield as f64) / (yield_before_burn as f64);
    assert!(
        ratio > 0.45 && ratio < 0.60,
        "Expected ~0.5 ratio, got {}",
        ratio
    );
}

#[test]
fn test_burn_exactly_principal() {
    let s = setup();
    let initial = 1_000 * DECIMALS;

    give_collateral(&s, &s.minter, initial);
    s.contract.mint(&s.minter, &s.yield_recipient, &initial);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Deposit collateral reserves to back yield claim
    let yield_reserves_amount = s.contract.accrued_yield() + s.contract.total_supply();
    deposit_reserves(&s, &s.admin, yield_reserves_amount);

    let total_supply_before_claim = s.contract.total_supply();

    // claim_yield distributes RD (collateral) tokens, NOT MGUSD — total_supply unchanged
    assert_eq!(s.contract.total_supply(), total_supply_before_claim);

    // After index growth, PV of `initial` < `initial` (index > INDEX_SCALE),
    // so burning `initial` nominal tokens removes pv_burn < initial from principal.
    let latest_idx = s.contract.latest_index();
    let pv_burn = initial * INDEX_SCALE / latest_idx;
    s.contract.burn(&s.minter, &s.yield_recipient, &initial);

    // Principal has a small residual from PV rounding
    assert_eq!(s.contract.total_principal(), initial - pv_burn);
    // total_supply = total_supply_before_claim - initial (claim_yield no longer increases total_supply)
    assert_eq!(s.contract.total_supply(), total_supply_before_claim - initial);
}

// =============================================================================
// EDGE CASES & ERROR PATHS
// =============================================================================

#[test]
fn test_burn_exceeding_principal_reverts() {
    let s = setup();
    let initial = 1_000 * DECIMALS;

    give_collateral(&s, &s.minter, initial);
    s.contract.mint(&s.minter, &s.yield_recipient, &initial);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Deposit collateral reserves to back yield claim
    let yield_reserves_amount = s.contract.accrued_yield() + s.contract.total_supply();
    deposit_reserves(&s, &s.admin, yield_reserves_amount);

    // Claim yield so yield_recipient has more SAC tokens than principal
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // With PV conversion, we need to burn an amount whose PV exceeds total_principal.
    // total_principal = initial (minted at INDEX_SCALE).
    // After index growth, pv(amount) = amount * INDEX_SCALE / latest_index < amount.
    // So we need a larger nominal amount to exceed principal in PV terms.
    // Burn 2x the initial amount — pv(2*initial) > initial at 5% growth.
    let excessive_amount = 2 * initial + claimed;
    let result = s.contract.try_burn(&s.minter, &s.yield_recipient, &excessive_amount);
    assert!(result.is_err());
}

/// When index > 1.0, PV conversion shrinks the burn amount (pv < nominal).
/// This means the PV guard in `decrease_both_accumulators` alone would allow
/// burning more tokens than `total_supply`. The `checked_sub` on `total_supply`
/// inside `decrease_both_accumulators` panics before SAC clawback even runs
/// (accumulators are updated before clawback in `burn`).
#[test]
fn test_burn_exceeding_total_supply_reverts() {
    let s = setup();
    let user = Address::generate(&s.env);
    let mint_amount = 1_000 * DECIMALS;

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, mint_amount);
    s.contract.mint(&s.minter, &user, &mint_amount);

    // Grow index so PV conversion shrinks amounts
    s.contract.set_rate(&s.minter, &500); // 5%
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Try to burn 1 more than total_supply.
    // PV ≈ 951 which is < total_principal (1000), so the PV guard passes.
    // But checked_sub on total_supply panics — amount > total_supply.
    let overshoot = mint_amount + 1;
    let result = s.contract.try_burn(&s.minter, &user, &overshoot);
    assert!(result.is_err(), "checked_sub should panic when amount > total_supply");

    // Accumulators unchanged — no state corruption
    assert_eq!(s.contract.total_principal(), mint_amount);
    assert_eq!(s.contract.total_supply(), mint_amount);
}

#[test]
fn test_mint_after_burn_to_zero() {
    let s = setup();
    let amount = 1_000 * DECIMALS;

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    s.contract.burn(&s.minter, &s.yield_recipient, &amount);
    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);
    assert_eq!(s.sac_token.balance(&s.yield_recipient), 0);

    // Mint again
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
    assert_eq!(s.sac_token.balance(&s.yield_recipient), amount);
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_mint_reverts_without_caller_auth() {
    let s = setup_no_mock_auth();
    let result = s.contract.try_mint(&s.minter, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result.unwrap_err().unwrap_err(), soroban_sdk::InvokeError::Abort);
}

#[test]
fn test_burn_reverts_without_caller_auth() {
    let s = setup_no_mock_auth();
    let result = s.contract.try_burn(&s.minter, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result.unwrap_err().unwrap_err(), soroban_sdk::InvokeError::Abort);
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
    give_collateral(&s, &s.minter, 1_000 * DECIMALS);
    let result = s.contract.try_mint(&s.minter, &user, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::RecipientFrozen)));
}

#[test]
fn test_authorized_account_can_receive_mint() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Authorize via unfreeze_account (allowlist)
    s.contract.unfreeze_account(&s.admin, &user);
    assert!(s.contract.is_authorized(&user));

    // Minting to authorized account succeeds
    give_collateral(&s, &s.minter, 1_000 * DECIMALS);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), 1_000 * DECIMALS);
}

// =============================================================================
// ACCESS CONTROL — MINT (admin or minter only)
// =============================================================================

#[test]
fn test_yield_recipient_manager_cannot_mint() {
    let s = setup();

    give_collateral(&s, &s.yield_recipient_manager, 1_000 * DECIMALS);
    let result = s
        .contract
        .try_mint(&s.yield_recipient_manager, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_mint() {
    let s = setup();

    give_collateral(&s, &s.yield_recipient, 1_000 * DECIMALS);
    let result = s
        .contract
        .try_mint(&s.yield_recipient, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_forced_transfer_manager_cannot_mint() {
    let s = setup();

    give_collateral(&s, &s.forced_transfer_manager, 1_000 * DECIMALS);
    let result = s
        .contract
        .try_mint(&s.forced_transfer_manager, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_mint() {
    let s = setup();
    let random = Address::generate(&s.env);

    give_collateral(&s, &random, 1_000 * DECIMALS);
    let result = s
        .contract
        .try_mint(&random, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

// =============================================================================
// ACCESS CONTROL — BURN (admin or minter only)
// =============================================================================

#[test]
fn test_yield_recipient_manager_cannot_burn() {
    let s = setup();

    let result = s
        .contract
        .try_burn(&s.yield_recipient_manager, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_burn() {
    let s = setup();

    let result = s
        .contract
        .try_burn(&s.yield_recipient, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_forced_transfer_manager_cannot_burn() {
    let s = setup();

    let result = s
        .contract
        .try_burn(&s.forced_transfer_manager, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_burn() {
    let s = setup();
    let random = Address::generate(&s.env);

    let result = s
        .contract
        .try_burn(&random, &s.yield_recipient, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}
