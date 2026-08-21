use soroban_sdk::{
    testutils::Address as _,
    testutils::IssuerFlags,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

use super::setup::{dummy_issuer, setup, DECIMALS};

// =============================================================================
// SEND-TO-ISSUER TESTS
// =============================================================================
//
// KEY FINDINGS:
// 1. The issuer is a separate Stellar account from the SAC admin. The SDK's
//    register_stellar_asset_contract_v2(admin) generates a random issuer, then
//    calls set_admin(admin) on the SAC. Issuer != admin.
// 2. The issuer is EXEMPT from AUTH_REQUIRED — transfers to the issuer succeed
//    even when the issuer has no trustline and is not explicitly authorized.
// 3. The issuer CANNOT be authorized/deauthorized via set_authorized because
//    "issuer doesn't have a trustline" for its own asset.
// 4. Tokens sent to the issuer are destroyed (balance stays 0) — matching
//    Stellar Classic "un-issuing" behavior.
// 5. Frozen senders still CANNOT send to the issuer — sender deauthorization
//    is enforced regardless of recipient.

#[test]
fn test_issuer_is_not_admin() {
    let s = setup();

    // register_stellar_asset_contract_v2(admin) generates a SEPARATE Stellar
    // account as issuer, then sets admin via set_admin. They are distinct.
    assert_ne!(s.issuer, s.admin);
}

#[test]
fn test_send_to_issuer_destroys_tokens() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    let issuer = &s.issuer;

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &amount);
    assert_eq!(s.sac_token.balance(&user), amount);

    // Issuer balance is always i64::MAX (Stellar convention for infinite supply)
    assert_eq!(s.sac_token.balance(issuer), i64::MAX as i128);

    // Issuer is exempt from AUTH_REQUIRED — no need to authorize.
    // Transfer to issuer succeeds even though issuer has no trustline.
    s.sac_token.transfer(&user, issuer, &amount);

    // User balance is zero — tokens sent back to issuer
    assert_eq!(s.sac_token.balance(&user), 0);

    // Issuer balance remains i64::MAX — tokens are absorbed (un-issued),
    // matching Stellar Classic behavior.
    assert_eq!(s.sac_token.balance(issuer), i64::MAX as i128);

    // The contract's accumulators are NOT updated — the contract
    // doesn't know about this direct SAC transfer.
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_frozen_user_cannot_send_to_issuer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    let issuer = &s.issuer;

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &amount);

    // Freeze the user
    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.blocked(&user));

    // Frozen user CANNOT transfer to a normal account
    let other = Address::generate(&s.env);
    s.contract.onboard_user(&other, &s.onboarder);
    let result = s.sac_token.try_transfer(&user, &other, &(100 * DECIMALS));
    assert!(result.is_err());

    // Frozen user also CANNOT send to issuer — sender deauthorization
    // is enforced regardless of recipient (even the exempt issuer)
    let result = s.sac_token.try_transfer(&user, issuer, &amount);
    assert!(result.is_err());

    // User still has tokens (locked)
    assert_eq!(s.sac_token.balance(&user), amount);
}

// =============================================================================
// FREEZE-THE-ISSUER EXPLORATION
// =============================================================================
//
// The issuer is a special Stellar account that is EXEMPT from AUTH_REQUIRED.
// It has no trustline for its own asset. What happens if we try to freeze it?
//
// FINDINGS:
// - freeze_account(issuer) calls set_authorized(issuer, false) on the SAC
// - The SAC REJECTS this with: "issuer doesn't have a trustline"
// - This is because set_authorized modifies the trustline's authorization flag,
//   but the issuer has no trustline for its own asset (by Stellar design)
// - Therefore: the issuer CANNOT be frozen. It is immune to set_authorized.
// - The send-to-issuer bypass CANNOT be mitigated by freezing the issuer.
//
// Mitigation remains: AUTH_REQUIRED + keep users frozen so they can't send
// anywhere (including to issuer). See test_frozen_user_cannot_send_to_issuer.

/// Freezing the issuer PANICS — the SAC rejects set_authorized on the issuer
/// because the issuer has no trustline for its own asset.
#[test]
fn test_block_issuer_panics_no_trustline() {
    let s = setup();
    let issuer = &s.issuer;

    // Attempt to freeze the issuer — should fail because issuer has no trustline.
    // SAC diagnostic: "issuer doesn't have a trustline"
    let result = s.contract.try_block_user(issuer, &s.block_operator);
    assert!(
        result.is_err(),
        "freeze_account(issuer) should fail — issuer has no trustline"
    );
}

