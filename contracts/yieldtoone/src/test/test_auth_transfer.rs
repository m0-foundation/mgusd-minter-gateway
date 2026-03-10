use soroban_sdk::testutils::{Address as _, IssuerFlags};

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
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&alice);
    s.contract.unfreeze_account(&bob);
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
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&treasury);
    s.contract.unfreeze_account(&recipient_a);
    s.contract.unfreeze_account(&recipient_b);
    s.contract.mint(&s.minter, &treasury, &amount);

    // Distribute to multiple recipients
    s.sac_token.transfer(&treasury, &recipient_a, &400_0000000);
    s.sac_token.transfer(&treasury, &recipient_b, &300_0000000);

    assert_eq!(s.sac_token.balance(&treasury), 300_0000000);
    assert_eq!(s.sac_token.balance(&recipient_a), 400_0000000);
    assert_eq!(s.sac_token.balance(&recipient_b), 300_0000000);

    // Accumulators unchanged
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_sac_transfer_zero_amount() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&alice);
    s.contract.unfreeze_account(&bob);
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
    let amount = 500_0000000i128;

    s.contract.unfreeze_account(&alice);
    s.contract.unfreeze_account(&bob);
    s.contract.mint(&s.minter, &alice, &amount);

    // Try to transfer more than alice has
    let result = s.sac_token.try_transfer(&alice, &bob, &1_000_0000000);
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
    let amount = 10_000_0000000i128;

    s.contract.unfreeze_account(&treasury);
    s.contract.unfreeze_account(&recipient);
    s.contract.mint(&s.minter, &treasury, &amount);

    // Set 5% rate and advance 1 year to accrue yield
    s.contract.set_rate(&s.minter, &500);
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
    let mint_amount = 1_000_0000000i128;
    let transfer_amount = 100_0000000i128;

    // Admin unfreezes both users (onboarding)
    s.contract.unfreeze_account(&new_user);
    s.contract.unfreeze_account(&existing_user);

    // Mint to new user
    s.contract.mint(&s.minter, &new_user, &mint_amount);

    // New user can freely transfer to existing user — no authorize_and_transfer needed
    s.sac_token.transfer(&new_user, &existing_user, &transfer_amount);

    assert_eq!(s.sac_token.balance(&new_user), mint_amount - transfer_amount);
    assert_eq!(s.sac_token.balance(&existing_user), transfer_amount);
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

// =============================================================================
// AUTH_REQUIRED IS OPT-IN — DEFAULT ALLOWS RECEIVING
// =============================================================================
//
// AUTH_REQUIRED (IssuerFlags::RequiredFlag) must be explicitly set on the issuer.
// Without it, all accounts are authorized by default and can freely receive tokens.
// These tests prove that blocking is only active because we explicitly enable it.

#[test]
fn test_without_required_flag_accounts_are_authorized_by_default() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    // Register SAC WITHOUT setting RequiredFlag
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_addr = sac.address();
    let sac_token = TokenClient::new(&env, &sac_addr);
    let sac_admin = StellarAssetClient::new(&env, &sac_addr);

    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);

    // Mint directly via SAC admin — no unfreeze needed
    sac_admin.mint(&sender, &1_000_0000000);

    // Transfer succeeds without any authorization — RequiredFlag was never set
    sac_token.transfer(&sender, &receiver, &500_0000000);

    assert_eq!(sac_token.balance(&sender), 500_0000000);
    assert_eq!(sac_token.balance(&receiver), 500_0000000);
}

#[test]
fn test_with_required_flag_new_accounts_are_blocked_by_default() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    // Register SAC WITH RequiredFlag — mirrors our production setup
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    let sac_addr = sac.address();
    let sac_token = TokenClient::new(&env, &sac_addr);
    let sac_admin = StellarAssetClient::new(&env, &sac_addr);

    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);

    // Authorize sender and mint
    sac_admin.set_authorized(&sender, &true);
    sac_admin.mint(&sender, &1_000_0000000);

    // Receiver is NOT authorized — transfer fails
    let result = sac_token.try_transfer(&sender, &receiver, &500_0000000);
    assert!(result.is_err());

    // Authorize receiver — now it works
    sac_admin.set_authorized(&receiver, &true);
    sac_token.transfer(&sender, &receiver, &500_0000000);

    assert_eq!(sac_token.balance(&sender), 500_0000000);
    assert_eq!(sac_token.balance(&receiver), 500_0000000);
}

#[test]
fn test_contract_address_blocked_by_default_due_to_required_flag() {
    // Using our standard setup which has RequiredFlag enabled
    let s = setup();
    let user = Address::generate(&s.env);
    let contract_addr = s.contract.address.clone();
    let amount = 1_000_0000000i128;

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);

    // Contract address was never authorized — blocked by RequiredFlag
    assert!(!s.contract.is_authorized(&contract_addr));

    let result = s.sac_token.try_transfer(&user, &contract_addr, &500_0000000);
    assert!(result.is_err());

    // Only after explicit authorization does it work
    s.contract.unfreeze_account(&contract_addr);
    assert!(s.contract.is_authorized(&contract_addr));

    s.sac_token.transfer(&user, &contract_addr, &500_0000000);
    assert_eq!(s.sac_token.balance(&contract_addr), 500_0000000);
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
    let amount = 1_000_0000000i128;
    let contract_addr = s.contract.address.clone();

    // Authorize user and mint tokens
    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);

    // Contract address is NOT authorized (never unfrozen) — transfer should fail
    let result = s.sac_token.try_transfer(&user, &contract_addr, &500_0000000);
    assert!(result.is_err());

    // User balance unchanged
    assert_eq!(s.sac_token.balance(&user), amount);
}

#[test]
fn test_sac_transfer_to_contract_succeeds_when_contract_authorized() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000_0000000i128;
    let transfer_amount = 400_0000000i128;
    let contract_addr = s.contract.address.clone();

    // Authorize user and mint tokens
    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);

    // Authorize the contract address itself
    s.contract.unfreeze_account(&contract_addr);

    // Transfer to contract address — succeeds but tokens are locked forever
    s.sac_token.transfer(&user, &contract_addr, &transfer_amount);

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
    let amount = 1_000_0000000i128;
    let contract_addr = s.contract.address.clone();

    s.contract.unfreeze_account(&user);
    s.contract.unfreeze_account(&contract_addr);
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
