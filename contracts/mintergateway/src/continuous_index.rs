//! Continuous Indexing Math
//!
//! Implements continuous compounding using the formula:
//!   currentIndex = latestIndex × e^(rate × time)
//!
//! Uses Taylor series approximation for e^x.
//! Fixed-point mul/div via `soroban-fixed-point-math` (audited, used by Blend v2).
//!
//! # Rounding Policy
//!
//! All integer division operations in this module round **DOWN** (truncate toward zero).
//! This is the protocol-favorable direction: yield calculations slightly underestimate,
//! which is the safe/conservative behavior.
//!
//! Net effect: the index pipeline is conservative at every step, slightly
//! underestimating cumulative growth. This is the safe/conservative behavior.

use soroban_fixed_point_math::FixedPoint;

// Re-export constants for backward compatibility
pub use crate::constants::{INDEX_SCALE, RATE_SCALE, SECONDS_PER_YEAR};

/// Converts basis points to scaled rate.
///
/// # Arguments
/// * `bps` - Rate in basis points (100 = 1%, 10000 = 100%)
///
/// # Returns
/// Rate scaled by RATE_SCALE (e.g., 500 bps → 50_000_000_000)
pub fn convert_from_basis_points(bps: u32) -> i128 {
    // bps / 10000 * RATE_SCALE = bps * RATE_SCALE / 10000
    // Rounding: DOWN (truncation). Slightly underestimates the rate. Protocol-favorable.
    (bps as i128) * RATE_SCALE / 10_000
}

/// Calculates e^x using a simplified Taylor series approximation.
///
/// For small x (typical interest rate × time combinations), we use:
/// e^x ≈ 1 + x + x²/2 + x³/6 + x⁴/24
///
/// Uses the recurrence: term_n = term_{n-1} * x / n, computed via
/// `fixed_mul_floor` (i.e., mulDivDown) to minimize truncation points.
///
/// This is accurate for x < 0.2 (20% per year) which covers all realistic rates.
///
/// # Rounding
/// Every term division rounds DOWN (via `fixed_mul_floor`), so the result
/// underestimates the true e^x. This is protocol-favorable — accrues less yield.
///
/// # Arguments
/// * `x` - Exponent scaled by INDEX_SCALE (e.g., 0.05 = 50_000_000_000)
///
/// # Returns
/// e^x scaled by INDEX_SCALE
pub fn exponent(x: i128) -> i128 {
    if x == 0 {
        return INDEX_SCALE;
    }

    // Taylor series: e^x = 1 + x + x²/2 + x³/6 + x⁴/24
    // Each term builds on the previous: term_n = term_{n-1} * x / n
    // The factorial is absorbed incrementally (e.g., /2 then /3 = /6, then /4 = /24).
    let first_term = x; // x
    let second_term = first_term
        .fixed_mul_floor(first_term, 2 * INDEX_SCALE)
        .unwrap(); // x * x / 2 = x²/2
    let third_term = second_term
        .fixed_mul_floor(first_term, 3 * INDEX_SCALE)
        .unwrap(); // x²/2 * x / 3 = x³/6
    let fourth_term = third_term
        .fixed_mul_floor(first_term, 4 * INDEX_SCALE)
        .unwrap(); // x³/6 * x / 4 = x⁴/24

    INDEX_SCALE
        .checked_add(first_term)
        .and_then(|s| s.checked_add(second_term))
        .and_then(|s| s.checked_add(third_term))
        .and_then(|s| s.checked_add(fourth_term))
        .unwrap()
}

/// Calculates the continuous index growth factor for a given rate and time period.
///
/// Returns e^(rate × time / SECONDS_PER_YEAR)
///
/// # Arguments
/// * `yearly_rate` - Annual rate scaled by RATE_SCALE
/// * `time_elapsed` - Time in seconds
///
/// # Returns
/// Index growth factor (delta index) scaled by INDEX_SCALE
pub fn get_continuous_index(yearly_rate: i128, time_elapsed: u64) -> i128 {
    if yearly_rate == 0 || time_elapsed == 0 {
        return INDEX_SCALE; // No growth, return 1.0
    }

    // exponent = rate × time / SECONDS_PER_YEAR
    // Rounding: DOWN (truncation). Slightly underestimates the exponent. Protocol-favorable.
    let exp = yearly_rate
        .checked_mul(time_elapsed as i128)
        .unwrap()
        .checked_div(SECONDS_PER_YEAR)
        .unwrap();

    exponent(exp)
}