/// Unfreezing the issuer also PANICS — same reason, no trustline to modify.
#[test]
fn test_unblock_issuer_panics_no_trustline() {
    let s = setup();
    let issuer = &s.issuer;

    // Attempt to unfreeze the issuer — should also fail (no trustline)
    let result = s.contract.try_unblock_user(issuer, &s.onboarder);
    assert!(
        result.is_err(),
        "unfreeze_account(issuer) should fail — issuer has no trustline"
    );
}

/// is_authorized(issuer) returns true — the issuer is always "authorized"
/// in the sense that it's exempt from AUTH_REQUIRED checks.
#[test]
fn test_issuer_is_always_authorized() {
    let s = setup();
    let issuer = &s.issuer;

    // The issuer is always considered authorized — it's exempt from AUTH_REQUIRED.
    // This is true even though we never explicitly authorized it.
    let authorized = !s.contract.blocked(issuer);
    assert!(
        authorized,
        "Issuer should always report as authorized (exempt from AUTH_REQUIRED)"
    );
}

/// Confirms that freezing the issuer cannot be used as a mitigation for
/// the send-to-issuer bypass. Since freeze panics, the only mitigation
/// is to keep users frozen (AUTH_REQUIRED + deauthorized by default).
#[test]
fn test_issuer_cannot_be_frozen_to_block_send_to_issuer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let issuer = &s.issuer;

    // Setup: authorize user, mint tokens
    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &amount);

    // We CANNOT freeze the issuer to block the bypass
    let freeze_result = s.contract.try_block_user(issuer, &s.block_operator);
    assert!(freeze_result.is_err(), "Cannot freeze issuer");

    // The authorized user CAN still send to issuer (the bypass)
    s.sac_token.transfer(&user, issuer, &(500 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), amount - 500 * DECIMALS);

    // Tokens are destroyed — contract accumulators are stale
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

/// Normal operations remain unaffected by failed freeze attempt on issuer.
/// Minting, claiming yield, and burn all work fine.
#[test]
fn test_operations_work_after_failed_issuer_block() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;
    let issuer = &s.issuer;

    // Attempt to freeze issuer (fails, but shouldn't corrupt state)
    let _ = s.contract.try_block_user(issuer, &s.block_operator);

    // Minting still works
    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &amount);
    assert_eq!(s.sac_token.balance(&user), amount);

    // Set rate and advance time for yield
    s.contract.set_interest_rate(&s.minter, &500); // 5% APY
    super::setup::advance_time(&s.env, 365 * 24 * 3600);

    // Claim yield still works
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);

    // Burn still works
    s.contract.burn(&s.minter, &user, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), amount - 100 * DECIMALS);
}

// =============================================================================
// CONTRACT-AS-ISSUER EXPLORATION
// =============================================================================
//
// Can we make the SAC issuer a contract address (C...) instead of a Classic
// account (G...)? If so, Classic PaymentOp can't target it — there's no
// Classic account to send to, closing the send-to-issuer bypass.
//
// This is exploratory — we don't know if register_stellar_asset_contract_v2
// accepts contract addresses as the issuer.

/// Test 1: Can we even register a SAC with a contract as issuer?
#[test]
fn test_register_sac_with_contract_issuer() {
    let env = Env::default();
    env.mock_all_auths();

    // Register a dummy contract — gives us a C... address
    let issuer_contract = env.register(dummy_issuer::DummyIssuer, ());

    // Try to register SAC with the contract address as issuer
    let sac = env.register_stellar_asset_contract_v2(issuer_contract.clone());

    let sac_addr = sac.address();
    let sac_admin = StellarAssetClient::new(&env, &sac_addr);
    let sac_token = TokenClient::new(&env, &sac_addr);

    // Try setting flags on the contract-issuer
    let issuer_flags = sac.issuer();
    issuer_flags.set_flag(IssuerFlags::RequiredFlag);
    issuer_flags.set_flag(IssuerFlags::RevocableFlag);
    issuer_flags.set_flag(IssuerFlags::ClawbackEnabledFlag);

    // Try to authorize a user and mint
    let user = Address::generate(&env);
    sac_admin.set_authorized(&user, &true);
    sac_admin.mint(&user, &(1000 * DECIMALS));

    assert_eq!(sac_token.balance(&user), 1000 * DECIMALS);
}

