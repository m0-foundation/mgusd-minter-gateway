//! STEL1-6 — pre-flag *trustlines* are permanently unclawbackable.
//!
//! These tests reproduce the audit's PoC scenario at the Soroban host
//! level. The audit's reproduction:
//!
//!   1. Attacker submits `Operation.changeTrust(asset_code, issuer)` —
//!      they only need the issuer's pubkey + asset code, neither of
//!      which is secret on Stellar.
//!   2. The trustline is created with whatever issuer flags exist *at
//!      that moment*. Pre-deploy, the issuer has none, so the trustline
//!      gets `AuthorizedFlag` (auto-authorized; AUTH_REQUIRED isn't set
//!      either) but NOT `TrustlineClawbackEnabledFlag`.
//!   3. Issuer later runs `setOptions(AUTH_CLAWBACK_ENABLED | …)` —
//!      exactly what `deployFull`'s step 1 (`configureIssuer`) does.
//!      The flag set on the issuer is *not* retroactively applied to
//!      existing trustlines.
//!   4. The wrapper later mints to the trustor through normal
//!      operations.
//!   5. Any clawback attempt against that trustline panics with
//!      "trustline isn't clawbackable" — the wrapper's `burn` and
//!      `force_transfer` paths both delegate here, so the position is
//!      permanently outside the seizure model.
//!
//! Each test below mirrors that flow at the host level, using a manually
//! crafted `TrustLineEntry` ledger entry to stand in for the
//! `changeTrust` op. The production fix lives in the SDK
//! (`assertIssuerNotContaminated` in `deploy-checks.ts`); these tests
//! pin down *why* a pre-deploy contamination check is the only viable
//! mitigation — the trustline's flag is set at trustline-creation time
//! and the issuer's later flag flip is not retroactive.

extern crate alloc;
use alloc::rc::Rc;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::{
    AccountEntry, AccountEntryExt, AccountId, Asset, LedgerEntry, LedgerEntryData, LedgerEntryExt,
    LedgerKey, LedgerKeyAccount, LedgerKeyTrustLine, PublicKey, ScAddress, SequenceNumber, String32,
    Thresholds, TrustLineAsset, TrustLineEntry, TrustLineEntryExt, TrustLineFlags, Uint256,
};
use soroban_sdk::{Address, Env, TryIntoVal};

use super::setup::{IssuerFlags, StellarAssetClient, TokenClient};

/// Build a deterministic classic Stellar `AccountId` for use as a
/// "trustor" — the equivalent of a random user generating a Stellar
/// keypair and submitting `changeTrust`.
fn make_account_id(seed: u8) -> AccountId {
    AccountId(PublicKey::PublicKeyTypeEd25519(Uint256([seed; 32])))
}

/// Convert an `AccountId` into the Soroban `Address` form the SAC
/// client's `mint` / `clawback` expect.
fn account_id_to_address(env: &Env, id: &AccountId) -> Address {
    ScAddress::Account(id.clone()).try_into_val(env).unwrap()
}

