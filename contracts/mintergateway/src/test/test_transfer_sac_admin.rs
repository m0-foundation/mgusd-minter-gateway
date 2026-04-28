use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;

use super::setup::*;

/// Full lifecycle: contract owns SAC - mint works, hand off to external account -
/// mint fails, hand back to contract - mint works again.
#[test]
fn test_transfer_sac_admin_revokes_and_restores_mint_capability() {
    let s = setup();
    let user = Address::generate(&s.env);
    let external_owner = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);

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
