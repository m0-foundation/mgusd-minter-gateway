use super::setup::*;

// =============================================================================
// TOTAL SUPPLY ACCUMULATOR TESTS
// =============================================================================

#[test]
fn test_total_supply_increases_on_mint() {
    let s = setup();
    let amount = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_total_supply_increases_on_claim_yield() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // total_supply = principal + claimed, total_principal unchanged
    assert_eq!(s.contract.total_principal(), principal);
    assert_eq!(s.contract.total_supply(), principal + claimed);
}

#[test]
fn test_burn_decreases_both_accumulators() {
    let s = setup();
    let amount = 1_000_000_0000000i128;
    let burn = 400_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);

    s.contract.burn(&s.minter, &s.yield_recipient, &burn);

    assert_eq!(s.contract.total_principal(), amount - burn);
    assert_eq!(s.contract.total_supply(), amount - burn);
}

#[test]
fn test_total_supply_invariant() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // Invariant: total_supply == total_principal + cumulative_claimed
    assert_eq!(s.contract.total_supply(), s.contract.total_principal() + claimed);
}
