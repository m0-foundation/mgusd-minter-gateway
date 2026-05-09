use super::setup::*;

// =============================================================================
// TOTAL SUPPLY / PRINCIPAL ACCUMULATOR TESTS
// =============================================================================

#[test]
fn test_total_supply_increases_on_mint() {
    let s = setup();
    let amount = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_total_supply_increases_on_claim_yield() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);

    // total_supply = principal + claimed, total_principal unchanged
    assert_eq!(s.contract.total_principal(), principal);
    assert_eq!(s.contract.total_supply(), principal + claimed);
}

#[test]
fn test_burn_decreases_both_accumulators() {
    let s = setup();
    let amount = 1_000_000 * DECIMALS;
    let burn = 400_000 * DECIMALS;

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
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);

    // Invariant: total_supply == total_principal + cumulative_claimed
    assert_eq!(
        s.contract.total_supply(),
        s.contract.total_principal() + claimed
    );
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
    let one_million = 1_000_000 * DECIMALS;

    // First mint at index = INDEX_SCALE (PV == nominal here)
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500); // 5%

    // Advance 1 year — index grows to ~1.0513
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Second mint triggers update_index, then adds to principal
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

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

// When a mint happens at an index > INDEX_SCALE, `pv_amount = floor(amount × SCALE /
// latest_index)` loses up to a stroop of residue. Re-multiplying to derive yield:
//     floor(total_principal × latest_index / SCALE)
// can be *strictly less than* `total_supply` by that residue. Without a clamp, the
// derivation `supply_with_yield − total_supply` returns a small negative number — pure
// rounding noise, not real negative yield. `get_accrued_yield` must clamp at 0.
#[test]
fn test_get_accrued_yield_clamps_floor_residue_to_zero() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    // Grow the index with zero principal so the next mint happens at index > SCALE.
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, 1_000_000);

    // Reproduce the floor-residue scenario: mint at a grown index forces a
    // truncated pv_amount.
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

    // Sanity: the scenario we're guarding actually occurred.
    // this inequality means the derivation underflows.
    let principal = s.contract.total_principal();
    let latest_index = s.contract.latest_index();
    let supply = s.contract.total_supply();
    let supply_with_yield_raw = principal * latest_index / INDEX_SCALE;
    assert!(
        supply_with_yield_raw < supply,
        "Test setup failed to reproduce the floor residue scenario. \
         principal={}, latest_index={}, supply_with_yield={}, supply={}",
        principal,
        latest_index,
        supply_with_yield_raw,
        supply
    );

    // The clamp must hide the noise: yield is 0, never negative.
    let yield_just_after_mint = s.contract.accrued_yield();
    assert_eq!(
        yield_just_after_mint, 0,
        "accrued_yield must clamp floor-residue underflow at 0 — yield is never \
         negative. Got {}.",
        yield_just_after_mint
    );
}

