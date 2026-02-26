use super::setup::*;

// =============================================================================
// YIELD ACCRUAL TESTS
// =============================================================================

#[test]
fn test_yield_accrual_5pct_one_year() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_amount = s.contract.accrued_yield();
    // yield = 1M * (e^0.05 - 1) ~ 51,271.09 tokens
    assert_eq!(yield_amount, 512_710_937_490);
}

#[test]
fn test_yield_accrual_10pct_half_year() {
    let s = setup();
    let principal = 10_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &1000);

    advance_time(&s.env, (SECONDS_PER_YEAR / 2) as u64);

    let yield_amount = s.contract.accrued_yield();
    assert_eq!(yield_amount, 5_127_109_374);
}

#[test]
fn test_yield_zero_when_no_time_elapsed() {
    let s = setup();

    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    s.contract.set_rate(&s.minter, &500);

    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_yield_zero_when_no_rate() {
    let s = setup();

    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);

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
    let principal = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let balance_before = s.sac_token.balance(&s.yield_recipient);
    assert_eq!(balance_before, principal);

    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(claimed, 512_710_937_490);

    // Yield recipient now holds principal + claimed in SAC tokens
    let balance_after = s.sac_token.balance(&s.yield_recipient);
    assert_eq!(balance_after, principal + claimed);
}

#[test]
fn test_claim_yield_principal_unchanged() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    s.contract.claim_yield(&s.yield_recipient);

    // Principal unchanged — claimed yield does not earn more yield
    assert_eq!(s.contract.total_principal(), principal);
}

#[test]
fn test_claim_yield_resets_accrued() {
    let s = setup();

    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_000_0000000);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    assert!(s.contract.accrued_yield() > 0);

    s.contract.claim_yield(&s.yield_recipient);

    assert_eq!(s.contract.accrued_yield(), 0);
}

#[test]
fn test_claim_yield_with_zero_accrued() {
    let s = setup();

    // No principal, no rate, no time — claim returns 0
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(claimed, 0);
}

// =============================================================================
// YIELD NO-COMPOUNDING TEST
// =============================================================================

#[test]
fn test_yield_no_compounding() {
    let s = setup();
    let principal = 1_000_000_0000000i128;
    let half_year = (SECONDS_PER_YEAR / 2) as u64;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    // --- First half-year ---
    advance_time(&s.env, half_year);

    let first_claim = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(first_claim, 253_151_204_420);

    // Principal is still 1M
    assert_eq!(s.contract.total_principal(), principal);

    // --- Second half-year ---
    advance_time(&s.env, half_year);

    let second_claim = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(second_claim, 259_559_757_650);

    // Second claim is slightly larger than first because the index grew on a
    // higher base (index compounds), but it's only computed on the ORIGINAL
    // principal (1M), NOT on principal + first_claim.
    let if_compounded = (principal + first_claim) as u128
        * (s.contract.latest_index() - current_index(INDEX_SCALE, 500, half_year)) as u128
        / INDEX_SCALE;
    assert!((second_claim as u128) < if_compounded + 1);
    assert!(second_claim < first_claim + 10_000_0000000);
}

// =============================================================================
// MULTIPLE CLAIMS TEST
// =============================================================================

#[test]
fn test_multiple_claims_accumulate_correctly() {
    let s = setup();
    let principal = 100_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &1000);

    let quarter_year = (SECONDS_PER_YEAR / 4) as u64;
    let mut total_claimed = 0i128;

    for _ in 0..4 {
        advance_time(&s.env, quarter_year);
        let claimed = s.contract.claim_yield(&s.yield_recipient);
        assert!(claimed > 0);
        total_claimed += claimed;
    }

    let expected_one_shot_yield = (principal as u128)
        * (current_index(INDEX_SCALE, 1000, SECONDS_PER_YEAR as u64) - INDEX_SCALE) as u128
        / INDEX_SCALE;

    let diff = if total_claimed as u128 > expected_one_shot_yield {
        total_claimed as u128 - expected_one_shot_yield
    } else {
        expected_one_shot_yield - total_claimed as u128
    };
    let tolerance = expected_one_shot_yield / 10_000;
    assert!(
        diff < tolerance,
        "Multi-claim total {} vs one-shot {} diff {} exceeds tolerance {}",
        total_claimed,
        expected_one_shot_yield,
        diff,
        tolerance
    );
}

// =============================================================================
// RATE CHANGE MID-STREAM TEST
// =============================================================================

#[test]
fn test_rate_change_finalizes_yield_at_old_rate() {
    let s = setup();
    let principal = 1_000_000_0000000i128;
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

    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
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
    let one_million = 1_000_000_0000000i128;

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
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(claimed, 512_710_937_490);

    // Yield recipient token balance = 1M + claimed
    assert_eq!(s.sac_token.balance(&s.yield_recipient), one_million + claimed);

    // Step 5: total_principal unchanged, total_supply includes claimed
    assert_eq!(s.contract.total_principal(), one_million);
    assert_eq!(s.contract.total_supply(), one_million + claimed);
}

#[test]
fn test_no_yield_accrues_after_principal_zero() {
    let s = setup();
    let amount = 1_000_0000000i128;

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    s.contract.set_rate(&s.minter, &500);
    s.contract.burn(&s.minter, &s.yield_recipient, &amount);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // No principal means no yield
    assert_eq!(s.contract.accrued_yield(), 0);
}
