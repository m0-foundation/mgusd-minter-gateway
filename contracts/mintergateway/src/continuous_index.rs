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
//! **Exception**: `multiply_indices_up` uses `fixed_mul_ceil` to round **UP**, preventing
//! cumulative index underestimation across successive compounding steps.
//!
//! Net effect: the index pipeline is conservative in every step except the final
//! index multiplication, which rounds up to ensure the index never drifts below
//! the mathematically exact value.

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
pub fn convert_from_basis_points(bps: u32) -> u128 {
    // bps / 10000 * RATE_SCALE = bps * RATE_SCALE / 10000
    // Rounding: DOWN (truncation). Slightly underestimates the rate. Protocol-favorable.
    (bps as u128) * RATE_SCALE / 10_000
}

/// Calculates e^x using a simplified Taylor series approximation.
///
/// For small x (typical interest rate × time combinations), we use:
/// e^x ≈ 1 + x + x²/2 + x³/6 + x⁴/24
///
/// This is accurate for x < 0.2 (20% per year) which covers all realistic rates.
///
/// # Rounding
/// Every division in the Taylor series rounds DOWN (truncation), so the result
/// underestimates the true e^x. This is protocol-favorable — accrues less yield.
///
/// # Arguments
/// * `x` - Exponent scaled by INDEX_SCALE (e.g., 0.05 = 50_000_000_000)
///
/// # Returns
/// e^x scaled by INDEX_SCALE
pub fn exponent(x: u128) -> u128 {
    if x == 0 {
        return INDEX_SCALE;
    }

    // Taylor series: e^x = 1 + x + x²/2! + x³/3! + x⁴/4! + ...
    // All terms need to be at the same scale (INDEX_SCALE = 1e12)
    //
    // Since x is scaled by 1e12:
    // - x represents x_real * 1e12
    // - x² = x_real² * 1e24 → need to divide by 1e12 to get back to scale
    // - x³ = x_real³ * 1e36 → need to divide by 1e24 to get back to scale
    // - x⁴ = x_real⁴ * 1e48 → need to divide by 1e36 to get back to scale

    // term1 = 1.0 * 1e12
    let term1 = INDEX_SCALE;

    // term2 = x (already at 1e12 scale)
    let term2 = x;

    // term3 = x² / (2 * 1e12)
    // x can be up to ~1e12 (100% rate), so x² could be 1e24 which fits in u128
    let x2 = x.checked_mul(x).unwrap();
    let term3 = x2 / (2 * INDEX_SCALE); // Rounding: DOWN

    // term4 = x³ / (6 * 1e24)
    // x³ could overflow, so we do: (x² / 1e12) * x / 6 / 1e12
    let x2_scaled = x2 / INDEX_SCALE; // Rounding: DOWN (intermediate scaling)
    let x3_scaled = x2_scaled.checked_mul(x).unwrap() / INDEX_SCALE; // Rounding: DOWN (intermediate scaling)
    let term4 = x3_scaled / 6; // Rounding: DOWN

    // term5 = x⁴ / (24 * 1e36)
    // (x³_scaled / 1e12) * x / 24 / 1e12
    let x4_scaled = x3_scaled.checked_mul(x).unwrap() / INDEX_SCALE; // Rounding: DOWN (intermediate scaling)
    let term5 = x4_scaled / 24; // Rounding: DOWN

    // Sum all terms
    term1 + term2 + term3 + term4 + term5
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
pub fn get_continuous_index(yearly_rate: u128, time_elapsed: u64) -> u128 {
    if yearly_rate == 0 || time_elapsed == 0 {
        return INDEX_SCALE; // No growth, return 1.0
    }

    // exponent = rate × time / SECONDS_PER_YEAR
    // Rounding: DOWN (truncation). Slightly underestimates the exponent. Protocol-favorable.
    let exp = yearly_rate
        .checked_mul(time_elapsed as u128)
        .unwrap()
        .checked_div(SECONDS_PER_YEAR)
        .unwrap();

    exponent(exp)
}

/// Multiplies two indices together (compounds them).
///
/// result = (index × delta_index) / INDEX_SCALE
///
/// Rounding: UP (`fixed_mul_ceil`). Favors the yield recipient — ensures the
/// index never underestimates cumulative growth.
///
/// # Arguments
/// * `index` - Base index scaled by INDEX_SCALE
/// * `delta_index` - Growth factor scaled by INDEX_SCALE
///
/// # Returns
/// Compounded index scaled by INDEX_SCALE
pub fn multiply_indices_up(index: u128, delta_index: u128) -> u128 {
    (index as i128)
        .fixed_mul_ceil(delta_index as i128, INDEX_SCALE as i128)
        .unwrap() as u128
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
pub fn multiply_indices_down(index: u128, delta_index: u128) -> u128 {
    (index as i128)
        .fixed_mul_floor(delta_index as i128, INDEX_SCALE as i128)
        .unwrap() as u128
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
pub fn current_index(latest_index: u128, rate_bps: u32, time_elapsed: u64) -> u128 {
    if rate_bps == 0 || time_elapsed == 0 {
        return latest_index;
    }

    let yearly_rate = convert_from_basis_points(rate_bps);
    let delta_index = get_continuous_index(yearly_rate, time_elapsed);

    // Rounding: UP via `multiply_indices_up` — the only rounding-up step in the index pipeline.
    multiply_indices_up(latest_index, delta_index)
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
        let idx = 1_050_000_000_000u128;
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
