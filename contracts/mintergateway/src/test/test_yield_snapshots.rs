use super::setup::*;

// =============================================================================
// YIELD SNAPSHOT CORRECTNESS TESTS
// =============================================================================
// Tests that update_index correctly finalizes yield before principal changes,
// and that multi-step operations produce correct cumulative yield.
// Code paths: contract.rs:237 (update_index in mint), contract.rs:259 (in burn),
// yield_state.rs:128-163 (update_index snapshotting), yield_state.rs:233-243 (claim)

#[test]
fn test_second_mint_snapshots_yield() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    // Step 1: Mint 1M, set rate 5%
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500);

    // Step 2: Advance 1 year — yield accrues on 1M
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Pre-compute index values for assertions
    let index_1yr = current_index(INDEX_SCALE, 500, SECONDS_PER_YEAR as u64);
    let index_2yr = current_index(index_1yr, 500, SECONDS_PER_YEAR as u64);

    // Step 3: Mint another 1M — update_index finalizes first year yield
    // PV conversion: pv = 1M * INDEX_SCALE / index_1yr
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    let pv_second_mint = one_million * INDEX_SCALE / index_1yr;
    assert_eq!(s.contract.total_principal(), one_million + pv_second_mint);

    // Step 4: Advance another year — yield accrues on PV principal
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Step 5: Claim total yield
    let claimed = s.contract.claim_yield(&s.yield_recipient);

    // Expected: first_year yield on 1M + second_year yield on PV principal
    let first_year_yield = one_million * (index_1yr - INDEX_SCALE) / INDEX_SCALE;
    let total_pv_principal = one_million + pv_second_mint;
    let second_year_yield = total_pv_principal * (index_2yr - index_1yr) / INDEX_SCALE;
    let expected = first_year_yield + second_year_yield;

    assert_eq!(claimed, expected);
    // Sanity: second year yield should be roughly double the first
    assert!(second_year_yield > first_year_yield);
}

#[test]
fn test_rate_before_principal() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    // Set rate with no principal — index grows but no yield earned
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    assert_eq!(s.contract.accrued_yield(), 0);

    // Now mint — update_index records grown index, but principal was 0 so no yield
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

    // Advance another year — yield accrues on 1M from the higher index base
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient);

    // The index grew during year 1 (no principal), so mint at year 1 uses PV conversion:
    // pv_principal = 1M × INDEX_SCALE / index_1yr
    // yield = pv_principal × (index_2yr − index_1yr) / INDEX_SCALE
    let index_1yr = current_index(INDEX_SCALE, 500, SECONDS_PER_YEAR as u64);
    let index_2yr = current_index(index_1yr, 500, SECONDS_PER_YEAR as u64);
    let pv_principal = one_million * INDEX_SCALE / index_1yr;
    let expected = pv_principal * (index_2yr - index_1yr) / INDEX_SCALE;

    assert_eq!(claimed, expected);
    assert!(claimed > 0);
}

#[test]
fn test_claim_then_claim_same_timestamp() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // First claim resets accrued yield to 0
    let first_claim = s.contract.claim_yield(&s.yield_recipient);
    assert!(first_claim > 0);

    // Second claim at the same timestamp — no time elapsed, no new yield
    let second_claim = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(second_claim, 0);
}

// =============================================================================
// INVALID AMOUNT REJECTION TESTS (amount <= 0)
// =============================================================================
// Code path: contract.rs:25-30 (check_positive_amount)

#[test]
fn test_mint_negative_amount() {
    let s = setup();

    let result = s.contract.try_mint(&s.minter, &s.yield_recipient, &-1);
    assert_eq!(result, Err(Ok(crate::MinterGatewayError::InvalidAmountError)));
}

#[test]
fn test_burn_negative_amount() {
    let s = setup();

    let result = s.contract.try_burn(&s.minter, &s.yield_recipient, &-1);
    assert_eq!(result, Err(Ok(crate::MinterGatewayError::InvalidAmountError)));
}

#[test]
fn test_mint_zero_amount() {
    let s = setup();

    let result = s.contract.try_mint(&s.minter, &s.yield_recipient, &0);
    assert_eq!(result, Err(Ok(crate::MinterGatewayError::InvalidAmountError)));
}

#[test]
fn test_burn_zero_amount() {
    let s = setup();

    let result = s.contract.try_burn(&s.minter, &s.yield_recipient, &0);
    assert_eq!(result, Err(Ok(crate::MinterGatewayError::InvalidAmountError)));
}
