//! Yield State Management
//!
//! Manages continuous compounding yield using an index-based approach.
//! The index represents cumulative growth: Index(t) = Index(t₀) × e^(r × Δt)
//!
//! Two accumulators track token supply:
//! - `total_principal`: yield-earning base (mints - burns, excludes claimed yield)
//! - `total_supply`: total outstanding tokens (principal + cumulative claimed yield)
//!
//! Yield accrues on `total_principal` only, not on `total_supply`.
//! This prevents compounding of claimed yield.
//!
//! # Rounding Policy
//!
//! Yield computation (`principal * index_delta / INDEX_SCALE`) rounds **DOWN** (truncation).
//! This is protocol-favorable — pays slightly less yield than mathematically exact.
//! See `continuous_index` module for the full rounding policy of the index pipeline.

use soroban_sdk::Env;

use crate::continuous_index::{self, INDEX_SCALE};
use crate::errors::YieldTokenError;
use crate::storage_types::{DataKey, YieldStateValue};

// =============================================================================
// Storage Access
// =============================================================================

pub fn read_yield_state(env: &Env) -> YieldStateValue {
    let key = DataKey::YieldState;
    env.storage()
        .instance()
        .get(&key)
        .unwrap_or(YieldStateValue::default())
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
pub fn get_current_index(env: &Env) -> u128 {
    let state = read_yield_state(env);
    let current_time = env.ledger().timestamp();

    if current_time <= state.last_update_timestamp {
        return state.latest_index;
    }

    let time_elapsed = current_time - state.last_update_timestamp;

    continuous_index::current_index(state.latest_index, state.rate_bps, time_elapsed)
}

/// Returns the stored (last updated) index.
pub fn get_latest_index(env: &Env) -> u128 {
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

/// Increases both total_principal and total_supply by the same amount.
/// Used by mint (direct SAC mint).
/// Must call update_index first to finalize yield at current principal.
pub fn increase_both_accumulators(env: &Env, amount: i128) {
    let mut state = read_yield_state(env);
    state.total_principal = state.total_principal.checked_add(amount).unwrap();
    state.total_supply = state.total_supply.checked_add(amount).unwrap();
    write_yield_state(env, &state);
}

/// Decreases both total_principal and total_supply by the same amount.
/// Used by burn.
/// Must call update_index first to finalize yield at current principal.
/// Returns error if amount exceeds total_principal — you cannot burn more than was minted.
pub fn decrease_both_accumulators(env: &Env, amount: i128) -> Result<(), YieldTokenError> {
    let mut state = read_yield_state(env);
    if amount > state.total_principal {
        return Err(YieldTokenError::BurnExceedsPrincipal);
    }
    state.total_principal = state.total_principal.checked_sub(amount).unwrap();
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
        let new_index = continuous_index::current_index(
            state.latest_index,
            state.rate_bps,
            current_time - state.last_update_timestamp,
        );

        // Accrue yield if there's principal and index grew
        if state.total_principal > 0 && new_index > state.latest_index {
            let index_delta = new_index - state.latest_index;

            // yield = principal × index_delta / INDEX_SCALE
            // Rounding: DOWN (truncation). Protocol-favorable — pays slightly less yield.
            let yield_amount = (state.total_principal as u128)
                .checked_mul(index_delta)
                .unwrap()
                .checked_div(INDEX_SCALE)
                .unwrap();

            state.accrued_yield = state
                .accrued_yield
                .checked_add(yield_amount as i128)
                .unwrap();
        }

        state.latest_index = new_index;
    }

    state.last_update_timestamp = current_time;
    write_yield_state(env, &state);
}

/// Returns the current accrued yield without updating state.
///
/// Includes both stored yield and pending yield from index growth.
pub fn get_accrued_yield(env: &Env) -> i128 {
    let state = read_yield_state(env);
    let current_time = env.ledger().timestamp();

    // Start with stored accrued yield
    let mut total_yield = state.accrued_yield;

    // Add pending yield from index growth (on principal only)
    if current_time > state.last_update_timestamp && state.total_principal > 0 && state.rate_bps > 0 {
        let new_index = continuous_index::current_index(
            state.latest_index,
            state.rate_bps,
            current_time - state.last_update_timestamp,
        );

        if new_index > state.latest_index {
            let index_delta = new_index - state.latest_index;
            // Rounding: DOWN (truncation). Protocol-favorable — same as update_index.
            let pending_yield = (state.total_principal as u128)
                .checked_mul(index_delta)
                .unwrap()
                .checked_div(INDEX_SCALE)
                .unwrap();

            total_yield = total_yield.checked_add(pending_yield as i128).unwrap();
        }
    }

    total_yield
}

// =============================================================================
// Rate Management
// =============================================================================

/// Sets the interest rate. Updates index first to finalize yield at old rate.
pub fn set_interest_rate(env: &Env, rate_bps: u32) -> Result<(), YieldTokenError> {
    if rate_bps > 10_000 {
        return Err(YieldTokenError::RateExceedsMax);
    }

    // First update index at the old rate
    update_index(env);

    // Then set the new rate
    let mut state = read_yield_state(env);
    state.rate_bps = rate_bps;
    write_yield_state(env, &state);
    Ok(())
}

/// Returns the current interest rate in basis points.
pub fn get_interest_rate(env: &Env) -> u32 {
    read_yield_state(env).rate_bps
}

// =============================================================================
// Yield Claims
// =============================================================================

/// Claims accrued yield and resets the accumulator.
///
/// Returns the amount claimed.
///
/// Note: This does NOT increase principal - claimed yield doesn't earn more yield.
pub fn claim_accrued_yield(env: &Env) -> i128 {
    // Update to capture latest yield
    update_index(env);

    let mut state = read_yield_state(env);
    let claimed = state.accrued_yield;
    state.accrued_yield = 0;
    write_yield_state(env, &state);

    claimed
}
