use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use super::setup::*;

// =============================================================================
// BATCH UNFREEZE / FREEZE — happy path
// =============================================================================

#[test]
fn test_batch_unfreeze_by_distributor() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(
        &s.env,
        [
            Address::generate(&s.env),
            Address::generate(&s.env),
            Address::generate(&s.env),
        ],
    );

    s.contract
        .batch_unfreeze_accounts(&s.distributor, &accounts);

    for account in accounts.iter() {
        assert!(s.contract.is_authorized(&account));
    }
}

#[test]
fn test_batch_freeze_by_distributor() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(
        &s.env,
        [
            Address::generate(&s.env),
            Address::generate(&s.env),
            Address::generate(&s.env),
        ],
    );

    // First authorize all accounts
    s.contract
        .batch_unfreeze_accounts(&s.distributor, &accounts);

    // Then freeze them
    s.contract
        .batch_freeze_accounts(&s.distributor, &accounts);

    for account in accounts.iter() {
        assert!(!s.contract.is_authorized(&account));
    }
}

#[test]
fn test_batch_unfreeze_by_admin() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(
        &s.env,
        [
            Address::generate(&s.env),
            Address::generate(&s.env),
            Address::generate(&s.env),
        ],
    );

    s.contract.batch_unfreeze_accounts(&s.admin, &accounts);

    for account in accounts.iter() {
        assert!(s.contract.is_authorized(&account));
    }
}

#[test]
fn test_batch_freeze_by_admin() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(
        &s.env,
        [
            Address::generate(&s.env),
            Address::generate(&s.env),
            Address::generate(&s.env),
        ],
    );

    s.contract.batch_unfreeze_accounts(&s.admin, &accounts);
    s.contract.batch_freeze_accounts(&s.admin, &accounts);

    for account in accounts.iter() {
        assert!(!s.contract.is_authorized(&account));
    }
}

// =============================================================================
// EDGE CASES
// =============================================================================

#[test]
fn test_batch_freeze_single_account() {
    let s = setup();
    let account = Address::generate(&s.env);
    let accounts: Vec<Address> = Vec::from_array(&s.env, [account.clone()]);

    s.contract
        .batch_unfreeze_accounts(&s.distributor, &accounts);
    assert!(s.contract.is_authorized(&account));

    s.contract
        .batch_freeze_accounts(&s.distributor, &accounts);
    assert!(!s.contract.is_authorized(&account));
}

#[test]
fn test_batch_freeze_empty_vec() {
    let s = setup();
    let accounts: Vec<Address> = Vec::new(&s.env);

    // Empty vec is a no-op, should not panic
    s.contract
        .batch_freeze_accounts(&s.distributor, &accounts);
    s.contract
        .batch_unfreeze_accounts(&s.distributor, &accounts);
}

// =============================================================================
// AUTH ENFORCEMENT
// =============================================================================

#[test]
fn test_batch_freeze_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_freeze_accounts(&s.distributor, &accounts);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_batch_unfreeze_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_unfreeze_accounts(&s.distributor, &accounts);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

// =============================================================================
// ACCESS CONTROL — wrong role rejections
// =============================================================================

#[test]
fn test_minter_cannot_batch_freeze() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_freeze_accounts(&s.minter, &accounts);
    assert_eq!(
        result,
        Err(Ok(crate::YieldTokenError::UnauthorizedError))
    );
}

#[test]
fn test_random_cannot_batch_freeze() {
    let s = setup();
    let random = Address::generate(&s.env);
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_freeze_accounts(&random, &accounts);
    assert_eq!(
        result,
        Err(Ok(crate::YieldTokenError::UnauthorizedError))
    );
}

// =============================================================================
// BATCH SIZE LIMITS
// =============================================================================

#[test]
fn test_batch_freeze_exceeds_max_size() {
    let s = setup();
    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..41 {
        accounts.push_back(Address::generate(&s.env));
    }

    let result = s
        .contract
        .try_batch_freeze_accounts(&s.distributor, &accounts);
    assert_eq!(
        result,
        Err(Ok(crate::YieldTokenError::BatchTooLargeError))
    );
}

#[test]
fn test_batch_unfreeze_at_max_size() {
    let s = setup();
    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..40 {
        accounts.push_back(Address::generate(&s.env));
    }

    // Should succeed at exactly 40
    s.contract
        .batch_unfreeze_accounts(&s.distributor, &accounts);

    for account in accounts.iter() {
        assert!(s.contract.is_authorized(&account));
    }
}

#[test]
fn test_batch_freeze_at_max_size() {
    let s = setup();
    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..40 {
        accounts.push_back(Address::generate(&s.env));
    }

    // Accounts start unauthorized (AUTH_REQUIRED), so freezing is a no-op
    // on auth state but should succeed without hitting resource limits
    s.contract
        .batch_freeze_accounts(&s.distributor, &accounts);

    for account in accounts.iter() {
        assert!(!s.contract.is_authorized(&account));
    }
}

// =============================================================================
// TRANSFER INTEGRATION — verify freeze/unfreeze affects transfers
// =============================================================================

#[test]
fn test_batch_freeze_blocks_transfers() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    // Authorize and mint to both users
    let users: Vec<Address> =
        Vec::from_array(&s.env, [alice.clone(), bob.clone(), recipient.clone()]);
    s.contract.batch_unfreeze_accounts(&s.admin, &users);
    s.contract.mint(&s.minter, &alice, &1_000_0000000);
    s.contract.mint(&s.minter, &bob, &1_000_0000000);

    // Batch freeze alice and bob
    let to_freeze: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);
    s.contract
        .batch_freeze_accounts(&s.distributor, &to_freeze);

    // Neither can transfer
    let result_alice = s.sac_token.try_transfer(&alice, &recipient, &100_0000000);
    assert!(result_alice.is_err());

    let result_bob = s.sac_token.try_transfer(&bob, &recipient, &100_0000000);
    assert!(result_bob.is_err());
}

#[test]
fn test_batch_unfreeze_restores_transfers() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    // Authorize, mint, then freeze
    let all: Vec<Address> =
        Vec::from_array(&s.env, [alice.clone(), bob.clone(), recipient.clone()]);
    s.contract.batch_unfreeze_accounts(&s.admin, &all);
    s.contract.mint(&s.minter, &alice, &1_000_0000000);
    s.contract.mint(&s.minter, &bob, &1_000_0000000);

    let users: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);
    s.contract.batch_freeze_accounts(&s.admin, &users);

    // Batch unfreeze
    s.contract
        .batch_unfreeze_accounts(&s.distributor, &users);

    // Both can now transfer
    s.sac_token.transfer(&alice, &recipient, &100_0000000);
    assert_eq!(s.sac_token.balance(&recipient), 100_0000000);

    s.sac_token.transfer(&bob, &recipient, &100_0000000);
    assert_eq!(s.sac_token.balance(&recipient), 200_0000000);
}
