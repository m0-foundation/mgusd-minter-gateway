use soroban_sdk::testutils::Address as _;

use super::setup::*;

#[test]
fn test_onboard_user_activates_new_account() {
    let s = setup();
    let user = Address::generate(&s.env);

    // New account: SAC-unauthorized, not on block list
    assert!(s.contract.blocked(&user));
    assert!(!s.contract.is_on_block_list(&user));

    s.contract.onboard_user(&user, &s.onboarder);

    // After onboarding: SAC-authorized, still not on block list
    assert!(!s.contract.blocked(&user));
    assert!(!s.contract.is_on_block_list(&user));
}

#[test]
fn test_onboard_user_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.onboard_user(&user, &s.onboarder);
    assert!(!s.contract.blocked(&user));
}

#[test]
fn test_onboarded_user_can_receive_tokens() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &(500 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), 500 * DECIMALS);
}

#[test]
fn test_onboard_user_fails_when_on_block_list() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.is_on_block_list(&user));

    // Onboarder cannot lift a compliance hold
    let result = s.contract.try_onboard_user(&user, &s.onboarder);
    assert_eq!(result, Err(Ok(crate::MinterGatewayError::UserBlockedError)));
}

#[test]
fn test_onboard_succeeds_after_unblock() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.is_on_block_list(&user));
    assert!(s.contract.blocked(&user));

    // Unblock removes from block list
    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.is_on_block_list(&user));
    assert!(!s.contract.blocked(&user));

    // Now onboarder can onboard (no-op)
    let result = s.contract.try_onboard_user(&user, &s.onboarder);
    assert_eq!(result, Ok(Ok(())));
}

#[test]
fn test_is_on_block_list_false_by_default() {
    let s = setup();
    let user = Address::generate(&s.env);

    assert!(s.contract.blocked(&user));
    assert!(!s.contract.is_on_block_list(&user));
}

#[test]
fn test_batch_block_adds_all_to_block_list() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    s.contract.onboard_user(&alice, &s.onboarder);
    s.contract.onboard_user(&bob, &s.onboarder);

    let users = soroban_sdk::vec![&s.env, alice.clone(), bob.clone()];
    s.contract.batch_block_users(&users, &s.block_operator);

    assert!(s.contract.is_on_block_list(&alice));
    assert!(s.contract.is_on_block_list(&bob));
    assert!(s.contract.blocked(&alice));
    assert!(s.contract.blocked(&bob));
}

#[test]
fn test_batch_unblock_removes_all_from_block_list() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    s.contract.onboard_user(&alice, &s.onboarder);
    s.contract.onboard_user(&bob, &s.onboarder);

    let users = soroban_sdk::vec![&s.env, alice.clone(), bob.clone()];
    s.contract.batch_block_users(&users, &s.block_operator);
    s.contract.batch_unblock_users(&users, &s.unblock_operator);

    assert!(!s.contract.is_on_block_list(&alice));
    assert!(!s.contract.is_on_block_list(&bob));
    assert!(!s.contract.blocked(&alice));
    assert!(!s.contract.blocked(&bob));
}

// =============================================================================
// AUTH ENFORCEMENT
// =============================================================================

