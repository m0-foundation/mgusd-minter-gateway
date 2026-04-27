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
fn test_total_supply_increases_on_claim_yield() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);

    // total_supply = principal + claimed, total_principal unchanged
    assert_eq!(s.contract.total_principal(), principal);
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
fn test_total_supply_invariant() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);

    // Invariant: total_supply == total_principal + cumulative_claimed
    assert_eq!(
        s.contract.total_supply(),
        s.contract.total_principal() + claimed
    );
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

// Year-2 yield is computed against the (constant) nominal principal, not
// against principal-grown-by-prior-yield. This locks the canonical
// "no yield-on-yield compounding" property: claimed yield doesn't generate
// further yield.
#[test]
fn test_year_two_yield_uses_constant_nominal_principal() {
    let s = setup();
    let principal = 1_000_000 * DECIMALS;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    // Year 1
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let claimed_yr1 = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed_yr1 > 0);
    assert_eq!(s.contract.total_principal(), principal); // unchanged by claim

    let index_after_yr1 = s.contract.latest_index();

    // Year 2
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let claimed_yr2 = s.contract.claim_yield(&s.yield_recipient_manager);

    // The protocol-promised year-2 yield is principal × (index_yr2 - index_yr1).
    // If yield-on-yield compounding leaked in, the multiplicand would be
    // (principal + claimed_yr1) instead — a strictly larger number.
    let index_after_yr2 = s.contract.latest_index();
    let expected_yr2 = principal * (index_after_yr2 - index_after_yr1) / INDEX_SCALE;

    assert_eq!(
        claimed_yr2, expected_yr2,
        "year-2 yield must equal principal × index_delta — no compounding \
         from year-1's claim",
    );
}
