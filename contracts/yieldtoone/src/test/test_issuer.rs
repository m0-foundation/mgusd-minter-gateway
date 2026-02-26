use soroban_sdk::{
    testutils::Address as _,
    testutils::IssuerFlags,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

use super::setup::{dummy_issuer, setup};

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
    let amount = 1_000_0000000i128;

    let issuer = &s.issuer;

    s.contract.unfreeze_account(&user);
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
    let amount = 1_000_0000000i128;

    let issuer = &s.issuer;

    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);

    // Freeze the user
    s.contract.freeze_account(&user);
    assert!(!s.contract.is_authorized(&user));

    // Frozen user CANNOT transfer to a normal account
    let other = Address::generate(&s.env);
    s.contract.unfreeze_account(&other);
    let result = s.sac_token.try_transfer(&user, &other, &100_0000000);
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
fn test_freeze_issuer_panics_no_trustline() {
    let s = setup();
    let issuer = &s.issuer;

    // Attempt to freeze the issuer — should fail because issuer has no trustline.
    // SAC diagnostic: "issuer doesn't have a trustline"
    let result = s.contract.try_freeze_account(issuer);
    assert!(
        result.is_err(),
        "freeze_account(issuer) should fail — issuer has no trustline"
    );
}

/// Unfreezing the issuer also PANICS — same reason, no trustline to modify.
#[test]
fn test_unfreeze_issuer_panics_no_trustline() {
    let s = setup();
    let issuer = &s.issuer;

    // Attempt to unfreeze the issuer — should also fail (no trustline)
    let result = s.contract.try_unfreeze_account(issuer);
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
    let authorized = s.contract.is_authorized(issuer);
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
    let amount = 1_000_0000000i128;
    let issuer = &s.issuer;

    // Setup: authorize user, mint tokens
    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);

    // We CANNOT freeze the issuer to block the bypass
    let freeze_result = s.contract.try_freeze_account(issuer);
    assert!(freeze_result.is_err(), "Cannot freeze issuer");

    // The authorized user CAN still send to issuer (the bypass)
    s.sac_token.transfer(&user, issuer, &500_0000000);
    assert_eq!(s.sac_token.balance(&user), amount - 500_0000000);

    // Tokens are destroyed — contract accumulators are stale
    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);
}

/// Normal operations remain unaffected by failed freeze attempt on issuer.
/// Minting, claiming yield, clawback, and authorize_and_transfer all work fine.
#[test]
fn test_operations_work_after_failed_issuer_freeze() {
    let s = setup();
    let user = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let amount = 1_000_0000000i128;
    let issuer = &s.issuer;

    // Attempt to freeze issuer (fails, but shouldn't corrupt state)
    let _ = s.contract.try_freeze_account(issuer);

    // Minting still works
    s.contract.unfreeze_account(&user);
    s.contract.mint(&s.minter, &user, &amount);
    assert_eq!(s.sac_token.balance(&user), amount);

    // Set rate and advance time for yield
    s.contract.set_rate(&s.minter, &500); // 5% APY
    super::setup::advance_time(&s.env, 365 * 24 * 3600);

    // Claim yield still works
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);

    // Clawback still works
    s.contract.freeze_account(&user);
    s.contract.clawback(&user, &100_0000000);
    assert_eq!(s.sac_token.balance(&user), amount - 100_0000000);

    // authorize_and_transfer still works
    s.contract.unfreeze_account(&treasury);
    s.contract.mint(&s.minter, &treasury, &500_0000000);
    s.contract
        .authorize_and_transfer(&s.forced_transfer_manager, &treasury, &recipient, &200_0000000);
    assert_eq!(s.sac_token.balance(&recipient), 200_0000000);
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
    sac_admin.mint(&user, &1000_0000000);

    assert_eq!(sac_token.balance(&user), 1000_0000000);
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
    sac_admin.mint(&user, &1000_0000000);

    // KEY TEST: user tries to transfer to the contract-issuer
    // If issuer is a contract, this should fail (no Classic account to receive)
    let result = sac_token.try_transfer(&user, &issuer_contract, &500_0000000);

    if result.is_err() {
        // Contract-issuer blocks the transfer — exactly what we want
        assert_eq!(sac_token.balance(&user), 1000_0000000);
    } else {
        // Transfer succeeded — check if tokens were destroyed or accumulated
        assert_eq!(sac_token.balance(&user), 500_0000000);
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
    classic_sac_admin.mint(&user1, &1000_0000000);

    // Transfer to G... issuer
    let classic_result = classic_sac_token.try_transfer(&user1, &classic_admin, &500_0000000);

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
    contract_sac_admin.mint(&user2, &1000_0000000);

    // Transfer to C... issuer (don't authorize — test if it even matters)
    let contract_result = contract_sac_token.try_transfer(&user2, &contract_admin, &500_0000000);

    // Report
    let classic_ok = classic_result.is_ok();
    let contract_ok = contract_result.is_ok();

    // We know classic works (G... issuer authorized = tokens accumulate)
    assert!(classic_ok, "G... issuer transfer should succeed (issuer was authorized)");

    // Document the C... issuer result — either outcome is informative
    if !contract_ok {
        // Contract issuer blocks transfer — this is the mitigation we want!
        assert_eq!(contract_sac_token.balance(&user2), 1000_0000000);
    }
    // If contract_ok is true, the mitigation doesn't work at the SAC level
}