/// Write a minimal classic Stellar `AccountEntry` to the test ledger so
/// the account can hold trustlines. Required because the SAC's classic-
/// path `transfer_trustline_balance` expects an existing trustline
/// ledger entry to credit, and trustlines in turn require an account.
fn add_account_entry(env: &Env, account_id: &AccountId) {
    let key = Rc::new(LedgerKey::Account(LedgerKeyAccount {
        account_id: account_id.clone(),
    }));
    let entry = Rc::new(LedgerEntry {
        data: LedgerEntryData::Account(AccountEntry {
            account_id: account_id.clone(),
            balance: 1_000_000_000, // 100 XLM, comfortably above min reserve
            flags: 0,
            home_domain: String32::default(),
            inflation_dest: None,
            num_sub_entries: 1, // one trustline
            seq_num: SequenceNumber(0),
            thresholds: Thresholds([1; 4]),
            signers: Default::default(),
            ext: AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: LedgerEntryExt::V0,
    });
    env.host().add_ledger_entry(&key, &entry, None).unwrap();
}

/// Open a classic Stellar trustline for `account_id` against the SAC's
/// underlying asset, with the supplied `flags`. **This is the moral
/// equivalent of the attacker submitting `Operation.changeTrust` in the
/// audit's PoC.** When the issuer has no flags set, the resulting
/// trustline gets `AuthorizedFlag` but NOT
/// `TrustlineClawbackEnabledFlag` — the contamination state STEL1-6
/// describes.
fn open_trustline(env: &Env, account_id: &AccountId, asset: &Asset, flags: u32) {
    let trustline_asset = match asset {
        Asset::CreditAlphanum4(a) => TrustLineAsset::CreditAlphanum4(a.clone()),
        Asset::CreditAlphanum12(a) => TrustLineAsset::CreditAlphanum12(a.clone()),
        Asset::Native => panic!("native asset not supported in this test"),
    };
    let key = Rc::new(LedgerKey::Trustline(LedgerKeyTrustLine {
        account_id: account_id.clone(),
        asset: trustline_asset.clone(),
    }));
    let entry = Rc::new(LedgerEntry {
        data: LedgerEntryData::Trustline(TrustLineEntry {
            account_id: account_id.clone(),
            asset: trustline_asset,
            balance: 0,
            limit: i64::MAX,
            flags,
            ext: TrustLineEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: LedgerEntryExt::V0,
    });
    env.host().add_ledger_entry(&key, &entry, None).unwrap();
}

/// **Goal of this test: prove that a trustline opened pre-flag is
/// permanently unclawbackable, even after the issuer later enables
/// AUTH_CLAWBACK_ENABLED.** This is the audit's PoC scenario reproduced
/// at the host level.
#[test]
#[should_panic(expected = "trustline isn't clawbackable")]
fn test_stel1_6_pre_flag_trustline_cannot_be_clawed_back() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let trustor_id = make_account_id(0xab);
    let trustor = account_id_to_address(&env, &trustor_id);

    // Deploy the SAC. Issuer starts with `flags: 0` — the pre-deploy
    // state. AUTH_CLAWBACK_ENABLED is NOT yet set.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer = sac.issuer();
    let asset = sac.asset();
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);

    // STEP 1 of the audit's PoC: the trustor opens a trustline before
    // any issuer flags are set. The host writes an `AuthorizedFlag`-only
    // trustline — no `TrustlineClawbackEnabledFlag`. This is the
    // contamination state STEL1-6 describes.
    add_account_entry(&env, &trustor_id);
    open_trustline(
        &env,
        &trustor_id,
        &asset,
        TrustLineFlags::AuthorizedFlag as u32, // no clawback bit
    );

    // STEP 2: issuer enables AUTH_CLAWBACK_ENABLED — exactly what
    // `deployFull`'s step 1 (`configureIssuer`) does. The pre-flag
    // trustline is NOT updated by this; trustline flags are immutable
    // after creation except by issuer-driven authorize/revoke ops.
    issuer.set_flag(IssuerFlags::ClawbackEnabledFlag);

    // STEP 3: wrapper-style mint to the pre-flag trustline. Goes through
    // the classic-Stellar `transfer_trustline_balance` path, finds the
    // existing trustline, credits its balance.
    sac_admin_client.mint(&trustor, &1_000);

    // STEP 4: clawback. The host reads the trustline's flags, finds
    // `TrustlineClawbackEnabledFlag` missing, and panics with
    // "trustline isn't clawbackable" — exactly the
    // `op_not_clawback_enabled` outcome the audit's testnet PoC
    // produces.
    sac_admin_client.clawback(&trustor, &500);
}

/// **Goal of this test: prove the differential.** A trustline opened
/// *after* AUTH_CLAWBACK_ENABLED is set IS clawbackable. Same SAC, same
/// admin, same mint amount — only the trustline flags at creation time
/// differ. Confirms the bug above is specifically about
/// trustline-creation-time flag inheritance, not some other
/// configuration issue.
#[test]
fn test_stel1_6_post_flag_trustline_is_clawbackable() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let trustor_id = make_account_id(0xcd);
    let trustor = account_id_to_address(&env, &trustor_id);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer = sac.issuer();
    let asset = sac.asset();
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);
    let sac_token = TokenClient::new(&env, &sac_addr);

    // Issuer enables `ClawbackEnabledFlag` BEFORE the trustline opens.
    // (Skipping `RequiredFlag` so the trustline doesn't need explicit
    // authorization — the property under test is clawback eligibility.)
    issuer.set_flag(IssuerFlags::ClawbackEnabledFlag);

    // The trustor opens a post-flag trustline with both
    // `AuthorizedFlag` and `TrustlineClawbackEnabledFlag` — the flag
    // state Stellar would write at `changeTrust` time given the
    // issuer's current flags.
    add_account_entry(&env, &trustor_id);
    open_trustline(
        &env,
        &trustor_id,
        &asset,
        (TrustLineFlags::AuthorizedFlag as u32)
            | (TrustLineFlags::TrustlineClawbackEnabledFlag as u32),
    );

    sac_admin_client.mint(&trustor, &1_000);
    assert_eq!(sac_token.balance(&trustor), 1_000);

    // Same clawback shape as the pre-flag test, but this trustline IS
    // clawback-eligible. Balance reduced as expected.
    sac_admin_client.clawback(&trustor, &500);
    assert_eq!(sac_token.balance(&trustor), 500);
}

/// **Goal of this test: prove the issuer's later flag flip is *not*
/// retroactive — the property that makes STEL1-6 unrecoverable without
/// issuer rotation.** Even after the issuer enables clawback and
/// additional credits land on the same trustline, the trustline's flags
/// stay as they were at creation, so clawback still fails.
#[test]
#[should_panic(expected = "trustline isn't clawbackable")]
fn test_stel1_6_flag_flip_does_not_repair_pre_flag_trustline() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let trustor_id = make_account_id(0xef);
    let trustor = account_id_to_address(&env, &trustor_id);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer = sac.issuer();
    let asset = sac.asset();
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);

    // Pre-flag trustline opens.
    add_account_entry(&env, &trustor_id);
    open_trustline(
        &env,
        &trustor_id,
        &asset,
        TrustLineFlags::AuthorizedFlag as u32,
    );

    // Issuer NOW sets `ClawbackEnabledFlag`.
    issuer.set_flag(IssuerFlags::ClawbackEnabledFlag);

    // First mint lands. Trustline is funded normally.
    sac_admin_client.mint(&trustor, &1_000);

    // Second mint — note the issuer's flag has been set the whole time
    // for this credit. But trustline flags are *trustline-creation-time*
    // metadata, not per-credit metadata. The host reads the trustline's
    // own flags at clawback time, and they still don't include
    // `TrustlineClawbackEnabledFlag`. The whole position remains
    // uncollectible.
    sac_admin_client.mint(&trustor, &500);

    sac_admin_client.clawback(&trustor, &100);
}