/// Multiplies two indices together (compounds them).
///
/// result = (index × delta_index) / INDEX_SCALE
///
/// Rounding: DOWN (`fixed_mul_floor`). Standard truncation. Protocol-favorable.
///
/// # Arguments
/// * `index` - Base index scaled by INDEX_SCALE
/// * `delta_index` - Growth factor scaled by INDEX_SCALE
///
/// # Returns
/// Compounded index scaled by INDEX_SCALE
pub fn multiply_indices_down(index: i128, delta_index: i128) -> i128 {
    index.fixed_mul_floor(delta_index, INDEX_SCALE).unwrap()
}

/// Calculates the current index given the last stored index, rate, and time elapsed.
///
/// currentIndex = latestIndex × e^(rate × time / SECONDS_PER_YEAR)
///
/// # Arguments
/// * `latest_index` - Last stored index scaled by INDEX_SCALE
/// * `rate_bps` - Current rate in basis points
/// * `time_elapsed` - Seconds since last index update
///
/// # Returns
/// Current index scaled by INDEX_SCALE
pub fn current_index(latest_index: i128, rate_bps: u32, time_elapsed: u64) -> i128 {
    if rate_bps == 0 || time_elapsed == 0 {
        return latest_index;
    }

    let yearly_rate = convert_from_basis_points(rate_bps);
    let delta_index = get_continuous_index(yearly_rate, time_elapsed);

    // Rounding: DOWN via `multiply_indices_down` — favors the protocol (matches EVM m-core).
    multiply_indices_down(latest_index, delta_index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_from_basis_points() {
        // 0 bps = 0
        assert_eq!(convert_from_basis_points(0), 0);

        // 100 bps = 1% = 0.01 * 1e12 = 10_000_000_000
        assert_eq!(convert_from_basis_points(100), 10_000_000_000);

        // 500 bps = 5% = 0.05 * 1e12 = 50_000_000_000
        assert_eq!(convert_from_basis_points(500), 50_000_000_000);

        // 10000 bps = 100% = 1.0 * 1e12 = 1_000_000_000_000
        assert_eq!(convert_from_basis_points(10_000), 1_000_000_000_000);
    }

    #[test]
    fn test_exponent_zero() {
        // e^0 = 1.0
        assert_eq!(exponent(0), INDEX_SCALE);
    }

    #[test]
    fn test_exponent_small_values() {
        // e^0.01 ≈ 1.01005...
        let result = exponent(10_000_000_000); // 0.01 scaled
                                               // Should be approximately 1.01005e12
        assert!(result > 1_010_000_000_000);
        assert!(result < 1_011_000_000_000);
    }

    #[test]
    fn test_exponent_five_percent() {
        // e^0.05 ≈ 1.051271...
        let result = exponent(50_000_000_000); // 0.05 scaled
                                               // Should be approximately 1.051271e12
        assert!(result > 1_051_000_000_000);
        assert!(result < 1_052_000_000_000);
    }

    #[test]
    fn test_get_continuous_index_zero_rate() {
        assert_eq!(get_continuous_index(0, 1000), INDEX_SCALE);
    }

    #[test]
    fn test_get_continuous_index_zero_time() {
        assert_eq!(get_continuous_index(50_000_000_000, 0), INDEX_SCALE);
    }

    #[test]
    fn test_get_continuous_index_one_year() {
        // 5% rate for 1 year should give e^0.05 ≈ 1.051271
        let yearly_rate = convert_from_basis_points(500);
        let result = get_continuous_index(yearly_rate, SECONDS_PER_YEAR as u64);

        // Should be approximately 1.051271e12
        assert!(result > 1_051_000_000_000);
        assert!(result < 1_052_000_000_000);
    }

    #[test]
    fn test_multiply_indices() {
        // 1.0 × 1.0 = 1.0
        assert_eq!(multiply_indices_down(INDEX_SCALE, INDEX_SCALE), INDEX_SCALE);

        // 1.05 × 1.05 ≈ 1.1025
        let idx = 1_050_000_000_000i128;
        let result = multiply_indices_down(idx, idx);
        assert!(result > 1_102_000_000_000);
        assert!(result < 1_103_000_000_000);
    }

    #[test]
    fn test_current_index_no_change() {
        // Zero rate = no change
        assert_eq!(current_index(INDEX_SCALE, 0, 1000), INDEX_SCALE);

        // Zero time = no change
        assert_eq!(current_index(INDEX_SCALE, 500, 0), INDEX_SCALE);
    }

    #[test]
    fn test_current_index_compounding() {
        // Start at 1.0, 5% rate, 1 year
        let result = current_index(INDEX_SCALE, 500, SECONDS_PER_YEAR as u64);

        // Should be approximately 1.051271e12
        assert!(result > 1_051_000_000_000);
        assert!(result < 1_052_000_000_000);
    }
}