#[test]
fn test_burn_after_index_growth_stores_present_value_principal() {
    let s = setup();
    let two_million = 2_000_000 * DECIMALS;
    let burn_amount = 500_000 * DECIMALS;

    // Mint 2M at index = INDEX_SCALE
    s.contract.mint(&s.minter, &s.yield_recipient, &two_million);
    s.contract.set_rate(&s.minter, &500); // 5%

    // Advance 1 year — index grows
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Burn 500K (triggers update_index)
    s.contract.burn(&s.minter, &s.yield_recipient, &burn_amount);

    let index_at_burn = s.contract.latest_index();
    assert!(index_at_burn > INDEX_SCALE);

    // PV of burn uses ceil rounding (opposite of mint's floor).
    let pv_of_burn = pv_ceil(burn_amount, index_at_burn);
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
    let two_million = 2_000_000 * DECIMALS;
    let burn_amount = 500_000 * DECIMALS;

    // Year 0: mint 2M, set 5%
    s.contract.mint(&s.minter, &s.yield_recipient, &two_million);
    s.contract.set_rate(&s.minter, &500);

    // Year 1: burn 500K (triggers update_index)
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let index_yr1 = s.contract.current_index();
    let yield_after_yr1 = s.contract.accrued_yield();
    s.contract.burn(&s.minter, &s.yield_recipient, &burn_amount);

    // Year 2
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let total_claimed = s.contract.claim_yield(&s.yield_recipient_manager);

    let pv_of_burn = pv_ceil(burn_amount, index_yr1);
    let correct_principal_yr2 = two_million - pv_of_burn;

    let index_yr2 = s.contract.latest_index();
    let index_delta_yr2 = index_yr2 - index_yr1;
    let correct_yield_yr2 = correct_principal_yr2 * index_delta_yr2 / INDEX_SCALE;
    let expected_total = yield_after_yr1 + correct_yield_yr2;

    // Reference flooring twice can disagree with the contract's single-floor
    // derivation by 1 stroop of residue.
    let diff = (expected_total - total_claimed).abs();
    assert!(
        diff <= 1,
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
    let one_million = 1_000_000 * DECIMALS;

    // Mint 1M, set 10% rate
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &1000); // 10%

    // Advance 3 years — index ~= e^0.3 ~= 1.3499
    advance_time(&s.env, 3 * SECONDS_PER_YEAR as u64);

    // Second mint triggers update_index
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

    let index_at_mint2 = s.contract.latest_index();
    let pv_of_mint2 = one_million * INDEX_SCALE / index_at_mint2;
    let expected_principal = one_million + pv_of_mint2;

    let actual_principal = s.contract.total_principal();

    assert_eq!(
        actual_principal,
        expected_principal,
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
    let one_million = 1_000_000 * DECIMALS;

    // Mint 1 at index = INDEX_SCALE
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500); // 5%

    // Mint 2 after 1 year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    let index_yr1 = s.contract.latest_index();

    // Mint 3 after another year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    let index_yr2 = s.contract.latest_index();

    // Expected PV total: mint1 (at 1.0) + mint2 (at ~1.05) + mint3 (at ~1.10)
    let pv_mint1 = one_million; // INDEX_SCALE / INDEX_SCALE = 1
    let pv_mint2 = one_million * INDEX_SCALE / index_yr1;
    let pv_mint3 = one_million * INDEX_SCALE / index_yr2;
    let expected_total_pv = pv_mint1 + pv_mint2 + pv_mint3;

    let actual_principal = s.contract.total_principal();

    assert_eq!(
        actual_principal,
        expected_total_pv,
        "Sequential mints should accumulate PV. \
         Buggy (nominal): {}, correct (PV): {}. \
         Cumulative overstatement: {} tokens",
        actual_principal,
        expected_total_pv,
        actual_principal - expected_total_pv
    );
}

// Dust burns at index > 1.0 must not accumulate phantom principal: under
// floor rounding, single-stroop burns drop supply but leave principal intact,
// inflating accrued yield. Ceil rounding closes that gap.
#[test]
fn test_dust_burn_at_grown_index_does_not_accumulate_phantom_principal() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500); // 5%

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Materialize the grown index so subsequent burns share it.
    s.contract.burn(&s.minter, &s.yield_recipient, &1);
    let index_at_burn = s.contract.latest_index();
    assert!(index_at_burn > INDEX_SCALE);

    let principal_before = s.contract.total_principal();
    let supply_before = s.contract.total_supply();

    let dust_iterations: i128 = 1_000;
    for _ in 0..dust_iterations {
        s.contract.burn(&s.minter, &s.yield_recipient, &1);
    }

    let principal_after = s.contract.total_principal();
    let supply_after = s.contract.total_supply();

    assert_eq!(supply_before - supply_after, dust_iterations);

    // Ceil guarantees ≥ 1 PV unit dropped per dust burn; floor would drop 0.
    let principal_drop = principal_before - principal_after;
    assert!(
        principal_drop >= dust_iterations,
        "principal dropped by {}, expected ≥ {}",
        principal_drop,
        dust_iterations
    );
}