#[test]
fn test_onboard_user_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let user = Address::generate(&s.env);
    let result = s.contract.try_onboard_user(&user, &s.onboarder);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_onboard_user_rejects_unauthorized_caller() {
    let s = setup();
    let user = Address::generate(&s.env);
    let random = Address::generate(&s.env);

    let result = s.contract.try_onboard_user(&user, &random);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

// =============================================================================
// ADMIN FUNCTIONS — add/remove onboarder
// =============================================================================

#[test]
fn test_add_onboarder_grants_permission() {
    let s = setup();
    let new_onboarder = Address::generate(&s.env);

    assert!(!s.contract.is_onboarder(&new_onboarder));
    s.contract.add_onboarder(&new_onboarder);
    assert!(s.contract.is_onboarder(&new_onboarder));

    // New onboarder can activate users
    let user = Address::generate(&s.env);
    s.contract.onboard_user(&user, &new_onboarder);
    assert!(!s.contract.blocked(&user));
}

#[test]
fn test_remove_onboarder_revokes_permission() {
    let s = setup();

    s.contract.remove_onboarder(&s.onboarder);
    assert!(!s.contract.is_onboarder(&s.onboarder));

    let user = Address::generate(&s.env);
    let result = s.contract.try_onboard_user(&user, &s.onboarder);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_add_onboarder_idempotent() {
    let s = setup();
    let addr = Address::generate(&s.env);

    s.contract.add_onboarder(&addr);
    s.contract.add_onboarder(&addr); // no-op
    assert!(s.contract.is_onboarder(&addr));
}

#[test]
fn test_remove_onboarder_idempotent() {
    let s = setup();
    let addr = Address::generate(&s.env);

    s.contract.remove_onboarder(&addr); // no-op
    assert!(!s.contract.is_onboarder(&addr));
}

#[test]
fn test_add_onboarder_requires_admin() {
    let s = setup_no_mock_auth();
    let addr = Address::generate(&s.env);

    let err = s.contract.try_add_onboarder(&addr).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

// full flow — design doc recipient activation example
#[test]
fn test_recipient_activation_flow() {
    let s = setup();
    let recipient = Address::generate(&s.env);

    assert!(s.contract.blocked(&recipient));
    assert!(!s.contract.is_on_block_list(&recipient));

    s.contract.onboard_user(&recipient, &s.onboarder);
    assert!(!s.contract.blocked(&recipient));
    assert!(!s.contract.is_on_block_list(&recipient));

    s.contract.block_user(&recipient, &s.block_operator);
    assert!(s.contract.blocked(&recipient));
    assert!(s.contract.is_on_block_list(&recipient));

    s.contract.unblock_user(&recipient, &s.unblock_operator);
    assert!(!s.contract.blocked(&recipient));
    assert!(!s.contract.is_on_block_list(&recipient));
}

#[test]
fn test_unblock_does_not_sac_authorize_if_never_onboarded() {
    let s = setup();
    let user = Address::generate(&s.env);

    // User is on the block list but was never onboarded
    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.is_on_block_list(&user));
    assert!(!s.contract.is_onboarded(&user));

    // unblock_user clears the block list entry but cannot restore auth it never granted
    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.is_on_block_list(&user));
    assert!(s.contract.blocked(&user)); // still SAC-unauthorized
}

#[test]
fn test_unblock_restores_sac_auth_for_onboarded_user() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.onboard_user(&user, &s.onboarder);
    assert!(s.contract.is_onboarded(&user));
    assert!(!s.contract.blocked(&user));

    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.blocked(&user));

    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user)); // SAC auth restored because onboarded
}

#[test]
fn test_batch_unblock_does_not_sac_authorize_non_onboarded() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    // Block both without onboarding
    let users = soroban_sdk::vec![&s.env, alice.clone(), bob.clone()];
    s.contract.batch_block_users(&users, &s.block_operator);

    s.contract.batch_unblock_users(&users, &s.unblock_operator);

    // Block list cleared, but SAC auth not restored (never onboarded)
    assert!(!s.contract.is_on_block_list(&alice));
    assert!(!s.contract.is_on_block_list(&bob));
    assert!(s.contract.blocked(&alice));
    assert!(s.contract.blocked(&bob));
}

#[test]
fn test_is_onboarded_view() {
    let s = setup();
    let user = Address::generate(&s.env);

    assert!(!s.contract.is_onboarded(&user));
    s.contract.onboard_user(&user, &s.onboarder);
    assert!(s.contract.is_onboarded(&user));

    // Blocking does not clear the onboarded flag
    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.is_onboarded(&user));
}
