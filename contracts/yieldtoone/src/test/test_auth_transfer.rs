use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// AUTHORIZE AND TRANSFER TESTS
// =============================================================================

#[test]
fn test_authorize_and_transfer_basic() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let amount = 500_0000000i128;

    // Mint tokens to treasury
    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    let principal_before = s.contract.total_principal();
    let supply_before = s.contract.total_supply();

    // Recipient is unauthorized by default
    assert!(!s.contract.is_authorized(&recipient));

    // Authorize and transfer
    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &amount);

    // Recipient has tokens but is re-frozen (deauthorized) after transfer
    assert!(!s.contract.is_authorized(&recipient));
    assert_eq!(s.sac_token.balance(&recipient), amount);
    assert_eq!(s.sac_token.balance(&treasury), 1_000_0000000 - amount);

    // Accumulators unchanged — this is a balance redistribution
    assert_eq!(s.contract.total_principal(), principal_before);
    assert_eq!(s.contract.total_supply(), supply_before);
}

#[test]
fn test_authorize_and_transfer_full_balance() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &amount);

    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &amount);

    assert_eq!(s.sac_token.balance(&treasury), 0);
    assert_eq!(s.sac_token.balance(&recipient), amount);
    assert!(!s.contract.is_authorized(&recipient));
}

#[test]
fn test_authorize_and_transfer_already_authorized() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let amount = 500_0000000i128;

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // Pre-authorize recipient
    s.contract.unfreeze_account(&recipient);
    assert!(s.contract.is_authorized(&recipient));

    // Should still work — re-freezes even if previously authorized
    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &amount);

    assert!(!s.contract.is_authorized(&recipient));
    assert_eq!(s.sac_token.balance(&recipient), amount);
}

#[test]
fn test_authorize_and_transfer_multiple_recipients() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient_a = Address::generate(&s.env);
    let recipient_b = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient_a, &400_0000000);
    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient_b, &300_0000000);

    assert_eq!(s.sac_token.balance(&recipient_a), 400_0000000);
    assert_eq!(s.sac_token.balance(&recipient_b), 300_0000000);
    assert_eq!(s.sac_token.balance(&treasury), 300_0000000);
    assert!(!s.contract.is_authorized(&recipient_a));
    assert!(!s.contract.is_authorized(&recipient_b));
}

#[test]
fn test_authorize_and_transfer_zero_amount() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // Zero amount: authorizes, transfers nothing, then re-freezes
    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &0);

    assert!(!s.contract.is_authorized(&recipient));
    assert_eq!(s.sac_token.balance(&recipient), 0);
    assert_eq!(s.sac_token.balance(&treasury), 1_000_0000000);
}

#[test]
fn test_authorize_and_transfer_insufficient_balance() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &500_0000000);

    // Try to transfer more than treasury has — should revert entirely (atomic)
    let result = s.contract.try_authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &1_000_0000000);
    assert!(result.is_err());

    // Recipient should NOT be authorized (atomic revert)
    assert!(!s.contract.is_authorized(&recipient));
    assert_eq!(s.sac_token.balance(&treasury), 500_0000000);
}

#[test]
fn test_authorize_and_transfer_negative_amount() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    let result =
        s.contract
            .try_authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &-100);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::NegativeAmountError)));
}

#[test]
fn test_authorize_and_transfer_does_not_affect_yield() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let principal = 1_000_000_0000000i128;

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_before = s.contract.accrued_yield();
    assert!(yield_before > 0);

    // Transfer half the treasury — yield should be unaffected
    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &(principal / 2));

    // Accrued yield unchanged
    assert_eq!(s.contract.accrued_yield(), yield_before);
    // Principal unchanged
    assert_eq!(s.contract.total_principal(), principal);
}

#[test]
fn test_onboarding_flow() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let new_user = Address::generate(&s.env);
    let existing_user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    // Step 1: Mint tokens to treasury
    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &amount);

    // Step 2: Onboard new user — authorize_and_transfer then re-freezes
    s.contract.authorize_and_transfer(&s.forced_transfer_manager, &treasury, &new_user, &500_0000000);
    assert!(!s.contract.is_authorized(&new_user));
    assert_eq!(s.sac_token.balance(&new_user), 500_0000000);

    // Step 3: Admin unfreezes new user so they can transfer
    s.contract.unfreeze_account(&new_user);
    s.contract.unfreeze_account(&existing_user);
    s.sac_token.transfer(&new_user, &existing_user, &100_0000000);
    assert_eq!(s.sac_token.balance(&existing_user), 100_0000000);
    assert_eq!(s.sac_token.balance(&new_user), 400_0000000);
}

#[test]
fn test_authorize_and_transfer_refreezes_recipient() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // Recipient starts unauthorized
    assert!(!s.contract.is_authorized(&recipient));

    // Authorize and transfer
    s.contract
        .authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &500_0000000);

    // Recipient has tokens
    assert_eq!(s.sac_token.balance(&recipient), 500_0000000);

    // Recipient is deauthorized (re-frozen) after transfer
    assert!(!s.contract.is_authorized(&recipient));

    // Recipient cannot send tokens directly via SAC
    let other = Address::generate(&s.env);
    s.contract.unfreeze_account(&other);
    let result = s.sac_token.try_transfer(&recipient, &other, &100_0000000);
    assert!(result.is_err());
}

// =============================================================================
// AUTHORIZE AND TRANSFER — ACCESS CONTROL TESTS
// =============================================================================
// Verify that only admin and forced_transfer_manager can call
// authorize_and_transfer. Other roles and random addresses must be rejected.

