use soroban_sdk::testutils::Address as _;

use super::setup::*;
use crate::events::{InterestRateSet, UpdateIndex, YieldClaimed};
use crate::gateway_events;

// =============================================================================
// YIELD ACCRUAL TESTS
// =============================================================================

#[test]
fn test_yield_accrual_5pct_one_year() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);
    s.assert_event(InterestRateSet { rate_bps: 500 });

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_amount = s.contract.accrued_yield();
    // yield = 1M * (e^0.05 - 1) ~ 51,271.09 tokens
    assert_eq!(yield_amount, 512_710_937_490);
}

#[test]
fn test_yield_accrual_10pct_half_year() {
    let s = setup();
    let principal = 10_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &1000);

    advance_time(&s.env, (SECONDS_PER_YEAR / 2) as u64);

    let yield_amount = s.contract.accrued_yield();
    assert_eq!(yield_amount, 5_127_109_374);
}

#[test]
fn test_yield_zero_when_no_time_elapsed() {
    let s = setup();

    s.contract
        .mint(&s.minter, &s.yield_recipient, &(1_000 * DECIMALS));
    s.contract.set_rate(&s.minter, &500);

    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_yield_zero_when_no_rate() {
    let s = setup();

    s.contract
        .mint(&s.minter, &s.yield_recipient, &(1_000 * DECIMALS));

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_yield_zero_when_no_principal() {
    let s = setup();

    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    assert_eq!(s.contract.accrued_yield(), 0);
}

// =============================================================================
// CLAIM YIELD TESTS
// =============================================================================

#[test]
fn test_claim_yield_mints_tokens_to_yield_recipient() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let balance_before = s.sac_token.balance(&s.yield_recipient);
    assert_eq!(balance_before, principal);

    // current_index() reports the live index that update_index inside
    // claim_yield will persist and emit.
    let expected_latest_index = s.contract.current_index();

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);

    // Time advanced since the last update, so claim_yield emits UpdateIndex
    // first, then YieldClaimed.
    s.assert_events_tail(&gateway_events![
        s,
        UpdateIndex {
            latest_index: expected_latest_index
        },
        YieldClaimed {
            recipient: s.yield_recipient.clone(),
            amount: claimed,
        },
    ]);

    assert_eq!(claimed, 512_710_937_490);

    // Yield recipient now holds principal + claimed in SAC tokens
    let balance_after = s.sac_token.balance(&s.yield_recipient);
    assert_eq!(balance_after, principal + claimed);
}

#[test]
fn test_claim_yield_grows_principal_by_claimed_amount() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);

    // Under compounding, claimed yield is rolled into total_principal so
    // the recipient's tokens earn yield from the next index update.
    assert_eq!(s.contract.total_principal(), principal + claimed);
}

#[test]
fn test_claim_yield_resets_accrued() {
    let s = setup();

    s.contract
        .mint(&s.minter, &s.yield_recipient, &(1_000_000 * DECIMALS));
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    assert!(s.contract.accrued_yield() > 0);

    s.contract.claim_yield(&s.yield_recipient_manager);

    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_claim_yield_with_zero_accrued() {
    let s = setup();

    // No principal, no rate, no time — claim returns 0
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(claimed, 0);

    // No events emitted: rate=0 keeps the index unchanged so UpdateIndex
    // skips, and claim_yield's guard blocks YieldClaimed when
    // unclaimed_yield == 0.
    s.assert_no_events();
}

// =============================================================================
// YIELD COMPOUNDING TEST
// =============================================================================

#[test]
fn test_yield_compounds_after_claim() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;
    let half_year = (SECONDS_PER_YEAR / 2) as u64;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    // --- First half-year ---
    advance_time(&s.env, half_year);

    let first_claim = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(first_claim, 253_151_204_420);

    // Claim folds into principal: total_principal = original + first_claim.
    assert_eq!(s.contract.total_principal(), principal + first_claim);

    let index_after_first_claim = s.contract.latest_index();

    // --- Second half-year ---
    advance_time(&s.env, half_year);

    let second_claim = s.contract.claim_yield(&s.yield_recipient_manager);

    // Year-2 yield is computed on `principal + first_claim`, not on the
    // original principal. The compound result equals
    //   (principal + first_claim) × (idx_after_yr2 - idx_after_yr1) / SCALE.
    let index_after_second_claim = s.contract.latest_index();
    let expected_compound = (principal + first_claim)
        * (index_after_second_claim - index_after_first_claim)
        / INDEX_SCALE;
    let simple_interest_baseline = principal
        * (index_after_second_claim - index_after_first_claim)
        / INDEX_SCALE;

    assert_eq!(
        second_claim, expected_compound,
        "year-2 claim must compound on the year-1 claim",
    );
    assert!(
        second_claim > simple_interest_baseline,
        "compound year-2 must strictly exceed simple-interest baseline",
    );
}

