use super::setup::*;

// =============================================================================
// TOTAL SUPPLY / PRINCIPAL ACCUMULATOR TESTS
// =============================================================================

#[test]
fn test_total_supply_increases_on_mint() {
    let s = setup();
    let amount = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_claim_yield_grows_both_accumulators() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);

    // Under compounding, claimed yield joins principal, so both accumulators
    // grow by the same nominal amount and stay in lockstep.
    assert_eq!(s.contract.total_principal(), principal + claimed);
    assert_eq!(s.contract.total_supply(), principal + claimed);
}

#[test]
fn test_burn_decreases_both_accumulators() {
    let s = setup();
    let amount = 1_000_000 * DECIMALS;
    let burn = 400_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);

    s.contract.burn(&s.minter, &s.yield_recipient, &burn);

    assert_eq!(s.contract.total_principal(), amount - burn);
    assert_eq!(s.contract.total_supply(), amount - burn);
}

#[test]
fn test_total_supply_equals_total_principal_invariant() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);

    // Invariant under compounding: total_supply == total_principal at every
    // observable state. Mint, burn, reconcile, and claim all move the two
    // accumulators by the same nominal amount.
    assert_eq!(s.contract.total_supply(), s.contract.total_principal());
}

// =============================================================================
// PRINCIPAL ACCUMULATOR — NOMINAL FORM (canonical)
//
// total_principal stores nominal yield-earning principal:
//   on mint:  principal += amount        (nominal, no index conversion)
//   on burn:  principal -= amount        (nominal, no index conversion)
//
// update_index never mutates total_principal — it accumulates yield into
// the stored `accrued_yield` bucket instead. claim_yield drains the bucket
// without touching principal.
//
// An earlier design stored principal in present-value form and left
// stranded PV in the accumulator after burn-before-claim, compounding into
// phantom yield. See audit finding STEL1-2.
// =============================================================================

#[test]
fn test_mint_after_index_growth_stores_nominal_principal() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500); // 5%
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Second mint triggers update_index (which buckets yield) then adds nominal.
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

    assert!(
        s.contract.latest_index() > INDEX_SCALE,
        "index should have grown above 1.0"
    );

    // Mint adds nominal — no PV conversion. Two 1M mints → 2M principal,
    // independent of the index at mint time.
    assert_eq!(
        s.contract.total_principal(),
        2 * one_million,
        "total_principal should be a nominal sum, not PV-discounted",
    );
}

#[test]
fn test_burn_after_index_growth_subtracts_nominal_principal() {
    let s = setup();
    let two_million = 2_000_000 * DECIMALS;
    let burn_amount = 500_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &two_million);
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    s.contract.burn(&s.minter, &s.yield_recipient, &burn_amount);

    assert!(s.contract.latest_index() > INDEX_SCALE);

    // Burn subtracts nominal — no PV conversion. The 487M-unit phantom-PV
    // residue from the earlier design must not appear here.
    assert_eq!(
        s.contract.total_principal(),
        two_million - burn_amount,
        "total_principal after burn should be nominal — no PV residue",
    );
}

#[test]
fn test_sequential_mints_at_different_indices_accumulate_nominally() {
    let s = setup();
    let one_million = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    s.contract.mint(&s.minter, &s.yield_recipient, &one_million);

    // Three nominal mints of 1M each → 3M principal, regardless of the
    // index at each mint instant.
    assert_eq!(
        s.contract.total_principal(),
        3 * one_million,
        "sequential mints accumulate nominally; index growth between mints \
         doesn't shrink contributions",
    );
}

// Year-2 yield is computed against (principal + year-1 claim), because
// claim_yield rolls the claimed amount into total_principal so it earns
// further yield. This locks the compounding semantics: claimed yield
// itself accrues from the next index update.
#[test]
fn test_year_two_yield_compounds_on_prior_claim() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    // Year 1
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let claimed_yr1 = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed_yr1 > 0);
    // Claim folded into principal — the recipient's tokens now earn yield.
    assert_eq!(s.contract.total_principal(), principal + claimed_yr1);

    let index_after_yr1 = s.contract.latest_index();

    // Year 2
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let claimed_yr2 = s.contract.claim_yield(&s.yield_recipient_manager);

    // Year-2 yield is computed on the post-year-1 principal base, which
    // now includes the year-1 claim. The simple-interest baseline (yield
    // only on the original `principal`) is strictly smaller.
    let index_after_yr2 = s.contract.latest_index();
    let expected_yr2 =
        (principal + claimed_yr1) * (index_after_yr2 - index_after_yr1) / INDEX_SCALE;
    let simple_interest_yr2 = principal * (index_after_yr2 - index_after_yr1) / INDEX_SCALE;

    assert_eq!(
        claimed_yr2, expected_yr2,
        "year-2 yield must equal (principal + claimed_yr1) × index_delta — \
         compounding on the prior claim",
    );
    assert!(
        claimed_yr2 > simple_interest_yr2,
        "compound year-2 must strictly exceed simple-interest baseline",
    );
}