/// Test 2: If SAC-with-contract-issuer works, can user send to the issuer?
#[test]
fn test_contract_issuer_blocks_send_to_issuer() {
    let env = Env::default();
    env.mock_all_auths();

    let issuer_contract = env.register(dummy_issuer::DummyIssuer, ());
    let sac = env.register_stellar_asset_contract_v2(issuer_contract.clone());

    let sac_addr = sac.address();
    let sac_admin = StellarAssetClient::new(&env, &sac_addr);
    let sac_token = TokenClient::new(&env, &sac_addr);

    let issuer_flags = sac.issuer();
    issuer_flags.set_flag(IssuerFlags::RequiredFlag);
    issuer_flags.set_flag(IssuerFlags::RevocableFlag);
    issuer_flags.set_flag(IssuerFlags::ClawbackEnabledFlag);

    let user = Address::generate(&env);
    sac_admin.set_authorized(&user, &true);
    sac_admin.mint(&user, &(1000 * DECIMALS));

    // KEY TEST: user tries to transfer to the contract-issuer
    // If issuer is a contract, this should fail (no Classic account to receive)
    let result = sac_token.try_transfer(&user, &issuer_contract, &(500 * DECIMALS));

    if result.is_err() {
        // Contract-issuer blocks the transfer — exactly what we want
        assert_eq!(sac_token.balance(&user), 1000 * DECIMALS);
    } else {
        // Transfer succeeded — check if tokens were destroyed or accumulated
        assert_eq!(sac_token.balance(&user), 500 * DECIMALS);
        let issuer_balance = sac_token.balance(&issuer_contract);
        // issuer_balance == 0 means destroyed, > 0 means accumulated
        panic!(
            "Transfer to contract-issuer SUCCEEDED. Issuer balance: {}. \
             This means contract-issuer does NOT block send-to-issuer.",
            issuer_balance
        );
    }
}

/// Test 3: Compare behavior — transfer to G... issuer vs C... issuer
/// Uses the normal setup (G... issuer) to show the contrast
#[test]
fn test_classic_vs_contract_issuer_comparison() {
    let env = Env::default();
    env.mock_all_auths();

    // --- Classic issuer (G... address) ---
    let classic_admin = Address::generate(&env);
    let sac_classic = env.register_stellar_asset_contract_v2(classic_admin.clone());
    let classic_issuer_flags = sac_classic.issuer();
    classic_issuer_flags.set_flag(IssuerFlags::RequiredFlag);
    classic_issuer_flags.set_flag(IssuerFlags::RevocableFlag);
    classic_issuer_flags.set_flag(IssuerFlags::ClawbackEnabledFlag);

    let classic_sac_addr = sac_classic.address();
    let classic_sac_admin = StellarAssetClient::new(&env, &classic_sac_addr);
    let classic_sac_token = TokenClient::new(&env, &classic_sac_addr);

    let user1 = Address::generate(&env);
    classic_sac_admin.set_authorized(&user1, &true);
    classic_sac_admin.set_authorized(&classic_admin, &true); // authorize issuer
    classic_sac_admin.mint(&user1, &(1000 * DECIMALS));

    // Transfer to G... issuer
    let classic_result = classic_sac_token.try_transfer(&user1, &classic_admin, &(500 * DECIMALS));

    // --- Contract issuer (C... address) ---
    let contract_admin = env.register(dummy_issuer::DummyIssuer, ());
    let sac_contract = env.register_stellar_asset_contract_v2(contract_admin.clone());
    let contract_issuer_flags = sac_contract.issuer();
    contract_issuer_flags.set_flag(IssuerFlags::RequiredFlag);
    contract_issuer_flags.set_flag(IssuerFlags::RevocableFlag);
    contract_issuer_flags.set_flag(IssuerFlags::ClawbackEnabledFlag);

    let contract_sac_addr = sac_contract.address();
    let contract_sac_admin = StellarAssetClient::new(&env, &contract_sac_addr);
    let contract_sac_token = TokenClient::new(&env, &contract_sac_addr);

    let user2 = Address::generate(&env);
    contract_sac_admin.set_authorized(&user2, &true);
    contract_sac_admin.mint(&user2, &(1000 * DECIMALS));

    // Transfer to C... issuer (don't authorize — test if it even matters)
    let contract_result =
        contract_sac_token.try_transfer(&user2, &contract_admin, &(500 * DECIMALS));

    // Report
    let classic_ok = classic_result.is_ok();
    let contract_ok = contract_result.is_ok();

    // We know classic works (G... issuer authorized = tokens accumulate)
    assert!(
        classic_ok,
        "G... issuer transfer should succeed (issuer was authorized)"
    );

    // Document the C... issuer result — either outcome is informative
    if !contract_ok {
        // Contract issuer blocks transfer — this is the mitigation we want!
        assert_eq!(contract_sac_token.balance(&user2), 1000 * DECIMALS);
    }
    // If contract_ok is true, the mitigation doesn't work at the SAC level
}