// =============================================================================
// MULTIPLE CLAIMS TEST
// =============================================================================

#[test]
fn test_multiple_claims_accumulate_correctly() {
    let s = setup();
    let principal = 100_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &1000);

    let quarter_year = (SECONDS_PER_YEAR / 4) as u64;
    let mut total_claimed = 0i128;
    let mut prior_principal = principal;

    for _ in 0..4 {
        advance_time(&s.env, quarter_year);
        let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
        assert!(claimed > 0);

        // Each claim is folded back into total_principal so subsequent
        // quarters compound.
        assert_eq!(s.contract.total_principal(), prior_principal + claimed);
        prior_principal += claimed;

        total_claimed += claimed;
    }

    // Under compounding the four-quarter total exceeds the simple-interest
    // baseline (single annual claim against the original principal).
    let simple_interest_baseline = principal
        * (current_index(INDEX_SCALE, 1000, SECONDS_PER_YEAR as u64) - INDEX_SCALE)
        / INDEX_SCALE;
    assert!(
        total_claimed > simple_interest_baseline,
        "compound multi-claim total {} must exceed simple-interest baseline {}",
        total_claimed,
        simple_interest_baseline,
    );

    // And the compounding pickup is bounded — at 10%/yr over 1 year the
    // gap between continuous and quarterly compounding is well under 5%.
    let upper_bound = simple_interest_baseline + simple_interest_baseline / 20; // +5%
    assert!(
        total_claimed < upper_bound,
        "compound multi-claim total {} should not exceed simple baseline {} \
         by more than 5% (got upper bound {})",
        total_claimed,
        simple_interest_baseline,
        upper_bound,
    );
}

// =============================================================================
// RATE CHANGE MID-STREAM TEST
// =============================================================================

#[test]
fn test_rate_change_finalizes_yield_at_old_rate() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;
    let half_year = (SECONDS_PER_YEAR / 2) as u64;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, half_year);

    let yield_before_change = s.contract.accrued_yield();
    assert_eq!(yield_before_change, 253_151_204_420);

    // Change rate to 10% — finalizes yield at 5%
    s.contract.set_rate(&s.minter, &1000);

    assert_eq!(s.contract.accrued_yield(), yield_before_change);

    advance_time(&s.env, half_year);

    let total_yield = s.contract.accrued_yield();
    assert!(total_yield > yield_before_change);

    let second_half_yield = total_yield - yield_before_change;
    assert!(second_half_yield > yield_before_change);
}

#[test]
fn test_set_rate_noop_when_unchanged() {
    let s = setup();

    s.contract
        .mint(&s.minter, &s.yield_recipient, &(1_000 * DECIMALS));
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_before = s.contract.accrued_yield();
    s.contract.set_rate(&s.minter, &500);
    assert_eq!(s.contract.accrued_yield(), yield_before);
}

// =============================================================================
// KEY TEST FLOW — 1M mint, 5% rate, 1 year, claim yield
// =============================================================================

#[test]
fn test_full_flow_mint_rate_claim() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    // Step 1: Mint 1M SAC tokens directly to yield_recipient
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    assert_eq!(s.contract.total_principal(), one_million);
    assert_eq!(s.contract.total_supply(), one_million);
    assert_eq!(s.sac_token.balance(&s.yield_recipient), one_million);

    // Step 2: Set rate to 5%
    s.contract.set_rate(&s.minter, &500);

    // Step 3: Advance 1 year
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Step 4: Claim yield — yield_recipient gets ~51,271 new tokens
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(claimed, 512_710_937_490);

    // Yield recipient token balance = 1M + claimed
    assert_eq!(
        s.sac_token.balance(&s.yield_recipient),
        one_million + claimed
    );

    // Step 5: claim folds into principal — both accumulators include claimed
    assert_eq!(s.contract.total_principal(), one_million + claimed);
    assert_eq!(s.contract.total_supply(), one_million + claimed);
}

#[test]
fn test_no_yield_accrues_after_principal_zero() {
    let s = setup();
    let amount = 1_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    s.contract.set_rate(&s.minter, &500);
    s.contract.burn(&s.minter, &s.yield_recipient, &amount);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // No principal means no yield
    assert_eq!(s.contract.accrued_yield(), 0);
}

