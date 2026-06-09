use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// SAC TRANSFER BEHAVIOR TESTS
// =============================================================================
//
// These tests cover transfer behaviors between authorized accounts using
// direct SAC transfers. They replace the removed authorize_and_transfer tests,
// verifying the same behaviors (full balance, multiple recipients, zero amount,
// insufficient funds, yield interaction, onboarding) via user-to-user transfers.

#[test]
fn test_sac_transfer_full_balance() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &alice, &s.source);
    s.contract.unblock_user(&s.blocker, &bob, &s.source);
    s.contract.mint(&s.minter, &alice, &amount);

    // Transfer entire balance
    s.sac_token.transfer(&alice, &bob, &amount);

    assert_eq!(s.sac_token.balance(&alice), 0);
    assert_eq!(s.sac_token.balance(&bob), amount);

    // Accumulators unchanged — contract doesn't see SAC transfers
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_sac_transfer_multiple_recipients() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient_a = Address::generate(&s.env);
    let recipient_b = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &treasury, &s.source);
    s.contract.unblock_user(&s.blocker, &recipient_a, &s.source);
    s.contract.unblock_user(&s.blocker, &recipient_b, &s.source);
    s.contract.mint(&s.minter, &treasury, &amount);

    // Distribute to multiple recipients
    s.sac_token
        .transfer(&treasury, &recipient_a, &(400 * DECIMALS));
    s.sac_token
        .transfer(&treasury, &recipient_b, &(300 * DECIMALS));

    assert_eq!(s.sac_token.balance(&treasury), 300 * DECIMALS);
    assert_eq!(s.sac_token.balance(&recipient_a), 400 * DECIMALS);
    assert_eq!(s.sac_token.balance(&recipient_b), 300 * DECIMALS);

    // Accumulators unchanged
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_sac_transfer_zero_amount() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &alice, &s.source);
    s.contract.unblock_user(&s.blocker, &bob, &s.source);
    s.contract.mint(&s.minter, &alice, &amount);

    // Transfer zero tokens
    s.sac_token.transfer(&alice, &bob, &0);

    // Balances unchanged
    assert_eq!(s.sac_token.balance(&alice), amount);
    assert_eq!(s.sac_token.balance(&bob), 0);
}

#[test]
fn test_sac_transfer_insufficient_balance() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 500 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &alice, &s.source);
    s.contract.unblock_user(&s.blocker, &bob, &s.source);
    s.contract.mint(&s.minter, &alice, &amount);

    // Try to transfer more than alice has
    let result = s.sac_token.try_transfer(&alice, &bob, &(1_000 * DECIMALS));
    assert!(result.is_err());

    // Balances unchanged
    assert_eq!(s.sac_token.balance(&alice), amount);
    assert_eq!(s.sac_token.balance(&bob), 0);
}

#[test]
fn test_sac_transfer_does_not_affect_yield() {
    let s = setup();
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let amount = 10_000 * DECIMALS;

    s.contract.unblock_user(&s.blocker, &treasury, &s.source);
    s.contract.unblock_user(&s.blocker, &recipient, &s.source);
    s.contract.mint(&s.minter, &treasury, &amount);

    // Set 5% rate and advance 1 year to accrue yield
    s.contract.set_interest_rate(&s.minter, &500);
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Record yield state before transfer
    let yield_before = s.contract.accrued_yield();
    let principal_before = s.contract.total_principal();
    let supply_before = s.contract.total_supply();
    assert!(yield_before > 0);

    // Transfer half via SAC
    s.sac_token.transfer(&treasury, &recipient, &(amount / 2));

    // Yield state unchanged — contract doesn't see SAC transfers
    assert_eq!(s.contract.accrued_yield(), yield_before);
    assert_eq!(s.contract.total_principal(), principal_before);
    assert_eq!(s.contract.total_supply(), supply_before);
}

#[test]
fn test_onboarding_flow() {
    let s = setup();
    let new_user = Address::generate(&s.env);
    let existing_user = Address::generate(&s.env);
    let mint_amount = 1_000 * DECIMALS;
    let transfer_amount = 100 * DECIMALS;

    // Admin unfreezes both users (onboarding)
    s.contract.unblock_user(&s.blocker, &new_user, &s.source);
    s.contract.unblock_user(&s.blocker, &existing_user, &s.source);

    // Mint to new user
    s.contract.mint(&s.minter, &new_user, &mint_amount);

    // New user can freely transfer to existing user — no authorize_and_transfer needed
    s.sac_token
        .transfer(&new_user, &existing_user, &transfer_amount);

    assert_eq!(
        s.sac_token.balance(&new_user),
        mint_amount - transfer_amount
    );
    assert_eq!(s.sac_token.balance(&existing_user), transfer_amount);
}

// =============================================================================
// UNAUTHORIZED RECIPIENT TESTS
// =============================================================================

#[test]
fn test_unauthorized_recipient_cannot_receive_transfer() {
    let s = setup();
    let sender = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    // Authorize and mint to sender
    s.contract.unblock_user(&s.blocker, &sender, &s.source);
    s.contract.mint(&s.minter, &sender, &(1_000 * DECIMALS));
    assert!(!s.contract.blocked(&sender));

    // Recipient is NOT authorized (AUTH_REQUIRED default)
    assert!(s.contract.blocked(&recipient));

    // Transfer to unauthorized recipient should fail
    let result = s
        .sac_token
        .try_transfer(&sender, &recipient, &(100 * DECIMALS));
    assert!(result.is_err());
}

// =============================================================================
// TRANSFER TO CONTRACT ADDRESS TESTS
// =============================================================================
//
// These tests verify what happens when a user transfers SAC tokens directly to
// the yield token contract's own address. Since the contract has no withdrawal
// mechanism, tokens sent to it are effectively locked forever.

#[test]
fn test_sac_transfer_to_contract_blocked_when_contract_not_authorized() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let contract_addr = s.contract.address.clone();

    // Authorize user and mint tokens
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &amount);

    // Contract address is NOT authorized (never unfrozen) — transfer should fail
    let result = s
        .sac_token
        .try_transfer(&user, &contract_addr, &(500 * DECIMALS));
    assert!(result.is_err());

    // User balance unchanged
    assert_eq!(s.sac_token.balance(&user), amount);
}

#[test]
fn test_sac_transfer_to_contract_succeeds_when_contract_authorized() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let transfer_amount = 400 * DECIMALS;
    let contract_addr = s.contract.address.clone();

    // Authorize user and mint tokens
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &amount);

    // Authorize the contract address itself
    s.contract.unblock_user(&s.blocker, &contract_addr, &s.source);

    // Transfer to contract address — succeeds but tokens are locked forever
    s.sac_token
        .transfer(&user, &contract_addr, &transfer_amount);

    assert_eq!(s.sac_token.balance(&user), amount - transfer_amount);
    assert_eq!(s.sac_token.balance(&contract_addr), transfer_amount);

    // Accumulators unchanged — contract doesn't know about direct SAC transfers
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_sac_transfer_full_balance_to_contract_locks_tokens() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let contract_addr = s.contract.address.clone();

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.unblock_user(&s.blocker, &contract_addr, &s.source);
    s.contract.mint(&s.minter, &user, &amount);

    // Send entire balance to the contract
    s.sac_token.transfer(&user, &contract_addr, &amount);

    assert_eq!(s.sac_token.balance(&user), 0);
    assert_eq!(s.sac_token.balance(&contract_addr), amount);

    // Tokens are stuck — the contract has no function to send them back.
    // Accumulators still show the original mint.
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}
