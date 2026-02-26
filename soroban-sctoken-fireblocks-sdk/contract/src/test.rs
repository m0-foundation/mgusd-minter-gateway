#![cfg(test)]

use crate::{SacAdminContract, SacAdminContractClient};
use soroban_sdk::{
    testutils::{Address as _, IssuerFlags},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

/// Register a SAC with clawback enabled and transfer admin to our contract.
/// Returns (contract_client, sac_token_client, admin, sac_address).
fn setup() -> (
    SacAdminContractClient<'static>,
    TokenClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    // Register SAC with admin as initial issuer
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer_handle = sac.issuer();
    issuer_handle.set_flag(IssuerFlags::RevocableFlag);
    issuer_handle.set_flag(IssuerFlags::ClawbackEnabledFlag);

    let sac_addr = sac.address();

    // Register our contract with constructor args
    let contract_id = env.register(SacAdminContract, (&sac_addr, &admin));

    // Transfer SAC admin to our contract so it can mint/clawback
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);
    sac_admin_client.set_admin(&contract_id);

    let client = SacAdminContractClient::new(&env, &contract_id);
    let sac_token = TokenClient::new(&env, &sac_addr);

    (client, sac_token, admin, sac_addr)
}

#[test]
fn test_constructor_stores_values() {
    let (client, _, admin, sac_addr) = setup();

    assert_eq!(client.admin(), admin);
    assert_eq!(client.sac_token(), sac_addr);
}

#[test]
fn test_mint() {
    let (client, sac_token, _, _) = setup();
    let recipient = Address::generate(&client.env);

    client.mint(&recipient, &1000);

    assert_eq!(sac_token.balance(&recipient), 1000);
}

#[test]
fn test_mint_multiple_recipients() {
    let (client, sac_token, _, _) = setup();
    let alice = Address::generate(&client.env);
    let bob = Address::generate(&client.env);

    client.mint(&alice, &500);
    client.mint(&bob, &300);

    assert_eq!(sac_token.balance(&alice), 500);
    assert_eq!(sac_token.balance(&bob), 300);
}

#[test]
fn test_burn() {
    let (client, sac_token, _, _) = setup();
    let user = Address::generate(&client.env);

    client.mint(&user, &1000);
    client.burn(&user, &400);

    assert_eq!(sac_token.balance(&user), 600);
}

#[test]
fn test_burn_full_balance() {
    let (client, sac_token, _, _) = setup();
    let user = Address::generate(&client.env);

    client.mint(&user, &1000);
    client.burn(&user, &1000);

    assert_eq!(sac_token.balance(&user), 0);
}

#[test]
fn test_mint_negative_panics() {
    let (client, _, _, _) = setup();
    let recipient = Address::generate(&client.env);

    let result = client.try_mint(&recipient, &-100);
    assert!(result.is_err());
}

#[test]
fn test_burn_negative_panics() {
    let (client, _, _, _) = setup();
    let user = Address::generate(&client.env);

    let result = client.try_burn(&user, &-100);
    assert!(result.is_err());
}
