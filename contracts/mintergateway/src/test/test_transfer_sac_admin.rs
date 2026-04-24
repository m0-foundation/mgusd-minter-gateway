use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;

use super::setup::*;

/// Test flow:
///   1. Contract A mints/burns, verify SAC balance and contract supply match
///   2. Transfer SAC admin from A to B
///   3. Contract A can no longer mint/burn
///   4. Contract B mints/burns, verify SAC balance and both contracts' supply
#[test]
fn test_transfer_sac_admin_to_second_contract() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Deploy a second contract
    let admin2 = Address::generate(&s.env);
    let minter2 = Address::generate(&s.env);
    let blocker2 = Address::generate(&s.env);
    let pauser2 = Address::generate(&s.env);
    let contract2_addr = s.env.register(
        YieldToken,
        (
            &s.sac_token.address,
            &admin2,
            &minter2,
            &Address::generate(&s.env),
            &Address::generate(&s.env),
            &Address::generate(&s.env),
            &blocker2,
            &pauser2,
        ),
    );
    let contract2 = YieldTokenClient::new(&s.env, &contract2_addr);

    // Contract A is SAC admin
    s.contract.unblock_user(&user, &s.blocker);
    s.contract.mint(&s.minter, &user, &(200 * DECIMALS));
    s.contract.burn(&s.minter, &user, &(50 * DECIMALS));

    assert_eq!(s.sac_token.balance(&user), 150 * DECIMALS);
    assert_eq!(s.contract.total_supply(), 150 * DECIMALS);
    assert_eq!(s.contract.total_principal(), 150 * DECIMALS);

    // Contract B has no supply
    assert_eq!(contract2.total_supply(), 0);

    // Transfer SAC admin from A to B
    s.contract.transfer_sac_admin(&contract2_addr);

    // Contract A can no longer mint or burn
    assert!(s
        .contract
        .try_mint(&s.minter, &user, &(10 * DECIMALS))
        .is_err());
    assert!(s
        .contract
        .try_burn(&s.minter, &user, &(10 * DECIMALS))
        .is_err());

    // Contract B is SAC admin
    contract2.unblock_user(&user, &blocker2);
    contract2.mint(&minter2, &user, &(100 * DECIMALS));

    // SAC balance increased; contract B tracks its own supply
    assert_eq!(s.sac_token.balance(&user), 250 * DECIMALS);
    assert_eq!(contract2.total_supply(), 100 * DECIMALS);
    assert_eq!(contract2.total_principal(), 100 * DECIMALS);

    // Contract A supply is unaffected
    assert_eq!(s.contract.total_supply(), 150 * DECIMALS);

    contract2.burn(&minter2, &user, &(30 * DECIMALS));

    assert_eq!(s.sac_token.balance(&user), 220 * DECIMALS);
    assert_eq!(contract2.total_supply(), 70 * DECIMALS);
    assert_eq!(contract2.total_principal(), 70 * DECIMALS);

    // Contract A supply is unaffected
    assert_eq!(s.contract.total_supply(), 150 * DECIMALS);
}

/// Full lifecycle: contract owns SAC - mint works, hand off to external account -
/// mint fails, hand back to contract - mint works again.
#[test]
fn test_transfer_sac_admin_revokes_and_restores_mint_capability() {
    let s = setup();
    let user = Address::generate(&s.env);
    let external_owner = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.blocker);

    // Contract is SAC admin — mint should succeed.
    s.contract.mint(&s.minter, &user, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), 100 * DECIMALS);

    // Transfer SAC admin from contract to external_owner.
    s.contract.transfer_sac_admin(&external_owner);

    // Contract is no SAC admin — mint should fail.
    assert!(s
        .contract
        .try_mint(&s.minter, &user, &(100 * DECIMALS))
        .is_err());

    assert_eq!(s.sac_token.balance(&user), 100 * DECIMALS);
    assert_eq!(s.contract.total_supply(), 100 * DECIMALS);

    // Transfer SAC admin back to the contract.
    StellarAssetClient::new(&s.env, &s.sac_token.address).set_admin(&s.contract.address);

    // Contract is SAC admin — mint should succeed.
    s.contract.mint(&s.minter, &user, &(50 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), 150 * DECIMALS);
    assert_eq!(s.contract.total_principal(), 150 * DECIMALS);
}
