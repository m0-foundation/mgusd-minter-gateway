//! Yield State Management
//!
//! Manages continuous compounding yield using an index-based approach.
//! The index represents cumulative growth: Index(t) = Index(t₀) × e^(r × Δt)
//!
//! Two accumulators track token supply:
//! - `total_principal`: yield-earning base in present-value terms (PV of mints - PV of burns)
//! - `total_supply`: total outstanding tokens (principal + cumulative claimed yield)
//!
//! Yield accrues on `total_principal` only, not on `total_supply`.
//! This prevents compounding of claimed yield.
//!
//! # Present Value Conversion
//!
//! When tokens are minted or burned, the nominal amount is converted to present
//! value before adjusting `total_principal`: `pv = amount × INDEX_SCALE / latest_index`.
//! This ensures principal is always denominated in "base index units", making yield
//! calculations correct regardless of when mints/burns occur relative to index growth.
//!
//! # Rounding Policy
//!
//! Unclaimed yield is derived on demand as
//! `floor(total_principal × current_index / INDEX_SCALE) − total_supply`, clamped at 0.
//! This keeps yield a pure function of the index and the accumulators, with one rounding
//! point. See `continuous_index` for the rounding policy of the index pipeline.

use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::Env;

use crate::continuous_index::{self, INDEX_SCALE};
use crate::errors::MinterGatewayError;
use crate::events::emit_update_index;
use crate::storage_types::{DataKey, YieldStateValue};

// =============================================================================
// Storage Access
// =============================================================================

pub fn read_yield_state(env: &Env) -> YieldStateValue {
    let key = DataKey::YieldState;
    env.storage().instance().get(&key).unwrap_or_default()
}

pub fn write_yield_state(env: &Env, state: &YieldStateValue) {
    let key = DataKey::YieldState;
    env.storage().instance().set(&key, state);
}

// =============================================================================
// Index Functions
// =============================================================================

/// Returns the current index without modifying state.
///
/// currentIndex = latestIndex × e^(rate × time_since_last_update)
///
/// This is a view function that calculates the real-time index.
pub fn get_current_index(env: &Env) -> i128 {
    let state = read_yield_state(env);
    let current_time = env.ledger().timestamp();

    if current_time <= state.last_update_timestamp {
        return state.latest_index;
    }

    let time_elapsed = current_time - state.last_update_timestamp;

    continuous_index::current_index(state.latest_index, state.rate_bps, time_elapsed)
}

/// Returns the stored (last updated) index.
pub fn get_latest_index(env: &Env) -> i128 {
    read_yield_state(env).latest_index
}

// =============================================================================
// Accumulator Management
// =============================================================================

/// Returns the current total_principal (tokens that earn yield).
pub fn get_total_principal(env: &Env) -> i128 {
    read_yield_state(env).total_principal
}

/// Returns the current total_supply (principal + cumulative claimed yield).
pub fn get_total_supply(env: &Env) -> i128 {
    read_yield_state(env).total_supply
}

/// Increases total_supply only (used by claim_yield — claimed yield doesn't earn more yield).
/// Must call update_index first.
pub fn increase_total_supply(env: &Env, amount: i128) {
    let mut state = read_yield_state(env);
    state.total_supply = state.total_supply.checked_add(amount).unwrap();
    write_yield_state(env, &state);
}

/// Increases both total_principal and total_supply.
/// Used by mint (direct SAC mint).
/// Must call update_index first to finalize yield at current principal.
///
/// `total_principal` is adjusted by the present value of the amount
/// (amount × INDEX_SCALE / latest_index), while `total_supply` is adjusted
/// by the nominal amount.
pub fn increase_both_accumulators(env: &Env, amount: i128) {
    let mut state = read_yield_state(env);
    let pv_amount = amount
        .fixed_mul_floor(INDEX_SCALE, state.latest_index)
        .unwrap();
    state.total_principal = state.total_principal.checked_add(pv_amount).unwrap();
    state.total_supply = state.total_supply.checked_add(amount).unwrap();
    write_yield_state(env, &state);
}

/// Decreases both total_principal and total_supply.
/// Used by burn.
/// Must call update_index first to finalize yield at current principal.
///
/// `total_principal` is adjusted by the present value of the amount
/// (amount × INDEX_SCALE / latest_index), while `total_supply` is adjusted
/// by the nominal amount. Returns error if PV amount exceeds total_principal.
pub fn decrease_both_accumulators(env: &Env, amount: i128) -> Result<(), MinterGatewayError> {
    let mut state = read_yield_state(env);
    let pv_amount = amount
        .fixed_mul_floor(INDEX_SCALE, state.latest_index)
        .unwrap();
    if pv_amount > state.total_principal {
        return Err(MinterGatewayError::BurnExceedsPrincipal);
    }

    state.total_principal = state.total_principal.checked_sub(pv_amount).unwrap();
    state.total_supply = state.total_supply.checked_sub(amount).unwrap();
    write_yield_state(env, &state);

    Ok(())
}

// =============================================================================
// Yield Accrual
// =============================================================================

/// Updates the index and accrues yield based on the index change.
///
/// Should be called before any operation that changes principal.
///
/// yield = principal × (new_index - old_index) / INDEX_SCALE
///
/// Note: Yield accrues on principal only, not on total_supply.
/// This prevents claimed yield from compounding.
pub fn update_index(env: &Env) {
    let mut state = read_yield_state(env);
    let current_time = env.ledger().timestamp();

    // Only update if time has passed
    if current_time > state.last_update_timestamp {
        let current_index = continuous_index::current_index(
            state.latest_index,
            state.rate_bps,
            current_time - state.last_update_timestamp,
        );

        // Emit only when the index actually changes — rate=0 advances the
        // timestamp without changing the value, and that's not worth an event.
        if current_index != state.latest_index {
            emit_update_index(env, current_index);
        }

        state.latest_index = current_index;
        state.last_update_timestamp = current_time;

        write_yield_state(env, &state);
    }
}

/// Returns the current accrued yield without updating state.
///
/// Includes both stored yield and pending yield from index growth.
pub fn get_accrued_yield(env: &Env) -> i128 {
    let state = read_yield_state(env);

    if state.total_principal == 0 {
        return 0;
    }

    let current_time = env.ledger().timestamp();

    let current_index = continuous_index::current_index(
        state.latest_index,
        state.rate_bps,
        current_time - state.last_update_timestamp,
    );

    // Rounding: DOWN (truncation). Protocol-favorable — same as update_index.
    let total_supply_with_yield = state
        .total_principal
        .fixed_mul_floor(current_index, INDEX_SCALE)
        .unwrap();

    // `pv_amount` floors at mint time, so `total_principal × latest_index / SCALE`
    // can be below `total_supply` by the floor residue and produce a small negative
    // result; yield is never negative, so clamp at 0.
    (total_supply_with_yield - state.total_supply).max(0)
}

// =============================================================================
// Rate Management
// =============================================================================

/// Sets the interest rate. Caller must call `update_index` first to finalize
/// yield at the old rate before invoking this.
pub fn set_interest_rate(env: &Env, rate_bps: u32) -> Result<(), MinterGatewayError> {
    if rate_bps > 10_000 {
        return Err(MinterGatewayError::RateExceedsMax);
    }

    let mut state = read_yield_state(env);
    state.rate_bps = rate_bps;
    write_yield_state(env, &state);

    Ok(())
}

/// Returns the current interest rate in basis points.
pub fn get_interest_rate(env: &Env) -> u32 {
    read_yield_state(env).rate_bps
}
