use super::setup::*;

// =============================================================================
// RATE BOUNDARY VALIDATION TESTS
// =============================================================================
// Tests for set_interest_rate at max/over-max, rate transitions to/from zero,
// and yield accuracy at extreme rate boundaries.
// Code paths: yield_state.rs:204-217 (set_interest_rate), contract.rs:280-282 (early return)

#[test]
fn test_set_interest_rate_at_maximum_boundary() {
    let s = setup();

    // 5_000 bps = 50% — should succeed (MAX_RATE_BPS)
    s.contract.set_interest_rate(&s.minter, &5_000);

    assert_eq!(s.contract.interest_rate(), 5_000);
}

#[test]
fn test_set_interest_rate_exceeds_maximum() {
    let s = setup();

    // 5_001 bps > 50% — should return RateExceedsMax
    let result = s.contract.try_set_interest_rate(&s.minter, &5_001);
    assert_eq!(result, Err(Ok(crate::MinterGatewayError::RateExceedsMax)));

    // Rate unchanged (still default 0)
    assert_eq!(s.contract.interest_rate(), 0);
}

#[test]
fn test_set_interest_rate_to_zero_stops_accrual() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    // Mint and set 5% rate
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_interest_rate(&s.minter, &500);

    // Advance 1 year — yield accrues
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Set rate to 0 — finalizes pending yield, stops future accrual
    s.contract.set_interest_rate(&s.minter, &0);
    let yield_after_zero = s.contract.accrued_yield();
    assert!(yield_after_zero > 0);

    // Advance another year — no new yield should accrue at rate 0
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    assert_eq!(s.contract.accrued_yield(), yield_after_zero);
}

#[test]
fn test_set_interest_rate_zero_to_nonzero() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    // Rate starts at 0 (default), mint with zero rate
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);

    // Advance 1 year at rate 0 — no yield
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    assert_eq!(s.contract.accrued_yield(), 0);

    // Set rate to 5% — starts accrual from now
    s.contract.set_interest_rate(&s.minter, &500);

    // Advance 1 year at 5%
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let yield_amount = s.contract.accrued_yield();

    // When rate was 0, index stayed at INDEX_SCALE (e^(0*t) = 1).
    // After set_interest_rate(500), index grows for 1 year:
    // yield = 1M × (e^0.05 − 1) = 512_710_937_490
    assert_eq!(yield_amount, 512_710_937_490);
}

/// Regression: `update_index` must advance `last_update_timestamp` every
/// time `current_time > last_update_timestamp`, even when rate=0 keeps the
/// index value flat and no `UpdateIndex` event is emitted. If the timestamp
/// stayed stale across a zero-rate interval, the next non-zero-rate update
/// would compute `time_elapsed` from the wrong baseline and overcount yield
/// by the length of the zero-rate period.
///
/// With the fix present, accrued yield after (1yr at rate=0) + (1hr at 5%)
/// equals one hour of accrual on 1M at 5% — about 5.7 tokens. Under the
/// regression, it would include the full 1yr+1hr baseline and produce
/// ~52,000 tokens.
#[test]
fn test_update_index_advances_timestamp_through_zero_rate_period() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    // Mint at rate=0. Internally calls update_index, which must persist
    // last_update_timestamp = T0 even though the index value stays flat.
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);

    // A full year at rate=0 — no yield accrues, and update_index on the
    // next call must advance the timestamp past this interval.
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    assert_eq!(s.contract.accrued_yield(), 0);

    // Flip the rate on. set_interest_rate calls update_index first; the bug would
    // leave last_update_timestamp stuck at its pre-year value because
    // rate=0 keeps current_index == latest_index and the emit guard false.
    s.contract.set_interest_rate(&s.minter, &500);

    // Accrue for exactly one hour at 5%.
    advance_time(&s.env, 3_600);

    // Yield should match one hour at 5% on 1M principal — NOT (1yr + 1hr).
    let yield_amount = s.contract.accrued_yield();
    let expected_one_hour =
        principal * (current_index(INDEX_SCALE, 500, 3_600) - INDEX_SCALE) / INDEX_SCALE;
    assert_eq!(
        yield_amount, expected_one_hour,
        "yield must reflect only the hour post-rate-change; a higher value \
         would indicate last_update_timestamp wasn't advanced through the \
         zero-rate year"
    );
}

#[test]
fn test_set_interest_rate_to_zero_finalizes_pending() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_interest_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Pending yield before set_interest_rate(0)
    let pending = s.contract.accrued_yield();
    assert_eq!(pending, 512_710_937_490);

    // set_interest_rate(0) calls update_index which stores pending yield permanently
    s.contract.set_interest_rate(&s.minter, &0);

    // Stored yield equals what was pending
    assert_eq!(s.contract.accrued_yield(), pending);

    // Claim to verify the stored yield is claimable
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(claimed, pending);
}

// =============================================================================
// YIELD ACCURACY AT MAX RATE (50%)
// =============================================================================
// Validates the 5-term Taylor series approximation at the upper rate boundary.
// At 50% rate (x=0.5), the 5-term Taylor gives e^0.5 ≈ 1.648437..., which
// underestimates the true e^0.5 ≈ 1.648721... by ~0.017%. This is expected
// and protocol-favorable (less yield accrued).

#[test]
fn test_yield_accuracy_at_max_rate() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    // Mint 1M and set rate to 50% (MAX_RATE_BPS = 5000 bps)
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_interest_rate(&s.minter, &5_000);

    // Advance 1 year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Claim yield
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);

    // 5-term Taylor: e^0.5 ≈ 1 + 0.5 + 0.125 + 0.020833 + 0.002604 = 1.648437...
    // So yield ≈ 1M × (1.648437... - 1) = 1M × 0.648437...
    let index_1yr = current_index(INDEX_SCALE, 5_000, SECONDS_PER_YEAR as u64);
    let expected_yield = one_million * (index_1yr - INDEX_SCALE) / INDEX_SCALE;

    assert_eq!(claimed, expected_yield);
    assert!(claimed > 0);

    // Verify the ~0.017% underestimate vs true e^0.5:
    // True yield = 1M × (e^0.5 - 1) ≈ 1M × 0.648721...
    // Taylor yield ≈ 1M × 0.648437...
    // The Taylor result should be between 0.64 and 0.65 of principal
    let ratio_times_100 = (claimed * 100) / one_million;
    assert!(
        (64..=65).contains(&ratio_times_100),
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
    s.contract.set_interest_rate(&s.minter, &500); // 5%

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
