use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// 2. DIRECT MINT — mints SAC tokens and updates accumulators
// =============================================================================

#[test]
fn test_mint_increases_both_accumulators_and_sac_balance() {
    let s = setup();
    let amount = 1_000_000_0000000i128; // 1M tokens (7 decimals)
    let recipient = Address::generate(&s.env);

    // Authorize recipient before mint (AUTH_REQUIRED mode)
    s.contract.unfreeze_account(&recipient);
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

    s.contract.unfreeze_account(&user_a);
    s.contract.unfreeze_account(&user_b);
    s.contract.mint(&s.minter, &user_a, &500_0000000);
    s.contract.mint(&s.minter, &user_b, &300_0000000);

    assert_eq!(s.contract.total_principal(), 800_0000000);
    assert_eq!(s.contract.total_supply(), 800_0000000);
    assert_eq!(s.sac_token.balance(&user_a), 500_0000000);
    assert_eq!(s.sac_token.balance(&user_b), 300_0000000);
}

// =============================================================================
// 3. DIRECT BURN — clawbacks SAC tokens and updates accumulators
// =============================================================================

#[test]
fn test_burn_decreases_both_accumulators_and_sac_balance() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &1_000_0000000);
    s.contract.burn(&s.minter, &user, &400_0000000);

    assert_eq!(s.contract.total_principal(), 600_0000000);
    assert_eq!(s.contract.total_supply(), 600_0000000);
    assert_eq!(s.sac_token.balance(&user), 600_0000000);
}

#[test]
fn test_burn_exceeding_principal_reverts() {
    let s = setup();

    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Claim yield so yield_recipient has more SAC tokens than principal
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // Try to burn more than principal — should fail
    let total_sac_balance = s.sac_token.balance(&s.yield_recipient);
    assert!(total_sac_balance > 1_000_0000000);

    let result = s.contract.try_burn(&s.minter, &s.yield_recipient, &total_sac_balance);
    assert!(result.is_err());
}

#[test]
fn test_burn_exactly_principal() {
    let s = setup();
    let initial = 1_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &initial);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient);

    // Burn exactly principal — succeeds
    s.contract.burn(&s.minter, &s.yield_recipient, &initial);

    assert_eq!(s.contract.total_principal(), 0);
    // total_supply still has the claimed yield portion
    assert_eq!(s.contract.total_supply(), claimed);
}

// =============================================================================
// BURN AFFECTS PRINCIPAL TESTS
// =============================================================================

#[test]
fn test_burn_decreases_principal() {
    let s = setup();
    let initial = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &initial);
    assert_eq!(s.contract.total_principal(), initial);

    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_before_burn = s.contract.accrued_yield();
    assert!(yield_before_burn > 0);

    // Burn half
    let burn_amount = 500_000_0000000i128;
    s.contract.burn(&s.minter, &s.yield_recipient, &burn_amount);

    // Principal reduced
    assert_eq!(s.contract.total_principal(), initial - burn_amount);

    // Accrued yield should still be there (burn calls update_index first)
    assert!(s.contract.accrued_yield() > 0);

    // Now yield accrues on reduced principal
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient);
    let second_year_yield = claimed - yield_before_burn;
    assert!(
        second_year_yield < yield_before_burn,
        "Second year yield on half principal should be less than first year"
    );
    let ratio = (second_year_yield as f64) / (yield_before_burn as f64);
    assert!(
        ratio > 0.45 && ratio < 0.55,
        "Expected ~0.5 ratio, got {}",
        ratio
    );
}

// =============================================================================
// EDGE CASES
// =============================================================================

#[test]
fn test_mint_after_burn_to_zero() {
    let s = setup();
    let amount = 1_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    s.contract.burn(&s.minter, &s.yield_recipient, &amount);
    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);
    assert_eq!(s.sac_token.balance(&s.yield_recipient), 0);

    // Mint again
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
    assert_eq!(s.sac_token.balance(&s.yield_recipient), amount);
}
