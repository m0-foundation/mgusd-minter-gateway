//! STEL1-6 — pre-flag balances are permanently unclawbackable.
//!
//! Stellar's `AUTH_CLAWBACK_ENABLED` flag attaches clawback eligibility at
//! the moment a balance is first credited (per-trustline for classic
//! accounts, per-balance entry for Soroban contract holders). The flag is
//! sticky from that point — flipping the issuer's flag later does *not*
//! retroactively make older balances clawback-eligible.
//!
//! `deployFull` (in the SDK) only sets the flag in step 1, so anyone able
//! to receive a credit from the issuer beforehand becomes a permanent
//! compliance hole. The wrapper's `burn` and `force_transfer` paths both
//! delegate to SAC `clawback`, which fails on these balances.
//!
//! These tests demonstrate the host-level mechanic deterministically. The
//! production mitigation lives in the SDK (`deploy-checks.ts`'s
//! `assertIssuerNotContaminated`); this Rust test pins down *why* that
//! mitigation is necessary.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

use super::setup::{IssuerFlags, StellarAssetClient, TokenClient};

/// First mint *before* the issuer enables `AUTH_CLAWBACK_ENABLED` writes
/// `BalanceValue { clawback: false }` for the recipient. A subsequent
/// clawback attempt (even after the issuer has the flag set) panics with
/// "balance isn't clawbackable".
#[test]
#[should_panic(expected = "balance isn't clawbackable")]
fn test_stel1_6_pre_flag_balance_cannot_be_clawed_back() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let pre_flag_holder = Address::generate(&env);

    // Deploy SAC. Issuer starts with `flags: 0` — no AUTH_CLAWBACK_ENABLED.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer = sac.issuer();
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);

    // Mint to the pre-flag holder while the issuer flag is still unset.
    // The host writes `BalanceValue { clawback: false }` permanently.
    sac_admin_client.mint(&pre_flag_holder, &1_000);

    // Now the issuer enables the flags — exactly what `deployFull`'s
    // step 1 (`configureIssuer`) does on a real deploy. Trustlines /
    // balances created BEFORE this point keep their `clawback: false`.
    issuer.set_flag(IssuerFlags::RequiredFlag);
    issuer.set_flag(IssuerFlags::RevocableFlag);
    issuer.set_flag(IssuerFlags::ClawbackEnabledFlag);

    // Clawback attempt on the pre-flag balance must trip the host's
    // `check_clawbackable` guard.
    sac_admin_client.clawback(&pre_flag_holder, &500);
}

/// Differential: a balance credited *after* the flag flip is clawbackable
/// as expected. Same SAC, same admin, same mint amount — the only
/// difference is the issuer flag at first-credit time.
#[test]
fn test_stel1_6_post_flag_balance_is_clawbackable() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let post_flag_holder = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer = sac.issuer();
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);
    let sac_token = TokenClient::new(&env, &sac_addr);

    // Issuer enables `ClawbackEnabledFlag` *before* any credit lands. We
    // don't toggle `RequiredFlag` here so the new balance is auto-
    // authorized — the property under test is clawback eligibility, not
    // authorization flow.
    issuer.set_flag(IssuerFlags::ClawbackEnabledFlag);

    // Mint to the post-flag holder. The host writes
    // `BalanceValue { clawback: true }` — the balance is clawback-eligible.
    sac_admin_client.mint(&post_flag_holder, &1_000);
    assert_eq!(sac_token.balance(&post_flag_holder), 1_000);

    // Identical clawback to the pre-flag test, but this one succeeds.
    sac_admin_client.clawback(&post_flag_holder, &500);
    assert_eq!(sac_token.balance(&post_flag_holder), 500);
}

/// The flag flip itself is *not* retroactive: even after the issuer
/// enables `ClawbackEnabledFlag`, a balance that was first credited
/// pre-flag stays unclawbackable. This is the single property that makes
/// STEL1-6 unrecoverable without issuer rotation.
#[test]
#[should_panic(expected = "balance isn't clawbackable")]
fn test_stel1_6_flag_flip_is_not_retroactive() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let pre_flag_holder = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer = sac.issuer();
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);

    // Step 1: pre-flag mint. Balance.clawback = false sticks.
    sac_admin_client.mint(&pre_flag_holder, &1_000);

    // Step 2: issuer enables the flag.
    issuer.set_flag(IssuerFlags::ClawbackEnabledFlag);

    // Step 3: subsequent credit to the SAME holder. The host does not
    // re-evaluate `is_asset_clawback_enabled` on subsequent credits to an
    // existing balance — the original `clawback: false` stays.
    sac_admin_client.mint(&pre_flag_holder, &500);

    // Even though the issuer has the flag set now and we just minted
    // another 500, the original balance entry is still flagged
    // `clawback: false`, so the whole position is uncollectible.
    sac_admin_client.clawback(&pre_flag_holder, &100);
}
