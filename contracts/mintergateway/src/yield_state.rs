//! Yield state — continuous compounding via `Index(t) = Index(t₀) × e^(r·Δt)`.
//!
//! Three nominal accumulators:
//! - `total_principal`: yield-earning base. Mutated by `mint` / `burn` /
//!   `reconcile_burn` (nominal +/-) and by `claim_yield` (claimed amount
//!   joins principal so it compounds from the next index update).
//!   Never touched by `update_index` itself.
//! - `accrued_yield`: stored bucket. `update_index` adds
//!   `principal × index_delta / INDEX_SCALE` (floored, protocol-favorable).
//!   `claim_yield` drains it.
//! - `total_supply`: circulating-supply counter for events and the
//!   `BurnExceedsSupply` guard. Held in lockstep with `total_principal`
//!   under the compounding model — kept as a separate field for now to
//!   preserve event payload schema.
//!
//! Storing principal nominally (rather than as `amount × INDEX_SCALE / index`)
//! is what fixes audit finding STEL1-2: under the PV form, burning after
//! yield accrual stranded PV inside `total_principal` and compounded into
//! phantom yield. Nominal form makes `burn(N)` drive principal to exactly
//! zero, so `principal × index_delta = 0` afterward.

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
//
// `total_principal` and `total_supply` live in the same `YieldStateValue`
// struct, so paired mutations share a single read/write. The helpers below
// mutate them together when callers require lockstep (mint/burn/reconcile)
// and only touch `total_supply` for the one asymmetric path: `claim_yield`.

/// Returns the current `total_principal` (nominal yield-earning tokens).
pub fn get_total_principal(env: &Env) -> i128 {
    read_yield_state(env).total_principal
}

/// Returns the nominal `total_supply` counter.
pub fn get_total_supply(env: &Env) -> i128 {
    read_yield_state(env).total_supply
}

/// Bumps both accumulators by a nominal amount; returns the post-mutation
/// state. Call `update_index` first.
pub fn increase_both_accumulators(env: &Env, amount: i128) -> YieldStateValue {
    let mut state = read_yield_state(env);
    state.total_principal = state.total_principal.checked_add(amount).unwrap();
    state.total_supply = state.total_supply.checked_add(amount).unwrap();
    write_yield_state(env, &state);
    state
}

/// Drops both accumulators by a nominal amount, guarded by
/// `BurnExceedsPrincipal`; returns the post-mutation state. Call
/// `update_index` first.
pub fn decrease_both_accumulators(
    env: &Env,
    amount: i128,
) -> Result<YieldStateValue, MinterGatewayError> {
    let mut state = read_yield_state(env);
    if amount > state.total_principal {
        return Err(MinterGatewayError::BurnExceedsPrincipal);
    }

    state.total_principal = state.total_principal.checked_sub(amount).unwrap();
    state.total_supply = state.total_supply.checked_sub(amount).unwrap();
    write_yield_state(env, &state);

    Ok(state)
}

// =============================================================================
// Yield Accrual
// =============================================================================

/// Updates the index and accrues yield into the stored bucket.
///
/// Should be called before any operation that changes principal or rate.
///
///   yield_slice = principal × (current_index − latest_index) / INDEX_SCALE
///   accrued_yield += yield_slice
///
/// Crucially, `total_principal` is *not* mutated here. The principal stays
/// at its nominal value (only mint/burn change it), and the new yield is
/// recorded in `accrued_yield` so future updates do not compound it.
pub fn update_index(env: &Env) {
    let mut state = read_yield_state(env);
    let current_time = env.ledger().timestamp();

    // Nothing to do if time hasn't advanced (same ledger, repeat call).
    if current_time <= state.last_update_timestamp {
        return;
    }

    let current_index = continuous_index::current_index(
        state.latest_index,
        state.rate_bps,
        current_time - state.last_update_timestamp,
    );

    // Emit only when the index value actually changed. rate=0 keeps the
    // index flat even as the timestamp advances — that's not event-worthy.
    if current_index > state.latest_index {
        // Rounding: DOWN (truncation). Protocol-favorable.
        // no-op when principal = 0
        let yield_slice = state
            .total_principal
            .checked_mul(current_index - state.latest_index)
            .unwrap()
            .checked_div(INDEX_SCALE)
            .unwrap();
        state.accrued_yield = state.accrued_yield.checked_add(yield_slice).unwrap();

        emit_update_index(env, current_index);
        state.latest_index = current_index;
    }

    state.last_update_timestamp = current_time;
    write_yield_state(env, &state);
}

/// Returns the current accrued yield (stored bucket plus any pending slice
/// since the last `update_index`). View-only — does not mutate state.
pub fn get_accrued_yield(env: &Env) -> i128 {
    let state = read_yield_state(env);
    let mut total = state.accrued_yield;

    if state.total_principal == 0 || state.rate_bps == 0 {
        return total;
    }

    let current_time = env.ledger().timestamp();
    if current_time <= state.last_update_timestamp {
        return total;
    }

    let current_index = continuous_index::current_index(
        state.latest_index,
        state.rate_bps,
        current_time - state.last_update_timestamp,
    );

    if current_index > state.latest_index {
        let index_delta = current_index - state.latest_index;
        let pending = state
            .total_principal
            .checked_mul(index_delta)
            .unwrap()
            .checked_div(INDEX_SCALE)
            .unwrap();
        total = total.checked_add(pending).unwrap();
    }

    total
}

/// Atomic claim path: drains the stored `accrued_yield` bucket and bumps
/// both `total_principal` and `total_supply` by the claimed amount.
/// Returns the amount claimed.
///
/// Adding the claimed amount to `total_principal` is what makes claimed
/// yield itself earn yield from the next `update_index` onward (compound
/// interest). Caller must call `update_index` first to flush any pending
/// slice into the bucket before draining.
///
/// Skips the storage write entirely when the bucket is empty.
pub fn claim_accrued_yield(env: &Env) -> i128 {
    let mut state = read_yield_state(env);
    let claimed = state.accrued_yield;
    if claimed == 0 {
        return 0;
    }
    state.accrued_yield = 0;
    state.total_principal = state.total_principal.checked_add(claimed).unwrap();
    state.total_supply = state.total_supply.checked_add(claimed).unwrap();
    write_yield_state(env, &state);
    claimed
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
