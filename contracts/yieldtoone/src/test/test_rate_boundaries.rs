use super::setup::*;

// =============================================================================
// RATE BOUNDARY VALIDATION TESTS
// =============================================================================
// Tests for set_rate at max/over-max, and rate transitions to/from zero.
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
    assert_eq!(result, Err(Ok(crate::YieldTokenError::RateExceedsMax)));

    // Rate unchanged (still default 0)
    assert_eq!(s.contract.interest_rate(), 0);
}

#[test]
fn test_set_rate_to_zero_stops_accrual() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

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
    let principal = 1_000_000_0000000i128;

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
    let principal = 1_000_000_0000000i128;

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
