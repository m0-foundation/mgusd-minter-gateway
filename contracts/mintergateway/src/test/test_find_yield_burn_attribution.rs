//! Audit finding: off-path destruction of yield-origin tokens mis-attributes
//! principal.
//!
//! `burn` and `reconcile_burn` both route through `decrease_both_accumulators`,
//! which debits `total_principal` by `amount × INDEX_SCALE / latest_index`.
//! That is correct when the destroyed amount represents principal (created via
//! `mint`, which adds to PV). It is incorrect when the destroyed amount is
//! yield-origin (created via `claim_yield`, which adds only to supply, not to
//! PV). Debiting PV in the yield-origin case shrinks the cohort that earns
//! yield, permanently under-paying the yield recipient.
//!
//! These tests pin the bug as observable behavior.

use super::setup::*;

const RATE_5_PCT: u32 = 500;
const PRINCIPAL: i128 = 1_000_000 * DECIMALS;

/// Runs the baseline path (no destruction) and returns year-2 accrued yield.
/// Used as the control value for the destruction tests below.
fn baseline_year_two_accrued() -> i128 {
    let s = setup();
    s.contract.mint(&s.minter, &s.yield_recipient, &PRINCIPAL);
    s.contract.set_rate(&s.minter, &RATE_5_PCT);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    s.contract.claim_yield(&s.yield_recipient_manager);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // PV unchanged by claim_yield — only supply went up.
    assert_eq!(s.contract.total_principal(), PRINCIPAL);

    s.contract.accrued_yield()
}

/// Sanity-pin the baseline so the comparison tests have a stable control.
#[test]
fn baseline_no_destruction_year_two_accrued_is_positive() {
    let baseline = baseline_year_two_accrued();
    assert!(
        baseline > 0,
        "baseline year-2 accrued must be positive, got {baseline}"
    );
}

/// `reconcile_burn` of yield-origin tokens debits PV and shrinks future yield.
/// The destroyed tokens never contributed to PV, so debiting PV is wrong.
#[test]
fn reconcile_burn_of_yield_origin_under_pays_future_yield() {
    let baseline = baseline_year_two_accrued();

    let s = setup();
    s.contract.mint(&s.minter, &s.yield_recipient, &PRINCIPAL);
    s.contract.set_rate(&s.minter, &RATE_5_PCT);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(s.contract.total_principal(), PRINCIPAL);

    // Yield recipient destroys her yield-origin tokens off-path (sends to
    // SAC issuer). The minter wrapper is unaware until reconcile_burn runs.
    s.sac_token
        .transfer(&s.yield_recipient, &s.issuer, &claimed);

    s.contract.reconcile_burn(&claimed);

    // PV was debited even though only yield-origin tokens were destroyed —
    // the cohort that earns yield is now strictly smaller than before.
    assert!(
        s.contract.total_principal() < PRINCIPAL,
        "reconcile_burn debited PV when destroying yield-origin tokens: {} < {}",
        s.contract.total_principal(),
        PRINCIPAL,
    );

    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let after = s.contract.accrued_yield();

    assert!(
        after < baseline,
        "year-2 accrued after yield-origin reconcile_burn ({after}) is less \
         than baseline ({baseline}); under-pay of {}",
        baseline - after,
    );
}

/// `burn` (minter clawback) of yield-origin tokens has the same effect as
/// `reconcile_burn` because both call `decrease_both_accumulators` with
/// identical PV math.
#[test]
fn burn_of_yield_origin_under_pays_future_yield() {
    let baseline = baseline_year_two_accrued();

    let s = setup();
    s.contract.mint(&s.minter, &s.yield_recipient, &PRINCIPAL);
    s.contract.set_rate(&s.minter, &RATE_5_PCT);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(s.contract.total_principal(), PRINCIPAL);

    // Minter clawbacks the yield-origin tokens via burn().
    s.contract
        .burn(&s.minter, &s.yield_recipient, &claimed);

    assert!(
        s.contract.total_principal() < PRINCIPAL,
        "burn debited PV when clawing back yield-origin tokens: {} < {}",
        s.contract.total_principal(),
        PRINCIPAL,
    );

    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let after = s.contract.accrued_yield();

    assert!(
        after < baseline,
        "year-2 accrued after yield-origin burn ({after}) is less than \
         baseline ({baseline}); under-pay of {}",
        baseline - after,
    );
}

/// Confirms both paths produce identical accumulator state — the bug is in
/// the shared `decrease_both_accumulators` helper, not in either entrypoint
/// individually.
#[test]
fn burn_and_reconcile_burn_misattribute_identically() {
    let s_burn = setup();
    s_burn
        .contract
        .mint(&s_burn.minter, &s_burn.yield_recipient, &PRINCIPAL);
    s_burn.contract.set_rate(&s_burn.minter, &RATE_5_PCT);
    advance_time(&s_burn.env, SECONDS_PER_YEAR as u64);
    let claimed_b = s_burn
        .contract
        .claim_yield(&s_burn.yield_recipient_manager);
    s_burn
        .contract
        .burn(&s_burn.minter, &s_burn.yield_recipient, &claimed_b);

    let s_rec = setup();
    s_rec
        .contract
        .mint(&s_rec.minter, &s_rec.yield_recipient, &PRINCIPAL);
    s_rec.contract.set_rate(&s_rec.minter, &RATE_5_PCT);
    advance_time(&s_rec.env, SECONDS_PER_YEAR as u64);
    let claimed_r = s_rec
        .contract
        .claim_yield(&s_rec.yield_recipient_manager);
    s_rec
        .sac_token
        .transfer(&s_rec.yield_recipient, &s_rec.issuer, &claimed_r);
    s_rec.contract.reconcile_burn(&claimed_r);

    assert_eq!(claimed_b, claimed_r);
    assert_eq!(
        s_burn.contract.total_principal(),
        s_rec.contract.total_principal(),
        "PV after burn vs reconcile_burn should match (same shared math)",
    );
    assert_eq!(
        s_burn.contract.total_supply(),
        s_rec.contract.total_supply(),
        "supply after burn vs reconcile_burn should match",
    );
}
