use super::setup::*;

// =============================================================================
// TOTAL SUPPLY / PRINCIPAL ACCUMULATOR TESTS
// =============================================================================

#[test]
fn test_total_supply_increases_on_mint() {
    let s = setup();
    let amount = 1_000_000_0000000i128;

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_total_supply_unchanged_on_claim_yield() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    deposit_reserves(&s, &s.admin, principal);
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // total_supply unchanged (claim distributes RD, not MGUSD), total_principal unchanged
    assert_eq!(s.contract.total_principal(), principal);
    assert_eq!(s.contract.total_supply(), principal);
}

#[test]
fn test_burn_decreases_both_accumulators() {
    let s = setup();
    let amount = 1_000_000_0000000i128;
    let burn = 400_000_0000000i128;

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &amount);

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

    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    deposit_reserves(&s, &s.admin, principal);
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // Invariant: total_supply == total_principal after claim (no MGUSD minted)
    assert_eq!(s.contract.total_supply(), s.contract.total_principal());
}

// =============================================================================
// PRINCIPAL PRESENT-VALUE TESTS
//
// total_principal stores present-value amounts:
//   on mint:  principal += amount * INDEX_SCALE / latest_index
//   on burn:  principal -= amount * INDEX_SCALE / latest_index
//
// This ensures yield calculations are correct regardless of when mints/burns
// occur relative to index growth.
// =============================================================================

#[test]
fn test_mint_after_index_growth_stores_present_value_principal() {
    let s = setup();
    let one_million = 1_000_000_0000000i128;

    // First mint at index = INDEX_SCALE (PV == nominal here)
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500); // 5%

    // Advance 1 year — index grows to ~1.0513
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Second mint triggers update_index, then adds to principal
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);

    let index_at_mint2 = s.contract.latest_index();
    assert!(
        index_at_mint2 > INDEX_SCALE,
        "index should have grown above 1.0"
    );

    // Correct PV of second mint: amount * INDEX_SCALE / latest_index
    let pv_of_mint2 = one_million * INDEX_SCALE / index_at_mint2;
    let expected_principal = one_million + pv_of_mint2;

    assert_eq!(
        s.contract.total_principal(),
        expected_principal,
        "total_principal should be present-value sum. \
         Got {} (nominal), expected {} (PV). \
         Overstatement: {} tokens",
        s.contract.total_principal(),
        expected_principal,
        s.contract.total_principal() - expected_principal
    );
}

#[test]
fn test_yield_overestimation_after_mint_at_grown_index() {
    let s = setup();
    let one_million = 1_000_000_0000000i128;

    // Year 0: mint 1M, set 5% rate
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500);

    // Year 1: index grows, mint another 1M (triggers update_index)
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let index_yr1 = s.contract.current_index();
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);

    // Snapshot yield after year 1 (before year 2 accrual)
    let yield_after_yr1 = s.contract.accrued_yield();

    // Year 2: advance another year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Claim all yield (year1 + year2)
    deposit_reserves(&s, &s.admin, 2 * one_million);
    let total_claimed = s.contract.claim_yield(&s.yield_recipient);

    // Compute correct year-2 yield using PV principal
    let pv_of_mint2 = one_million * INDEX_SCALE / index_yr1;
    let correct_principal_yr2 = one_million + pv_of_mint2;

    let index_yr2 = s.contract.latest_index();
    let index_delta_yr2 = index_yr2 - index_yr1;
    let correct_yield_yr2 = correct_principal_yr2 * index_delta_yr2 / INDEX_SCALE;
    let expected_total = yield_after_yr1 + correct_yield_yr2;

    assert_eq!(
        total_claimed, expected_total,
        "Yield is overestimated. Claimed {} but correct is {}. \
         Excess: {} tokens (protocol overpays by this amount)",
        total_claimed,
        expected_total,
        total_claimed - expected_total
    );
}