// =============================================================================
// STEL1-2 — burn-before-claim leaves PV of accrued yield in total_principal,
// which keeps generating phantom yield after the position has fully exited.
// =============================================================================
//
// Regression tests for the audit finding STEL1-2. The shared pattern:
//
//   1. mint N
//   2. set rate, advance 1 year (index grows; accrued yield is now non-zero)
//   3. burn / reconcile the full nominal N         <-- bug enters here
//   4. claim_yield
//   5. advance another year
//
// After step 5 nothing should be left to claim — every minted token has either
// been burned or already claimed as yield. With the current accumulator math,
// `decrease_both_accumulators` only subtracts `pv_burn = N * SCALE / index`
// from `total_principal`, leaving the present-value of the yet-unclaimed yield
// stranded inside `total_principal`. `claim_yield` then increments
// `total_supply` without ever touching `total_principal`, so the residue keeps
// compounding on every subsequent index update — an over-mint to the yield
// recipient against principal that no longer exists.

// One-year-at-5% claim against `1_000 * DECIMALS` of principal. The math
// matches `test_full_flow_mint_rate_claim` (which uses 1_000_000 * DECIMALS
// and gets 512_710_937_490) scaled down by 1_000×.
const ONE_YEAR_YIELD_ON_1K: i128 = 512_710_937;

// Under the canonical (nominal-principal) model there is no PV ↔ nominal
// conversion in mint/burn, so a full nominal exit drives `total_principal` to
// exactly zero — no rounding residue at the burn boundary. The tests assert
// strict equality.

#[test]
fn test_burn_before_claim_leaves_no_phantom_yield() {
    let s = setup();
    let amount = 1_000 * DECIMALS;

    // -----------------------------------------------------------------------
    // Step 1: mint N → both accumulators at N (PV=nominal at index 1.0)
    // -----------------------------------------------------------------------
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    s.contract.set_rate(&s.minter, &500);
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);

    // -----------------------------------------------------------------------
    // Step 2: Index grows for a year. No state-mutating call → accumulators
    // unchanged; only `accrued_yield` (a derived view) reflects the growth.
    // -----------------------------------------------------------------------
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Pre-burn state: stored accumulators still at the post-mint values
    // (`update_index` only fires on state-mutating ops), but the derived
    // `accrued_yield` has caught up to one year of growth.
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
    assert_eq!(s.contract.accrued_yield(), ONE_YEAR_YIELD_ON_1K);

    // -----------------------------------------------------------------------
    // Step 3: burn the entire nominal supply. Position is fully exited.
    //
    // Expected post-burn (any correct fix):
    //   total_supply    == 0                       (exact — burn subtracts nominal)
    //   total_principal <= 1                       (≤1 wei floor residue)
    //   accrued_yield   == ONE_YEAR_YIELD_ON_1K    (still owed to recipient)
    //
    // Current buggy behaviour: total_principal = 487_705_732 (the PV of the
    // accrued-but-unclaimed yield, stranded inside the principal accumulator).
    // -----------------------------------------------------------------------
    s.contract.burn(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(
        s.contract.total_supply(),
        0,
        "after full nominal burn, total_supply should be exactly 0",
    );
    assert_eq!(
        s.contract.total_principal(),
        0,
        "STEL1-2: after a full nominal burn the canonical model leaves \
         total_principal at exactly 0 — no PV residue",
    );
    assert_eq!(
        s.contract.accrued_yield(),
        ONE_YEAR_YIELD_ON_1K,
        "yield accrued during year 1 must still be owed to the recipient \
         after the user exits — the burn shouldn't destroy it",
    );

    // -----------------------------------------------------------------------
    // Step 4: claim_yield mints the year-1 yield to the recipient. Under
    // compounding, the claimed amount folds into total_principal so the
    // recipient's tokens earn yield from the next index update.
    //
    // Expected post-claim:
    //   total_supply    == ONE_YEAR_YIELD_ON_1K
    //   total_principal == ONE_YEAR_YIELD_ON_1K   (claim folded in)
    //   accrued_yield   == 0                      (bucket drained)
    // -----------------------------------------------------------------------
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(claimed, ONE_YEAR_YIELD_ON_1K);

    assert_eq!(s.contract.total_supply(), ONE_YEAR_YIELD_ON_1K);
    assert_eq!(s.contract.total_principal(), ONE_YEAR_YIELD_ON_1K);
    assert_eq!(s.contract.accrued_yield(), 0);

    let index_after_claim = s.contract.latest_index();

    // -----------------------------------------------------------------------
    // Step 5: time advances another year. The original user is fully exited,
    // but the recipient's claimed tokens (now in total_principal) legitimately
    // compound. STEL1-2 is fixed structurally — no PV residue from the burn
    // re-enters the picture; the only yield-earning base is the recipient's
    // own balance.
    // -----------------------------------------------------------------------
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    assert_eq!(
        s.contract.total_principal(),
        ONE_YEAR_YIELD_ON_1K,
        "principal stays at the recipient's claimed balance — no phantom \
         residue from the original burn",
    );
    let index_after_year2 = s.contract.current_index();
    let expected_compound = ONE_YEAR_YIELD_ON_1K
        * (index_after_year2 - index_after_claim)
        / INDEX_SCALE;
    assert_eq!(
        s.contract.accrued_yield(),
        expected_compound,
        "year-2 yield is legitimate compound interest on the recipient's \
         claimed balance — not the STEL1-2 phantom",
    );
}

