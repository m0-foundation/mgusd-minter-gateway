use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// BLOCK / UNBLOCK TESTS
// =============================================================================

#[test]
fn test_block_user_prevents_transfer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    s.contract.block_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked(&user));

    // Blocked user cannot transfer
    let result = s
        .sac_token
        .try_transfer(&user, &recipient, &(100 * DECIMALS));
    assert!(result.is_err());
}

#[test]
fn test_unblock_user_restores_transfer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    s.contract.block_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked(&user));

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));

    // Authorize recipient so they can receive (AUTH_REQUIRED mode)
    s.contract.unblock_user(&s.blocker, &recipient, &s.source);

    // Unblocked user can transfer again
    s.sac_token.transfer(&user, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 100 * DECIMALS);
}

#[test]
fn test_blocked_false_for_authorized_user_with_no_sources() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Activate the user at the SAC level (no block sources in the registry).
    // blocked() combines the registry AND SAC authorization: an authorized
    // account with no active block sources reports not-blocked.
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));
    assert!(s.contract.get_blocks(&user).is_empty());
}

#[test]
fn test_blocked_true_for_never_activated_user() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Fresh account has no trustline / SAC authorization under AUTH_REQUIRED,
    // so blocked() returns true even though the block registry is empty.
    assert!(s.contract.blocked(&user));
    assert!(s.contract.get_blocks(&user).is_empty());
}

#[test]
fn test_blocked_true_after_block() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.block_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked(&user));
}

#[test]
fn test_block_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    // Blocking twice doesn't panic
    s.contract.block_user(&s.blocker, &user, &s.source);
    s.contract.block_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked(&user));
}

#[test]
fn test_unblock_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Authorize the account first
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));

    // Unblocking an already-authorized account doesn't panic
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_block_user_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let user = Address::generate(&s.env);
    let result = s.contract.try_block_user(&s.blocker, &user, &s.source);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_unblock_user_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let user = Address::generate(&s.env);
    let result = s.contract.try_unblock_user(&s.blocker, &user, &s.source);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_block_user_rejects_wrong_caller_for_source() {
    let s = setup();
    let user = Address::generate(&s.env);
    let random = Address::generate(&s.env);
    // `random` is not registered as the blocker for `s.source`
    let result = s.contract.try_block_user(&random, &user, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_unblock_user_rejects_wrong_caller_for_source() {
    let s = setup();
    let user = Address::generate(&s.env);
    let random = Address::generate(&s.env);
    let result = s.contract.try_unblock_user(&random, &user, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_block_user_rejects_unknown_source() {
    let s = setup();
    let user = Address::generate(&s.env);
    let unknown = Symbol::new(&s.env, "ghost");
    let result = s.contract.try_block_user(&s.blocker, &user, &unknown);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnknownSourceError))
    );
}

#[test]
fn test_unblock_user_rejects_unknown_source() {
    let s = setup();
    let user = Address::generate(&s.env);
    let unknown = Symbol::new(&s.env, "ghost");
    let result = s.contract.try_unblock_user(&s.blocker, &user, &unknown);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnknownSourceError))
    );
}

#[test]
fn test_registered_blocker_can_block_and_unblock() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));

    s.contract.block_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked(&user));
}

// =============================================================================
// COMPLIANCE INTEGRATION TEST
// =============================================================================

#[test]
fn test_compliance_flow_block_burn_unblock() {
    let s = setup();
    let user = Address::generate(&s.env);
    let principal = 1_000 * DECIMALS;

    // Step 1: Mint tokens
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &principal);
    assert_eq!(s.sac_token.balance(&user), principal);
    assert!(!s.contract.blocked(&user));

    // Step 2: Block the account
    s.contract.block_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked(&user));

    // Step 3: Burn half
    s.contract.burn(&s.minter, &user, &(principal / 2));
    assert_eq!(s.sac_token.balance(&user), principal / 2);
    assert_eq!(s.contract.total_principal(), principal / 2);
    assert_eq!(s.contract.total_supply(), principal / 2);

    // Step 4: Unblock the account
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));

    // Step 5: User can transfer remaining balance
    let recipient = Address::generate(&s.env);
    s.contract.unblock_user(&s.blocker, &recipient, &s.source);
    s.sac_token.transfer(&user, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 100 * DECIMALS);
}