#[test]
fn test_burn_after_index_growth_stores_present_value_principal() {
    let s = setup();
    let two_million = 2_000_000_0000000i128;
    let burn_amount = 500_000_0000000i128;

    // Mint 2M at index = INDEX_SCALE
    give_collateral(&s, &s.minter, two_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &two_million);
    s.contract.set_rate(&s.minter, &500); // 5%

    // Advance 1 year — index grows
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Burn 500K (triggers update_index)
    s.contract.burn(&s.minter, &s.yield_recipient, &burn_amount);

    let index_at_burn = s.contract.latest_index();
    assert!(index_at_burn > INDEX_SCALE);

    // Correct PV of burn: amount * INDEX_SCALE / latest_index
    // Since initial 2M was minted at INDEX_SCALE, its PV is 2M.
    // The burn should subtract PV of the burned tokens.
    let pv_of_burn = burn_amount * INDEX_SCALE / index_at_burn;
    let expected_principal = two_million - pv_of_burn;

    assert_eq!(
        s.contract.total_principal(),
        expected_principal,
        "total_principal after burn should be PV-adjusted. \
         Got {} (nominal sub), expected {} (PV sub). \
         Over-subtraction: {} tokens",
        s.contract.total_principal(),
        expected_principal,
        expected_principal - s.contract.total_principal()
    );
}

#[test]
fn test_yield_underestimation_after_burn_at_grown_index() {
    let s = setup();
    let two_million = 2_000_000_0000000i128;
    let burn_amount = 500_000_0000000i128;

    // Year 0: mint 2M, set 5%
    give_collateral(&s, &s.minter, two_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &two_million);
    s.contract.set_rate(&s.minter, &500);

    // Year 1: burn 500K (triggers update_index)
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let index_yr1 = s.contract.current_index();
    let yield_after_yr1 = s.contract.accrued_yield();
    s.contract.burn(&s.minter, &s.yield_recipient, &burn_amount);

    // Year 2
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    deposit_reserves(&s, &s.admin, two_million);
    let total_claimed = s.contract.claim_yield(&s.yield_recipient);

    // Correct year-2 principal uses PV-adjusted burn
    let pv_of_burn = burn_amount * INDEX_SCALE / index_yr1;
    let correct_principal_yr2 = two_million - pv_of_burn;

    let index_yr2 = s.contract.latest_index();
    let index_delta_yr2 = index_yr2 - index_yr1;
    let correct_yield_yr2 = correct_principal_yr2 * index_delta_yr2 / INDEX_SCALE;
    let expected_total = yield_after_yr1 + correct_yield_yr2;

    assert_eq!(
        total_claimed, expected_total,
        "Yield is underestimated after burn. Claimed {} but correct is {}. \
         Shortfall: {} tokens",
        total_claimed,
        expected_total,
        expected_total - total_claimed
    );
}

#[test]
fn test_large_index_growth_amplifies_principal_error() {
    let s = setup();
    let one_million = 1_000_000_0000000i128;

    // Mint 1M, set 10% rate
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &1000); // 10%

    // Advance 3 years — index ~= e^0.3 ~= 1.3499
    advance_time(&s.env, 3 * SECONDS_PER_YEAR as u64);

    // Second mint triggers update_index
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);

    let index_at_mint2 = s.contract.latest_index();
    let pv_of_mint2 = one_million * INDEX_SCALE / index_at_mint2;
    let expected_principal = one_million + pv_of_mint2;

    let actual_principal = s.contract.total_principal();

    assert_eq!(
        actual_principal, expected_principal,
        "Large index growth amplifies the bug. \
         Got {} (nominal), expected {} (PV). \
         Overstatement: {} tokens ({:.1}%)",
        actual_principal,
        expected_principal,
        actual_principal - expected_principal,
        ((actual_principal - expected_principal) as f64 / expected_principal as f64) * 100.0
    );
}

#[test]
fn test_sequential_mints_at_different_indices_accumulate_pv() {
    let s = setup();
    let one_million = 1_000_000_0000000i128;

    // Mint 1 at index = INDEX_SCALE
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500); // 5%

    // Mint 2 after 1 year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);
    let index_yr1 = s.contract.latest_index();

    // Mint 3 after another year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.minter, &s.yield_recipient, &one_million);
    let index_yr2 = s.contract.latest_index();

    // Expected PV total: mint1 (at 1.0) + mint2 (at ~1.05) + mint3 (at ~1.10)
    let pv_mint1 = one_million; // INDEX_SCALE / INDEX_SCALE = 1
    let pv_mint2 = one_million * INDEX_SCALE / index_yr1;
    let pv_mint3 = one_million * INDEX_SCALE / index_yr2;
    let expected_total_pv = pv_mint1 + pv_mint2 + pv_mint3;

    let actual_principal = s.contract.total_principal();

    assert_eq!(
        actual_principal, expected_total_pv,
        "Sequential mints should accumulate PV. \
         Buggy (nominal): {}, correct (PV): {}. \
         Cumulative overstatement: {} tokens",
        actual_principal,
        expected_total_pv,
        actual_principal - expected_total_pv
    );
}
