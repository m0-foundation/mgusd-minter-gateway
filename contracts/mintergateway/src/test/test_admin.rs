use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// ROLE GETTERS — verify initial state
// =============================================================================

#[test]
fn test_forced_transfer_manager_view() {
    let s = setup();
    assert_eq!(
        s.contract.forced_transfer_manager(),
        s.forced_transfer_manager
    );
}

#[test]
fn test_blocker_view() {
    let s = setup();
    assert_eq!(s.contract.blocker(), s.blocker);
}

// =============================================================================
// ROLE SETTERS — happy-path mutations
// =============================================================================

#[test]
fn test_set_admin() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.contract.set_admin(&new_admin);
    assert_eq!(s.contract.admin(), new_admin);
}

#[test]
fn test_set_minter() {
    let s = setup();
    let new_minter = Address::generate(&s.env);

    s.contract.set_minter(&new_minter);
    assert_eq!(s.contract.minter(), new_minter);
}

#[test]
fn test_set_yield_recipient_manager() {
    let s = setup();
    let new_yrm = Address::generate(&s.env);

    s.contract.set_yield_recipient_manager(&new_yrm);
    assert_eq!(s.contract.yield_recipient_manager(), new_yrm);
}

#[test]
fn test_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    s.contract
        .set_yield_recipient(&s.yield_recipient_manager, &new_yr);
    assert_eq!(s.contract.yield_recipient(), new_yr);
}

#[test]
fn test_set_forced_transfer_manager() {
    let s = setup();
    let new_ftm = Address::generate(&s.env);

    assert_eq!(
        s.contract.forced_transfer_manager(),
        s.forced_transfer_manager
    );

    s.contract.set_forced_transfer_manager(&new_ftm);
    assert_eq!(s.contract.forced_transfer_manager(), new_ftm);
}

#[test]
fn test_set_blocker() {
    let s = setup();
    let new_blocker = Address::generate(&s.env);

    assert_eq!(s.contract.blocker(), s.blocker);

    s.contract.set_blocker(&new_blocker);
    assert_eq!(s.contract.blocker(), new_blocker);
}

// =============================================================================
// ADMIN IS NOT A SUPER-ROLE — admin cannot bypass role gates
// =============================================================================

#[test]
fn test_admin_cannot_mint() {
    let s = setup();
    let user = Address::generate(&s.env);

    let result = s.contract.try_mint(&s.admin, &user, &(1_000 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_admin_cannot_burn() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.blocker);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    let result = s.contract.try_burn(&s.admin, &user, &(400 * DECIMALS));
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_admin_cannot_set_rate() {
    let s = setup();

    let result = s.contract.try_set_rate(&s.admin, &500);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_admin_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.admin);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_admin_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s.contract.try_set_yield_recipient(&s.admin, &new_yr);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_set_admin_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_admin = Address::generate(&s.env);
    let err = s.contract.try_set_admin(&new_admin).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_minter_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_minter = Address::generate(&s.env);
    let err = s.contract.try_set_minter(&new_minter).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_yield_recipient_manager_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_yrm = Address::generate(&s.env);
    let err = s
        .contract
        .try_set_yield_recipient_manager(&new_yrm)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_forced_transfer_manager_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_ftm = Address::generate(&s.env);
    let err = s
        .contract
        .try_set_forced_transfer_manager(&new_ftm)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_blocker_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_blocker = Address::generate(&s.env);
    let err = s
        .contract
        .try_set_blocker(&new_blocker)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_yield_recipient_reverts_without_caller_auth() {
    let s = setup_no_mock_auth();
    let new_yr = Address::generate(&s.env);
    let result = s
        .contract
        .try_set_yield_recipient(&s.yield_recipient_manager, &new_yr);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_upgrade_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let fake_hash = BytesN::from_array(&s.env, &[0u8; 32]);
    let err = s.contract.try_upgrade(&fake_hash).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

// =============================================================================
// ACCESS CONTROL — set_yield_recipient wrong-role rejections
// =============================================================================

#[test]
fn test_minter_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s.contract.try_set_yield_recipient(&s.minter, &new_yr);
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

    let result = s.contract.try_set_yield_recipient(&random, &new_yr);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}
