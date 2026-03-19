use super::setup::*;

// =============================================================================
// CONTINUOUS INDEX MATH (pure function tests)
// =============================================================================

#[test]
fn test_constructor() {
    let s = setup();

    assert_eq!(s.contract.admin(), s.admin);
    assert_eq!(s.contract.minter(), s.minter);
    assert_eq!(s.contract.yield_recipient_manager(), s.yield_recipient_manager);
    assert_eq!(s.contract.yield_recipient(), s.yield_recipient);
    assert_eq!(s.contract.forced_transfer_manager(), s.forced_transfer_manager);
    assert_eq!(s.contract.sac_token(), s.sac_token.address);

    assert_eq!(s.contract.current_index(), INDEX_SCALE);
    assert_eq!(s.contract.latest_index(), INDEX_SCALE);
    assert_eq!(s.contract.total_principal(), 0);
    assert_eq!(s.contract.total_supply(), 0);
    assert_eq!(s.contract.interest_rate(), 0);
    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_convert_from_basis_points_boundary() {
    assert_eq!(convert_from_basis_points(0), 0);
    assert_eq!(convert_from_basis_points(1), 100_000_000); // 0.01% = 0.0001
    assert_eq!(convert_from_basis_points(100), 10_000_000_000); // 1%
    assert_eq!(convert_from_basis_points(500), 50_000_000_000); // 5%
    assert_eq!(convert_from_basis_points(10_000), INDEX_SCALE); // 100%
}

#[test]
fn test_exponent_precision_1_percent() {
    let result = exponent(10_000_000_000);
    assert_eq!(result, 1_010_050_167_082);
}

#[test]
fn test_exponent_precision_5_percent() {
    let result = exponent(50_000_000_000);
    assert_eq!(result, 1_051_271_093_749);
}

#[test]
fn test_exponent_precision_10_percent() {
    let result = exponent(100_000_000_000);
    assert_eq!(result, 1_105_170_833_332);
}

#[test]
fn test_exponent_precision_20_percent() {
    let result = exponent(200_000_000_000);
    assert_eq!(result, 1_221_399_999_999);
}

#[test]
fn test_exponent_zero_returns_scale() {
    assert_eq!(exponent(0), INDEX_SCALE);
}

#[test]
fn test_get_continuous_index_zero_rate_returns_scale() {
    assert_eq!(get_continuous_index(0, 31_536_000), INDEX_SCALE);
}

#[test]
fn test_get_continuous_index_zero_time_returns_scale() {
    assert_eq!(get_continuous_index(50_000_000_000, 0), INDEX_SCALE);
}

#[test]
fn test_get_continuous_index_5pct_one_year() {
    let yearly_rate = convert_from_basis_points(500);
    let result = get_continuous_index(yearly_rate, SECONDS_PER_YEAR as u64);
    assert_eq!(result, 1_051_271_093_749);
}

#[test]
fn test_get_continuous_index_5pct_half_year() {
    let yearly_rate = convert_from_basis_points(500);
    let half_year = (SECONDS_PER_YEAR / 2) as u64;
    let result = get_continuous_index(yearly_rate, half_year);
    let expected = exponent(25_000_000_000);
    assert_eq!(result, expected);
}

#[test]
fn test_get_continuous_index_5pct_one_day() {
    let yearly_rate = convert_from_basis_points(500);
    let one_day = 86_400u64;
    let result = get_continuous_index(yearly_rate, one_day);
    let exp = 50_000_000_000i128 * 86_400 / SECONDS_PER_YEAR;
    let expected = exponent(exp);
    assert_eq!(result, expected);
}

#[test]
fn test_multiply_indices_down_identity() {
    assert_eq!(multiply_indices_down(INDEX_SCALE, INDEX_SCALE), INDEX_SCALE);
}

#[test]
fn test_current_index_no_change_cases() {
    assert_eq!(current_index(INDEX_SCALE, 0, 1000), INDEX_SCALE);
    assert_eq!(current_index(INDEX_SCALE, 500, 0), INDEX_SCALE);
    assert_eq!(current_index(INDEX_SCALE, 0, 0), INDEX_SCALE);
}

#[test]
fn test_current_index_5pct_one_year() {
    let result = current_index(INDEX_SCALE, 500, SECONDS_PER_YEAR as u64);
    let delta = get_continuous_index(convert_from_basis_points(500), SECONDS_PER_YEAR as u64);
    let expected = multiply_indices_down(INDEX_SCALE, delta);
    assert_eq!(result, expected);
    assert_eq!(result, 1_051_271_093_749);
}

#[test]
fn test_current_index_compounds_over_two_periods() {
    let one_year = SECONDS_PER_YEAR as u64;
    let half_year = one_year / 2;

    let idx_6m = current_index(INDEX_SCALE, 500, half_year);
    let idx_1y_two_step = current_index(idx_6m, 500, half_year);
    let idx_1y_one_step = current_index(INDEX_SCALE, 500, one_year);

    let diff = if idx_1y_two_step > idx_1y_one_step {
        idx_1y_two_step - idx_1y_one_step
    } else {
        idx_1y_one_step - idx_1y_two_step
    };
    assert!(
        diff < 10_000,
        "Two-step vs one-step diff too large: {}",
        diff
    );
}

#[test]
fn test_current_index_10pct_one_year() {
    let result = current_index(INDEX_SCALE, 1000, SECONDS_PER_YEAR as u64);
    assert_eq!(result, 1_105_170_833_332);
}

#[test]
fn test_current_index_from_non_unity_base() {
    let base = 1_050_000_000_000i128;
    let result = current_index(base, 500, SECONDS_PER_YEAR as u64);
    let delta = get_continuous_index(convert_from_basis_points(500), SECONDS_PER_YEAR as u64);
    let expected = multiply_indices_down(base, delta);
    assert_eq!(result, expected);
    assert!(result > 1_103_000_000_000);
    assert!(result < 1_104_000_000_000);
}

// =============================================================================
// CURRENT INDEX EARLY-RETURN (same timestamp)
// =============================================================================

#[test]
fn test_current_index_returns_stored_when_no_time_elapsed() {
    let s = setup();

    // set_rate calls update_index, which stores T0 as last_update_timestamp
    s.contract.set_rate(&s.minter, &500);

    // Call current_index at the same timestamp (no advance_time)
    // This hits the `current_time <= last_update_timestamp` early return
    assert_eq!(s.contract.current_index(), INDEX_SCALE);
}

// =============================================================================
// INDEX UPDATE INTEGRATION TESTS
// =============================================================================

#[test]
fn test_index_unchanged_with_zero_rate() {
    let s = setup();

    give_collateral(&s, &s.minter, 10_000_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &10_000_0000000);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    assert_eq!(s.contract.current_index(), INDEX_SCALE);
    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_index_unchanged_with_zero_principal() {
    let s = setup();

    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Index grows (it always grows with rate > 0) but no yield accrued
    let idx = s.contract.current_index();
    assert!(idx > INDEX_SCALE);
    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_index_grows_after_mint_and_rate_set() {
    let s = setup();
    let one_million = 1_000_000_0000000i128;

    give_collateral(&s, &s.minter, one_million);
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let idx = s.contract.current_index();
    assert_eq!(idx, 1_051_271_093_749);
}

#[test]
fn test_index_stored_after_state_change() {
    let s = setup();

    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let current = s.contract.current_index();
    let latest_before = s.contract.latest_index();
    assert_eq!(latest_before, INDEX_SCALE); // hasn't been stored yet

    // Pre-deposit collateral reserves for claim_yield
    let accrued = s.contract.accrued_yield();
    deposit_reserves(&s, &s.minter, accrued);

    // Trigger state change via claim_yield -> calls update_index
    s.contract.claim_yield(&s.yield_recipient);

    let latest_after = s.contract.latest_index();
    assert_eq!(latest_after, current);
}

#[test]
fn test_index_growth_1_day() {
    let s = setup();

    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, 86_400);

    let idx = s.contract.current_index();
    assert!(idx > INDEX_SCALE);
    assert!(idx < INDEX_SCALE + 200_000_000);
}

#[test]
fn test_index_growth_1_hour() {
    let s = setup();

    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, 3_600);

    let idx = s.contract.current_index();
    assert!(idx > INDEX_SCALE);
    assert!(idx < INDEX_SCALE + 10_000_000);
}