#[test]
fn test_block_user_blocks_subsequent_direct_sac_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &alice, &s.source);
    s.contract.unblock_user(&s.blocker, &bob, &s.source);
    s.contract.mint(&s.minter, &alice, &amount);

    // Direct SAC transfer works while both are authorized
    s.sac_token.transfer(&alice, &bob, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&bob), 100 * DECIMALS);

    s.contract.block_user(&s.blocker, &alice, &s.source);

    // Alice tries another direct SAC transfer — BLOCKED
    let result = s.sac_token.try_transfer(&alice, &bob, &(100 * DECIMALS));
    assert!(result.is_err());

    // Alice's remaining balance is locked
    assert_eq!(s.sac_token.balance(&alice), amount - 100 * DECIMALS);
}

// =============================================================================
// balance() VIEW — delegates to SAC
// =============================================================================

#[test]
fn test_balance_matches_sac_balance() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    // Before mint: balance is 0 and matches SAC
    assert_eq!(s.contract.balance(&user), 0);
    assert_eq!(s.contract.balance(&user), s.sac_token.balance(&user));

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &amount);

    // After mint: balance matches SAC-reported balance
    assert_eq!(s.contract.balance(&user), amount);
    assert_eq!(s.contract.balance(&user), s.sac_token.balance(&user));
}

// =============================================================================
// COMPLIANCE LIMITATIONS — pinned known gaps from audit findings
// =============================================================================

#[test]
fn test_block_user_does_not_revoke_existing_allowances() {
    // STEL1-3 (Info): block_user flips SAC authorization on the blocked
    // address only. It does NOT revoke allowances the blocked address
    // already holds as a spender. A spender approved pre-block keeps the
    // ability to call SAC transfer_from on the owner's balance — the SAC
    // checks authorization on the balance owner and recipient, not on the
    // spender's own trustline status.
    //
    // This test pins the documented limitation as a regression guard. If M0
    // later folds allowance-revocation into the compliance flow, invert the
    // assertion to require transfer_from to revert.
    let s = setup();
    let owner = Address::generate(&s.env);
    let spender = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let principal = 1_000 * DECIMALS;
    let allowance = 500 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &owner, &s.source);
    s.contract.unblock_user(&s.blocker, &spender, &s.source);
    s.contract.unblock_user(&s.blocker, &recipient, &s.source);
    s.contract.mint(&s.minter, &owner, &principal);

    let expiration_ledger = s.env.ledger().sequence() + 1_000_000;
    s.sac_token
        .approve(&owner, &spender, &allowance, &expiration_ledger);
    assert_eq!(s.sac_token.allowance(&owner, &spender), allowance);

    s.contract.block_user(&s.blocker, &spender, &s.source);
    assert!(s.contract.blocked(&spender));
    assert_eq!(s.sac_token.balance(&spender), 0);

    // The blocked spender can still move the owner's balance.
    s.sac_token
        .transfer_from(&spender, &owner, &recipient, &allowance);

    assert_eq!(s.sac_token.balance(&owner), principal - allowance);
    assert_eq!(s.sac_token.balance(&recipient), allowance);
    assert_eq!(s.sac_token.balance(&spender), 0);
    assert!(s.contract.blocked(&spender));
}

#[test]
fn test_block_owner_prevents_spender_transfer_from() {
    // Counterpart to test_block_user_does_not_revoke_existing_allowances:
    // when the *owner* (the address whose balance is being moved) is blocked,
    // SAC transfer_from must revert. Authorization is checked on the balance
    // owner's trustline, so deauthorizing the owner immobilizes the balance
    // even for an already-approved spender.
    let s = setup();
    let owner = Address::generate(&s.env);
    let spender = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let principal = 1_000 * DECIMALS;
    let allowance = 500 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &owner, &s.source);
    s.contract.unblock_user(&s.blocker, &spender, &s.source);
    s.contract.unblock_user(&s.blocker, &recipient, &s.source);
    s.contract.mint(&s.minter, &owner, &principal);

    let expiration_ledger = s.env.ledger().sequence() + 1_000_000;
    s.sac_token
        .approve(&owner, &spender, &allowance, &expiration_ledger);
    assert_eq!(s.sac_token.allowance(&owner, &spender), allowance);

    s.contract.block_user(&s.blocker, &owner, &s.source);
    assert!(s.contract.blocked(&owner));

    // The spender (still authorized) cannot move the blocked owner's balance.
    let result = s
        .sac_token
        .try_transfer_from(&spender, &owner, &recipient, &allowance);
    assert!(result.is_err());

    assert_eq!(s.sac_token.balance(&owner), principal);
    assert_eq!(s.sac_token.balance(&recipient), 0);
    assert_eq!(s.sac_token.allowance(&owner, &spender), allowance);
}