#[test]
fn test_minter_cannot_authorize_and_transfer() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // Minter role cannot call authorize_and_transfer
    let result =
        s.contract
            .try_authorize_and_transfer(&s.minter, &treasury, &recipient, &500_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_manager_cannot_authorize_and_transfer() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // YRM role cannot call authorize_and_transfer
    let result = s.contract.try_authorize_and_transfer(
        &s.yield_recipient_manager,
        &treasury,
        &recipient,
        &500_0000000,
    );
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_yield_recipient_cannot_authorize_and_transfer() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // YR role cannot call authorize_and_transfer
    let result = s.contract.try_authorize_and_transfer(
        &s.yield_recipient,
        &treasury,
        &recipient,
        &500_0000000,
    );
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

#[test]
fn test_random_address_cannot_authorize_and_transfer() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let random = Address::generate(&s.env);

    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &1_000_0000000);

    // Random address cannot call authorize_and_transfer
    let result =
        s.contract
            .try_authorize_and_transfer(&random, &treasury, &recipient, &500_0000000);
    assert_eq!(result, Err(Ok(crate::YieldTokenError::UnauthorizedError)));
}

// =============================================================================
// DIRECT SAC TRANSFER BYPASS TESTS
// =============================================================================
//
// On the real Stellar network, SAC tokens and Classic Stellar assets share the
// same ledger. A user holding SAC tokens could attempt to move them by calling
// the SAC's transfer() directly (or via a Classic PaymentOp), bypassing our
// yield contract entirely.
//
// These tests verify that AUTH_REQUIRED prevents this — the auth flags live on
// the issuer account and are enforced regardless of HOW the transfer is invoked.
// The user MUST go through our contract's authorize_and_transfer to move tokens.

#[test]
fn test_direct_sac_transfer_blocked_for_deauthorized_recipient() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    // Authorize alice and mint tokens to her
    s.contract.unfreeze_account(&alice);
    s.contract.mint(&s.minter, &alice, &amount);
    assert_eq!(s.sac_token.balance(&alice), amount);

    // Bob is NOT authorized (never called unfreeze_account)
    // Alice tries to transfer directly on the SAC, bypassing our contract
    let result = s.sac_token.try_transfer(&alice, &bob, &500_0000000);

    // BLOCKED — AUTH_REQUIRED enforces authorization on the recipient
    assert!(result.is_err());

    // Balances unchanged
    assert_eq!(s.sac_token.balance(&alice), amount);
    assert_eq!(s.sac_token.balance(&bob), 0);
}

#[test]
fn test_direct_sac_transfer_succeeds_between_authorized_accounts() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;
    let transfer_amount = 400_0000000i128;

    // Authorize both accounts and mint to alice
    s.contract.unfreeze_account(&alice);
    s.contract.unfreeze_account(&bob);
    s.contract.mint(&s.minter, &alice, &amount);

    // Alice calls SAC transfer directly — bypassing our contract entirely
    s.sac_token.transfer(&alice, &bob, &transfer_amount);

    // Transfer succeeds — both accounts are authorized
    assert_eq!(s.sac_token.balance(&alice), amount - transfer_amount);
    assert_eq!(s.sac_token.balance(&bob), transfer_amount);

    // CRITICAL: Our contract's accumulators know nothing about this!
    // total_principal and total_supply are unchanged because mint/burn
    // were not called — the tokens just moved between accounts.
    // This is fine: total_supply tracks aggregate minted tokens,
    // not per-account balances.
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_direct_sac_approve_and_transfer_from_bypass() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let spender = Address::generate(&s.env);
    let amount = 1_000_0000000i128;
    let allowance_amount = 500_0000000i128;

    // Authorize alice and bob, mint to alice
    s.contract.unfreeze_account(&alice);
    s.contract.unfreeze_account(&bob);
    s.contract.mint(&s.minter, &alice, &amount);

    // Alice approves a spender directly on the SAC
    s.sac_token.approve(&alice, &spender, &allowance_amount, &1000);

    // Spender calls transfer_from on the SAC — completely bypasses our contract
    s.sac_token.transfer_from(&spender, &alice, &bob, &allowance_amount);

    // Works — both accounts are authorized, allowance was set on SAC
    assert_eq!(s.sac_token.balance(&alice), amount - allowance_amount);
    assert_eq!(s.sac_token.balance(&bob), allowance_amount);

    // Again, our contract doesn't see this transfer
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_direct_sac_transfer_from_blocked_for_deauthorized_recipient() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env); // NOT authorized
    let spender = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&alice);
    s.contract.mint(&s.minter, &alice, &amount);

    // Alice approves spender on the SAC
    s.sac_token.approve(&alice, &spender, &amount, &1000);

    // Spender tries transfer_from to deauthorized bob — should fail
    let result = s.sac_token.try_transfer_from(&spender, &alice, &bob, &500_0000000);
    assert!(result.is_err());

    // Balances unchanged
    assert_eq!(s.sac_token.balance(&alice), amount);
    assert_eq!(s.sac_token.balance(&bob), 0);
}

#[test]
fn test_freeze_blocks_subsequent_direct_sac_transfer() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    // Authorize both and mint
    s.contract.unfreeze_account(&alice);
    s.contract.unfreeze_account(&bob);
    s.contract.mint(&s.minter, &alice, &amount);

    // Direct SAC transfer works while both are authorized
    s.sac_token.transfer(&alice, &bob, &100_0000000);
    assert_eq!(s.sac_token.balance(&bob), 100_0000000);

    // Admin freezes alice via our contract
    s.contract.freeze_account(&alice);

    // Alice tries another direct SAC transfer — BLOCKED
    let result = s.sac_token.try_transfer(&alice, &bob, &100_0000000);
    assert!(result.is_err());

    // Alice's remaining balance is locked
    assert_eq!(s.sac_token.balance(&alice), amount - 100_0000000);
}