// =============================================================================
// SEND-TO-ISSUER VIA YIELD CONTRACT
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
    let amount = 1_000 * DECIMALS;
    let send_amount = 400 * DECIMALS;

    // Authorize user and mint tokens
    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &amount);
    assert_eq!(s.sac_token.balance(&user), amount);
    assert!(!s.contract.blocked(&user));

    // User sends tokens to the issuer — tokens are destroyed (un-issued)
    s.sac_token.transfer(&user, &s.issuer, &send_amount);

    // User balance decreased
    assert_eq!(s.sac_token.balance(&user), amount - send_amount);

    // Issuer balance unchanged (always i64::MAX — Stellar convention)
    assert_eq!(s.sac_token.balance(&s.issuer), i64::MAX as i128);

    // User remains authorized — sending to issuer doesn't freeze them
    assert!(!s.contract.blocked(&user));

    // Contract accumulators are NOT updated — the contract doesn't know
    // about this direct SAC transfer. Off-chain must call burn() to reconcile.
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

#[test]
fn test_authorized_user_can_send_full_balance_to_issuer() {
    let s = setup();
    let user = Address::generate(&s.env);
    let amount = 1_000 * DECIMALS;

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &amount);

    // Send entire balance to issuer
    s.sac_token.transfer(&user, &s.issuer, &amount);

    assert_eq!(s.sac_token.balance(&user), 0);
    assert!(!s.contract.blocked(&user));
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
    let amount = 1_000 * DECIMALS;

    // Authorize alice and mint tokens to her
    s.contract.onboard_user(&alice, &s.onboarder);
    s.contract.mint(&s.minter, &alice, &amount);
    assert_eq!(s.sac_token.balance(&alice), amount);

    // Bob is NOT authorized (never called unfreeze_account)
    // Alice tries to transfer directly on the SAC, bypassing our contract
    let result = s.sac_token.try_transfer(&alice, &bob, &(500 * DECIMALS));

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
    let amount = 1_000 * DECIMALS;
    let transfer_amount = 400 * DECIMALS;

    // Authorize both accounts and mint to alice
    s.contract.onboard_user(&alice, &s.onboarder);
    s.contract.onboard_user(&bob, &s.onboarder);
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
    let amount = 1_000 * DECIMALS;
    let allowance_amount = 500 * DECIMALS;

    // Authorize alice and bob, mint to alice
    s.contract.onboard_user(&alice, &s.onboarder);
    s.contract.onboard_user(&bob, &s.onboarder);
    s.contract.mint(&s.minter, &alice, &amount);

    // Alice approves a spender directly on the SAC
    s.sac_token
        .approve(&alice, &spender, &allowance_amount, &1000);

    // Spender calls transfer_from on the SAC — completely bypasses our contract
    s.sac_token
        .transfer_from(&spender, &alice, &bob, &allowance_amount);

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
    let amount = 1_000 * DECIMALS;

    s.contract.onboard_user(&alice, &s.onboarder);
    s.contract.mint(&s.minter, &alice, &amount);

    // Alice approves spender on the SAC
    s.sac_token.approve(&alice, &spender, &amount, &1000);

    // Spender tries transfer_from to deauthorized bob — should fail
    let result = s
        .sac_token
        .try_transfer_from(&spender, &alice, &bob, &(500 * DECIMALS));
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
    sac_admin.mint(&sender, &(1_000 * DECIMALS));

    // Transfer succeeds without any authorization — RequiredFlag was never set
    sac_token.transfer(&sender, &receiver, &(500 * DECIMALS));

    assert_eq!(sac_token.balance(&sender), 500 * DECIMALS);
    assert_eq!(sac_token.balance(&receiver), 500 * DECIMALS);
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
    sac_admin.mint(&sender, &(1_000 * DECIMALS));

    // Receiver is NOT authorized — transfer fails
    let result = sac_token.try_transfer(&sender, &receiver, &(500 * DECIMALS));
    assert!(result.is_err());

    // Authorize receiver — now it works
    sac_admin.set_authorized(&receiver, &true);
    sac_token.transfer(&sender, &receiver, &(500 * DECIMALS));

    assert_eq!(sac_token.balance(&sender), 500 * DECIMALS);
    assert_eq!(sac_token.balance(&receiver), 500 * DECIMALS);
}

#[test]
fn test_contract_address_blocked_by_default_due_to_required_flag() {
    // Using our standard setup which has RequiredFlag enabled
    let s = setup();
    let user = Address::generate(&s.env);
    let contract_addr = s.contract.address.clone();
    let amount = 1_000 * DECIMALS;

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.mint(&s.minter, &user, &amount);

    // Contract address was never authorized — blocked by RequiredFlag
    assert!(s.contract.blocked(&contract_addr));

    let result = s
        .sac_token
        .try_transfer(&user, &contract_addr, &(500 * DECIMALS));
    assert!(result.is_err());

    // Only after explicit authorization does it work
    s.contract.onboard_user(&contract_addr, &s.onboarder);
    assert!(!s.contract.blocked(&contract_addr));

    s.sac_token
        .transfer(&user, &contract_addr, &(500 * DECIMALS));
    assert_eq!(s.sac_token.balance(&contract_addr), 500 * DECIMALS);
}
