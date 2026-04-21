use super::setup::*;

// =============================================================================
// RATE BOUNDARY VALIDATION TESTS
// =============================================================================
// Tests for set_rate at max/over-max, rate transitions to/from zero,
// and yield accuracy at extreme rate boundaries.
// Code paths: yield_state.rs:204-217 (set_interest_rate), contract.rs:280-282 (early return)

#[test]
fn test_set_rate_at_maximum_boundary() {
    let s = setup();

    // 10_000 bps = 100% — should succeed
    s.contract.set_rate(&s.minter, &10_000);

    assert_eq!(s.contract.interest_rate(), 10_000);
}

#[test]
fn test_set_rate_exceeds_maximum() {
    let s = setup();

    // 10_001 bps > 100% — should return RateExceedsMax
    let result = s.contract.try_set_rate(&s.minter, &10_001);
    assert_eq!(result, Err(Ok(crate::MinterGatewayError::RateExceedsMax)));

    // Rate unchanged (still default 0)
    assert_eq!(s.contract.interest_rate(), 0);
}

#[test]
fn test_set_rate_to_zero_stops_accrual() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    // Mint and set 5% rate
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    // Advance 1 year — yield accrues
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Set rate to 0 — finalizes pending yield, stops future accrual
    s.contract.set_rate(&s.minter, &0);
    let yield_after_zero = s.contract.accrued_yield();
    assert!(yield_after_zero > 0);

    // Advance another year — no new yield should accrue at rate 0
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    assert_eq!(s.contract.accrued_yield(), yield_after_zero);
}

#[test]
fn test_set_rate_zero_to_nonzero() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    // Rate starts at 0 (default), mint with zero rate
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);

    // Advance 1 year at rate 0 — no yield
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    assert_eq!(s.contract.accrued_yield(), 0);

    // Set rate to 5% — starts accrual from now
    s.contract.set_rate(&s.minter, &500);

    // Advance 1 year at 5%
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let yield_amount = s.contract.accrued_yield();

    // When rate was 0, index stayed at INDEX_SCALE (e^(0*t) = 1).
    // After set_rate(500), index grows for 1 year:
    // yield = 1M × (e^0.05 − 1) = 512_710_937_490
    assert_eq!(yield_amount, 512_710_937_490);
}

#[test]
fn test_set_rate_to_zero_finalizes_pending() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Pending yield before set_rate(0)
    let pending = s.contract.accrued_yield();
    assert_eq!(pending, 512_710_937_490);

    // set_rate(0) calls update_index which stores pending yield permanently
    s.contract.set_rate(&s.minter, &0);

    // Stored yield equals what was pending
    assert_eq!(s.contract.accrued_yield(), pending);

    // Claim to verify the stored yield is claimable
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(claimed, pending);
}

// =============================================================================
// YIELD ACCURACY AT MAX RATE (100%)
// =============================================================================
// Validates the 5-term Taylor series approximation at the upper rate boundary.
// At 100% rate (x=1.0), the 5-term Taylor gives e^1 ≈ 2.708333..., which
// underestimates the true e ≈ 2.718281... by ~0.37%. This is expected and
// protocol-favorable (less yield accrued).

#[test]
fn test_yield_accuracy_at_max_rate() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    // Mint 1M and set rate to 100% (10000 bps)
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &10_000);

    // Advance 1 year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Claim yield
    let claimed = s.contract.claim_yield(&s.yield_recipient);

    // 5-term Taylor: e^1.0 ≈ 1 + 1 + 1/2 + 1/6 + 1/24 = 2.708333...
    // So yield ≈ 1M × (2.708333... - 1) = 1M × 1.708333...
    // The exact Taylor value (at INDEX_SCALE precision):
    // index = exponent(1_000_000_000_000) computed via Taylor
    let index_1yr = current_index(INDEX_SCALE, 10_000, SECONDS_PER_YEAR as u64);
    let expected_yield = one_million * (index_1yr - INDEX_SCALE) / INDEX_SCALE;

    assert_eq!(claimed, expected_yield);
    assert!(claimed > 0);

    // Verify the ~0.37% underestimate vs true e:
    // True yield = 1M × (e - 1) ≈ 1M × 1.718281828...
    // Taylor yield ≈ 1M × 1.708333...
    // The Taylor result should be between 1.70 and 1.72 of principal
    let ratio_times_100 = (claimed * 100) / one_million;
    assert!(
        (170..=172).contains(&ratio_times_100),
        //ratio_times_100 >= 170 && ratio_times_100 <= 172,
        "yield/principal ratio outside expected range: {}",
        ratio_times_100
    );
}

// =============================================================================
// INDEX GROWTH FROM DEFAULT TIMESTAMP 0
// =============================================================================
// Verifies that when rate is set before any mint (timestamp starts at 0),
// the index grows correctly from t=0 to the first mint time, but no yield
// accrues because principal was 0 during that period.

#[test]
fn test_first_update_index_from_timestamp_zero() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    // Set rate before any mint — index will grow from timestamp 0
    s.contract.set_rate(&s.minter, &500); // 5%

    // Advance to T0 + 1_000_000 seconds (~11.6 days)
    advance_time(&s.env, 1_000_000);

    // No yield should have accrued (principal was 0)
    assert_eq!(s.contract.accrued_yield(), 0);

    // The index should have grown from the default (timestamp 0 → T0 + 1_000_000)
    let idx = s.contract.current_index();
    assert!(idx > INDEX_SCALE, "index should have grown from 1.0");

    // Now mint — update_index finalizes the grown index
    // PV conversion: principal = 1M * INDEX_SCALE / grown_index
    let grown_index = s.contract.current_index();
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

    // Still no yield (principal was 0 during the entire growth period)
    assert_eq!(s.contract.accrued_yield(), 0);
    let pv_principal = one_million * INDEX_SCALE / grown_index;
    assert_eq!(s.contract.total_principal(), pv_principal);

    // Advance another period — NOW yield accrues on the 1M principal
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let yield_amount = s.contract.accrued_yield();
    assert!(yield_amount > 0, "yield should accrue after mint");
}
