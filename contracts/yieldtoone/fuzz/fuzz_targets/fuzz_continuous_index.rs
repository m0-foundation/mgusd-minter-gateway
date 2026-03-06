#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

use yieldtoone::continuous_index::{
    convert_from_basis_points, current_index, exponent, get_continuous_index,
    multiply_indices_down, multiply_indices_up, INDEX_SCALE, SECONDS_PER_YEAR,
};

const MAX_TIME: u64 = 31_536_000 * 10; // 10 years

#[derive(Debug, Arbitrary)]
struct MathInput {
    rate_bps: u16,
    time_elapsed: u32,
    latest_index: u64,
    principal: u64,
}

fuzz_target!(|input: MathInput| {
    let rate_bps = (input.rate_bps as u32) % 10_001; // clamp to [0, 10000]
    let time_elapsed = (input.time_elapsed as u64) % (MAX_TIME + 1);
    let latest_index = INDEX_SCALE + (input.latest_index as u128) % (INDEX_SCALE * 100); // reasonable range
    let _principal = input.principal as i128;

    // Property 1: exponent never panics for realistic inputs
    let yearly_rate = convert_from_basis_points(rate_bps);
    if time_elapsed > 0 && yearly_rate > 0 {
        let exp_arg = yearly_rate
            .checked_mul(time_elapsed as u128)
            .and_then(|v| v.checked_div(SECONDS_PER_YEAR));
        if let Some(exp_arg) = exp_arg {
            if exp_arg <= INDEX_SCALE * 2 {
                // only test for exp <= 2.0 (realistic)
                let exp_result = exponent(exp_arg);
                // Property: exponent should be >= INDEX_SCALE (e^x >= 1 for x >= 0)
                assert!(
                    exp_result >= INDEX_SCALE,
                    "exponent({}) = {} < INDEX_SCALE",
                    exp_arg,
                    exp_result
                );
            }
        }
    }

    // Property 2: get_continuous_index is monotonically non-decreasing with time
    if rate_bps > 0 && time_elapsed > 1 {
        let half_time = time_elapsed / 2;
        let idx_half = get_continuous_index(yearly_rate, half_time);
        let idx_full = get_continuous_index(yearly_rate, time_elapsed);
        assert!(
            idx_full >= idx_half,
            "monotonicity violated: idx({}) = {} > idx({}) = {}",
            half_time,
            idx_half,
            time_elapsed,
            idx_full
        );
    }

    // Property 3: multiply_indices_up >= multiply_indices_down
    {
        let delta = get_continuous_index(yearly_rate, time_elapsed);
        let up = multiply_indices_up(latest_index, delta);
        let down = multiply_indices_down(latest_index, delta);
        assert!(
            up >= down,
            "up {} < down {} for index={}, delta={}",
            up,
            down,
            latest_index,
            delta
        );
    }

    // Property 4: current_index doesn't panic and is >= latest_index
    {
        let result = current_index(latest_index, rate_bps, time_elapsed);
        assert!(
            result >= latest_index,
            "current_index {} < latest_index {}",
            result,
            latest_index
        );
    }

    // Property 5: Two half-periods ~ one full period
    if rate_bps > 0 && time_elapsed > 1 {
        let half = time_elapsed / 2;
        let idx_half1 = current_index(latest_index, rate_bps, half);
        let idx_two_step = current_index(idx_half1, rate_bps, half);
        let idx_one_step = current_index(latest_index, rate_bps, half * 2);

        // Allow small rounding difference
        let diff = if idx_two_step > idx_one_step {
            idx_two_step - idx_one_step
        } else {
            idx_one_step - idx_two_step
        };
        // Tolerance: 0.001% of the result (10 ppm)
        let tolerance = idx_one_step / 100_000;
        assert!(
            diff <= tolerance.max(1),
            "two-step {} vs one-step {} diff {} exceeds tolerance {}",
            idx_two_step,
            idx_one_step,
            diff,
            tolerance
        );
    }
});
