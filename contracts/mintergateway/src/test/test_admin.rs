use soroban_sdk::testutils::Address as _;

use super::setup::*;
use crate::events::AuthorizedBlockerSet;

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
fn test_authorized_blocker_view() {
    let s = setup();
    assert_eq!(s.contract.get_authorized_blocker(&s.source), Some(s.blocker.clone()));
    let unknown = Symbol::new(&s.env, "unknown");
    assert_eq!(s.contract.get_authorized_blocker(&unknown), None);
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
fn test_set_and_remove_authorized_blocker() {
    let s = setup();
    let new_blocker = Address::generate(&s.env);
    let new_source = Symbol::new(&s.env, "compliance");

    assert_eq!(s.contract.get_authorized_blocker(&new_source), None);

    s.contract.set_authorized_blocker(&new_source, &new_blocker);
    assert_eq!(
        s.contract.get_authorized_blocker(&new_source),
        Some(new_blocker.clone())
    );

    s.contract.remove_authorized_blocker(&new_source);
    assert_eq!(s.contract.get_authorized_blocker(&new_source), None);
}

#[test]
fn test_set_authorized_blocker_updates_existing_source() {
    let s = setup();
    let new_blocker = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&s.source, &new_blocker);
    assert_eq!(
        s.contract.get_authorized_blocker(&s.source),
        Some(new_blocker)
    );
}

#[test]
fn test_set_authorized_blocker_idempotent() {
    let s = setup();
    s.contract.set_authorized_blocker(&s.source, &s.blocker);
    s.assert_no_events();
}

#[test]
fn test_remove_authorized_blocker_idempotent() {
    let s = setup();
    let unknown = Symbol::new(&s.env, "ghost");
    s.contract.remove_authorized_blocker(&unknown);
    s.assert_no_events();
}

#[test]
fn test_set_authorized_blocker_emits_event() {
    let s = setup();
    let new_source = Symbol::new(&s.env, "new_source");
    let blocker = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&new_source, &blocker);
    s.assert_event(AuthorizedBlockerSet {
        source: new_source,
        blocker,
    });
}

#[test]
fn test_registered_blocker_can_block_and_unblock() {
    // Guards against a regression where blocker lookup fails after registration.
    let s = setup();
    let new_source = Symbol::new(&s.env, "bridge");
    let new_blocker = Address::generate(&s.env);
    let user = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&new_source, &new_blocker);

    s.contract.block_user(&new_blocker, &user, &new_source);
    assert!(s.contract.blocked(&user));

    s.contract.unblock_user(&new_blocker, &user, &new_source);
    assert!(!s.contract.blocked(&user));
}

// =============================================================================
// ADMIN IS NOT A SUPER-ROLE — admin cannot bypass role gates
// =============================================================================

#[test]
fn test_admin_cannot_mint() {
    let s = setup();
    let user = Address::generate(&s.env);

    let result = s.contract.try_mint(&s.admin, &user, &(1_000 * DECIMALS));
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_burn() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    let result = s.contract.try_burn(&s.admin, &user, &(400 * DECIMALS));
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_set_interest_rate() {
    let s = setup();

    let result = s.contract.try_set_interest_rate(&s.admin, &500);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.admin);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s.contract.try_set_yield_recipient(&s.admin, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
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
fn test_set_authorized_blocker_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let blocker = Address::generate(&s.env);
    let source = Symbol::new(&s.env, "src");
    let err = s
        .contract
        .try_set_authorized_blocker(&source, &blocker)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_remove_authorized_blocker_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let err = s
        .contract
        .try_remove_authorized_blocker(&s.source)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_add_pauser_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_addr = Address::generate(&s.env);
    let err = s.contract.try_add_pauser(&new_addr).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_remove_pauser_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let err = s
        .contract
        .try_remove_pauser(&s.pauser)
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
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_yield_recipient_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&s.yield_recipient, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_forced_transfer_manager_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&s.forced_transfer_manager, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_random_cannot_set_yield_recipient() {
    let s = setup();
    let random = Address::generate(&s.env);
    let new_yr = Address::generate(&s.env);

    let result = s.contract.try_set_yield_recipient(&random, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}