#[test]
fn test_reconcile_burn_before_claim_leaves_no_phantom_yield() {
    let s = setup();
    let user = soroban_sdk::Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    // Step 1: mint N to a non-issuer holder so the SAC transfer path works.
    s.contract.unblock_user(&user, &s.blocker);
    s.contract.mint(&s.minter, &user, &amount);
    s.contract.set_rate(&s.minter, &500);
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);

    // Step 2: a year of yield accrues before the admin reconciles.
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Pre-reconcile state — same shape as the burn() test. Accumulators
    // unchanged from mint time, derived yield reflects one year of growth.
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
    assert_eq!(s.contract.accrued_yield(), ONE_YEAR_YIELD_ON_1K);

    // Step 3: the documented `reconcile_burn` flow — user destroys the
    // nominal balance by transferring it to the issuer, then admin
    // reconciles the accumulators. Both `burn` and `reconcile_burn` go
    // through `decrease_principal` + `decrease_total_supply` (nominal).
    s.sac_token.transfer(&user, &s.issuer, &amount);
    s.contract.reconcile_burn(&amount);

    assert_eq!(s.contract.total_supply(), 0);
    assert_eq!(
        s.contract.total_principal(),
        0,
        "STEL1-2: after a full nominal reconcile_burn the canonical model \
         leaves total_principal at exactly 0 — no PV residue",
    );
    assert_eq!(s.contract.accrued_yield(), ONE_YEAR_YIELD_ON_1K);

    // Step 4: claim_yield pays out the year-1 yield. Under compounding,
    // the claimed amount folds into total_principal.
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert_eq!(claimed, ONE_YEAR_YIELD_ON_1K);

    assert_eq!(s.contract.total_supply(), ONE_YEAR_YIELD_ON_1K);
    assert_eq!(s.contract.total_principal(), ONE_YEAR_YIELD_ON_1K);
    assert_eq!(s.contract.accrued_yield(), 0);

    let index_after_claim = s.contract.latest_index();

    // Step 5: time advances. The user is fully exited; the recipient's
    // claimed tokens compound legitimately. No PV phantom from reconcile.
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    assert_eq!(
        s.contract.total_principal(),
        ONE_YEAR_YIELD_ON_1K,
        "principal stays at the recipient's claimed balance — no phantom \
         residue from reconcile_burn",
    );
    let index_after_year2 = s.contract.current_index();
    let expected_compound = ONE_YEAR_YIELD_ON_1K
        * (index_after_year2 - index_after_claim)
        / INDEX_SCALE;
    assert_eq!(
        s.contract.accrued_yield(),
        expected_compound,
        "year-2 yield is legitimate compound interest on the recipient's \
         claimed balance — not the STEL1-2 phantom",
    );
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_set_rate_reverts_without_caller_auth() {
    let s = setup_no_mock_auth();
    let result = s.contract.try_set_rate(&s.minter, &500);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_claim_yield_reverts_without_caller_auth() {
    let s = setup_no_mock_auth();
    let result = s.contract.try_claim_yield(&s.yield_recipient_manager);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

// =============================================================================
// ACCESS CONTROL — SET_RATE (admin or minter only)
// =============================================================================

#[test]
fn test_yield_recipient_manager_cannot_set_rate() {
    let s = setup();

    let result = s.contract.try_set_rate(&s.yield_recipient_manager, &500);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_yield_recipient_cannot_set_rate() {
    let s = setup();

    let result = s.contract.try_set_rate(&s.yield_recipient, &500);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_forced_transfer_manager_cannot_set_rate() {
    let s = setup();

    let result = s.contract.try_set_rate(&s.forced_transfer_manager, &500);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_random_cannot_set_rate() {
    let s = setup();
    let random = Address::generate(&s.env);

    let result = s.contract.try_set_rate(&random, &500);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

// =============================================================================
// ACCESS CONTROL — CLAIM_YIELD (yield_recipient_manager only)
// =============================================================================

#[test]
fn test_minter_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.minter);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_yield_recipient_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.yield_recipient);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_forced_transfer_manager_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.forced_transfer_manager);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_random_cannot_claim_yield() {
    let s = setup();
    let random = Address::generate(&s.env);

    let result = s.contract.try_claim_yield(&random);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}
