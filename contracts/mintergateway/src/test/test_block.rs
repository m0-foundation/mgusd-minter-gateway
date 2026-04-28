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

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    s.contract.block_user(&user, &s.block_operator);
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

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.blocked(&user));

    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user));

    // Authorize recipient so they can receive (AUTH_REQUIRED mode)
    s.contract.unblock_user(&recipient, &s.unblock_operator);

    // Unblocked user can transfer again
    s.sac_token.transfer(&user, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 100 * DECIMALS);
}

#[test]
fn test_blocked_default_true() {
    let s = setup();
    let user = Address::generate(&s.env);

    // New accounts are unauthorized by default with AUTH_REQUIRED
    assert!(s.contract.blocked(&user));
}

#[test]
fn test_block_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    // Freezing twice doesn't panic
    s.contract.block_user(&user, &s.block_operator);
    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.blocked(&user));
}

#[test]
fn test_unblock_idempotent() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Authorize the account first
    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user));

    // Unfreezing an already-authorized account doesn't panic
    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user));
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_block_user_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let user = Address::generate(&s.env);
    let result = s.contract.try_block_user(&user, &s.block_operator);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_unblock_user_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let user = Address::generate(&s.env);
    let result = s.contract.try_unblock_user(&user, &s.unblock_operator);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_block_user_rejects_unauthorized_role() {
    let s = setup();
    let user = Address::generate(&s.env);
    let random = Address::generate(&s.env);
    let result = s.contract.try_block_user(&user, &random);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_unblock_user_rejects_unauthorized_role() {
    let s = setup();
    let user = Address::generate(&s.env);
    let random = Address::generate(&s.env);
    let result = s.contract.try_unblock_user(&user, &random);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_block_only_operator_cannot_unblock() {
    let s = setup();
    let only_block = Address::generate(&s.env);
    let only_unblock = Address::generate(&s.env);
    s.contract.add_block_operator(&only_block);
    s.contract.add_unblock_operator(&only_unblock);
    s.contract.remove_block_operator(&s.block_operator);
    s.contract.remove_unblock_operator(&s.unblock_operator);

    let user = Address::generate(&s.env);
    let result = s.contract.try_unblock_user(&user, &only_block);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_unblock_only_operator_cannot_block() {
    let s = setup();
    let only_block = Address::generate(&s.env);
    let only_unblock = Address::generate(&s.env);
    s.contract.add_block_operator(&only_block);
    s.contract.add_unblock_operator(&only_unblock);
    s.contract.remove_block_operator(&s.block_operator);
    s.contract.remove_unblock_operator(&s.unblock_operator);

    let user = Address::generate(&s.env);
    let result = s.contract.try_block_user(&user, &only_unblock);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_block_operator_can_block_user() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user));

    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.blocked(&user));
}

#[test]
fn test_unblock_operator_can_unblock_user() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user));
}

#[test]
fn test_single_address_can_hold_both_block_and_unblock_roles() {
    let s = setup();
    let dual = Address::generate(&s.env);
    s.contract.add_block_operator(&dual);
    s.contract.add_unblock_operator(&dual);

    let user = Address::generate(&s.env);
    s.contract.unblock_user(&user, &dual);
    assert!(!s.contract.blocked(&user));

    s.contract.block_user(&user, &dual);
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
    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.mint(&s.minter, &user, &principal);
    assert_eq!(s.sac_token.balance(&user), principal);
    assert!(!s.contract.blocked(&user));

    // Step 2: Block the account
    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.blocked(&user));

    // Step 3: Burn half
    s.contract.burn(&s.minter, &user, &(principal / 2));
    assert_eq!(s.sac_token.balance(&user), principal / 2);
    assert_eq!(s.contract.total_principal(), principal / 2);
    assert_eq!(s.contract.total_supply(), principal / 2);

    // Step 4: Unblock the account
    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user));

    // Step 5: User can transfer remaining balance
    let recipient = Address::generate(&s.env);
    s.contract.unblock_user(&recipient, &s.unblock_operator); // Authorize recipient (AUTH_REQUIRED mode)
    s.sac_token.transfer(&user, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 100 * DECIMALS);
}

#[test]
fn test_block_user_blocks_subsequent_direct_sac_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    // Authorize both and mint
    s.contract.unblock_user(&alice, &s.unblock_operator);
    s.contract.unblock_user(&bob, &s.unblock_operator);
    s.contract.mint(&s.minter, &alice, &amount);

    // Direct SAC transfer works while both are authorized
    s.sac_token.transfer(&alice, &bob, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&bob), 100 * DECIMALS);

    // Admin blocks alice via our contract
    s.contract.block_user(&alice, &s.block_operator);

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

    s.contract.unblock_user(&user, &s.unblock_operator);
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

    s.contract.unblock_user(&owner, &s.unblock_operator);
    s.contract.unblock_user(&spender, &s.unblock_operator);
    s.contract.unblock_user(&recipient, &s.unblock_operator);
    s.contract.mint(&s.minter, &owner, &principal);

    let expiration_ledger = s.env.ledger().sequence() + 1_000_000;
    s.sac_token
        .approve(&owner, &spender, &allowance, &expiration_ledger);
    assert_eq!(s.sac_token.allowance(&owner, &spender), allowance);

    s.contract.block_user(&spender, &s.block_operator);
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

    s.contract.unblock_user(&owner, &s.unblock_operator);
    s.contract.unblock_user(&spender, &s.unblock_operator);
    s.contract.unblock_user(&recipient, &s.unblock_operator);
    s.contract.mint(&s.minter, &owner, &principal);

    let expiration_ledger = s.env.ledger().sequence() + 1_000_000;
    s.sac_token
        .approve(&owner, &spender, &allowance, &expiration_ledger);
    assert_eq!(s.sac_token.allowance(&owner, &spender), allowance);

    s.contract.block_user(&owner, &s.block_operator);
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
