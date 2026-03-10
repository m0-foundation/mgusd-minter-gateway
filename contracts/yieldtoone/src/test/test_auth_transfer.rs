use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// AUTHORIZED USER SEND-TO-ISSUER BURN TEST
// =============================================================================
//
// When a user is authorized (unfrozen), they can send tokens back to the issuer
// address. At the Stellar protocol level, tokens sent to the issuer are destroyed.
// The contract's accumulators are NOT updated — off-chain reconciliation via
// burn() is needed to sync them.

#[test]
fn test_authorized_user_can_send_to_issuer_to_burn() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;
    let send_amount = 400_0000000i128;

    // Authorize user and mint tokens
    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);
    assert_eq!(s.sac_token.balance(&user), amount);
    assert!(s.contract.is_authorized(&user));

    // User sends tokens to the issuer — tokens are destroyed (un-issued)
    s.sac_token.transfer(&user, &s.issuer, &send_amount);

    // User balance decreased
    assert_eq!(s.sac_token.balance(&user), amount - send_amount);

    // Issuer balance unchanged (always i64::MAX — Stellar convention)
    assert_eq!(s.sac_token.balance(&s.issuer), i64::MAX as i128);

    // User remains authorized — sending to issuer doesn't freeze them
    assert!(s.contract.is_authorized(&user));

    // Contract accumulators are NOT updated — the contract doesn't know
    // about this direct SAC transfer. Off-chain must call burn() to reconcile.
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_authorized_user_can_send_full_balance_to_issuer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);

    // Send entire balance to issuer
    s.sac_token.transfer(&user, &s.issuer, &amount);

    assert_eq!(s.sac_token.balance(&user), 0);
    assert!(s.contract.is_authorized(&user));
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
// These tests verify that AUTH_REQUIRED prevents unauthorized transfers — the
// auth flags live on the issuer account and are enforced regardless of HOW the
// transfer is invoked. Only authorized (unfrozen) users can transfer tokens.

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
