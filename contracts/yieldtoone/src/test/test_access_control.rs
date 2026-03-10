use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// ACCESS CONTROL — WRONG-ROLE REJECTION TESTS
// =============================================================================
//
// Comprehensive tests that every permissioned function rejects callers who hold
// the wrong role. Covers all functions that use `require_admin_or`.
//
// Note: Admin-only functions (set_admin, set_minter, set_yield_recipient_manager,
// set_forced_transfer_manager, freeze_account, unfreeze_account) use
// `require_admin` which calls `admin.require_auth()` directly. With mock_all_auths,
// Soroban's native auth always passes, so we cannot test wrong-role rejection for
// those functions in this manner. They are covered by Soroban's auth system.
//
// Pattern: try_<function>(&wrong_caller, ...) → Err(Ok(UnauthorizedError))

// =============================================================================
// MINT — admin or minter only
// =============================================================================

#[test]
fn test_yield_recipient_manager_cannot_mint() {
    let s = setup();

    let result = s
        .contract
        .try_mint(&s.yield_recipient_manager, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_mint() {
    let s = setup();

    let result = s
        .contract
        .try_mint(&s.yield_recipient, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_forced_transfer_manager_cannot_mint() {
    let s = setup();

    let result = s
        .contract
        .try_mint(&s.forced_transfer_manager, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_mint() {
    let s = setup();
    let random = Address::generate(&s.env);

    let result = s
        .contract
        .try_mint(&random, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

// =============================================================================
// BURN — admin or minter only
// =============================================================================

#[test]
fn test_yield_recipient_manager_cannot_burn() {
    let s = setup();

    let result = s
        .contract
        .try_burn(&s.yield_recipient_manager, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_burn() {
    let s = setup();

    let result = s
        .contract
        .try_burn(&s.yield_recipient, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_forced_transfer_manager_cannot_burn() {
    let s = setup();

    let result = s
        .contract
        .try_burn(&s.forced_transfer_manager, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_burn() {
    let s = setup();
    let random = Address::generate(&s.env);

    let result = s
        .contract
        .try_burn(&random, &s.yield_recipient, &1_000_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

// =============================================================================
// SET_RATE — admin or minter only
// =============================================================================

#[test]
fn test_yield_recipient_manager_cannot_set_rate() {
    let s = setup();

    let result = s
        .contract
        .try_set_rate(&s.yield_recipient_manager, &500);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_set_rate() {
    let s = setup();

    let result = s.contract.try_set_rate(&s.yield_recipient, &500);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_forced_transfer_manager_cannot_set_rate() {
    let s = setup();

    let result = s
        .contract
        .try_set_rate(&s.forced_transfer_manager, &500);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_set_rate() {
    let s = setup();
    let random = Address::generate(&s.env);

    let result = s.contract.try_set_rate(&random, &500);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

// =============================================================================
// CLAIM_YIELD — admin or yield_recipient only
// =============================================================================

#[test]
fn test_minter_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.minter);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_manager_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.yield_recipient_manager);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_forced_transfer_manager_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.forced_transfer_manager);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_claim_yield() {
    let s = setup();
    let random = Address::generate(&s.env);

    let result = s.contract.try_claim_yield(&random);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

// =============================================================================
// SET_YIELD_RECIPIENT — admin or yield_recipient_manager only
// =============================================================================

#[test]
fn test_minter_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&s.minter, &new_yr);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&s.yield_recipient, &new_yr);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_forced_transfer_manager_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&s.forced_transfer_manager, &new_yr);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_cannot_set_yield_recipient() {
    let s = setup();
    let random = Address::generate(&s.env);
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&random, &new_yr);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}
