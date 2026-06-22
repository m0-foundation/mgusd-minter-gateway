use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use crate::constants::MAX_BATCH_SIZE;

use super::setup::*;

// =============================================================================
// BATCH UNBLOCK / BLOCK — happy path
// =============================================================================

#[test]
fn test_batch_unblock_by_registered_blocker() {
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
        .batch_unblock_users(&s.blocker, &accounts, &s.source);

    for account in accounts.iter() {
        assert!(!s.contract.blocked(&account));
    }
}

#[test]
fn test_batch_block_by_registered_blocker() {
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
        .batch_block_users(&s.blocker, &accounts, &s.source);

    for account in accounts.iter() {
        assert!(s.contract.blocked(&account));
    }
}

#[test]
fn test_batch_block_then_unblock() {
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
        .batch_block_users(&s.blocker, &accounts, &s.source);
    for account in accounts.iter() {
        assert!(s.contract.blocked(&account));
    }

    s.contract
        .batch_unblock_users(&s.blocker, &accounts, &s.source);
    for account in accounts.iter() {
        assert!(!s.contract.blocked(&account));
    }
}

#[test]
fn test_batch_unblock_wrong_caller_rejects() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_unblock_users(&s.admin, &accounts, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_batch_block_wrong_caller_rejects() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_block_users(&s.admin, &accounts, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_batch_block_unknown_source_rejects() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);
    let unknown = Symbol::new(&s.env, "ghost");

    let result = s
        .contract
        .try_batch_block_users(&s.blocker, &accounts, &unknown);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnknownSourceError))
    );
}

// =============================================================================
// EDGE CASES
// =============================================================================

#[test]
fn test_batch_block_single_user() {
    let s = setup();
    let account = Address::generate(&s.env);
    let accounts: Vec<Address> = Vec::from_array(&s.env, [account.clone()]);

    s.contract
        .batch_block_users(&s.blocker, &accounts, &s.source);
    assert!(s.contract.blocked(&account));

    s.contract
        .batch_unblock_users(&s.blocker, &accounts, &s.source);
    assert!(!s.contract.blocked(&account));
}

#[test]
fn test_batch_block_empty_vec() {
    let s = setup();
    let accounts: Vec<Address> = Vec::new(&s.env);

    // Empty vec is a no-op, should not panic
    s.contract
        .batch_block_users(&s.blocker, &accounts, &s.source);
    s.contract
        .batch_unblock_users(&s.blocker, &accounts, &s.source);
}

// =============================================================================
// AUTH ENFORCEMENT
// =============================================================================

#[test]
fn test_batch_block_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_block_users(&s.blocker, &accounts, &s.source);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_batch_unblock_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_unblock_users(&s.blocker, &accounts, &s.source);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

// =============================================================================
// ACCESS CONTROL — wrong role rejections
// =============================================================================

#[test]
fn test_minter_cannot_batch_block() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_block_users(&s.minter, &accounts, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_random_cannot_batch_block() {
    let s = setup();
    let random = Address::generate(&s.env);
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s
        .contract
        .try_batch_block_users(&random, &accounts, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

// =============================================================================
// BATCH SIZE LIMITS
// =============================================================================

#[test]
fn test_batch_block_exceeds_max_size() {
    let s = setup();
    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..(MAX_BATCH_SIZE + 1) {
        accounts.push_back(Address::generate(&s.env));
    }

    let result = s
        .contract
        .try_batch_block_users(&s.blocker, &accounts, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::BatchTooLargeError))
    );
}

#[test]
fn test_batch_unblock_at_max_size() {
    let s = setup();
    // Bypass the Rust SDK test harness's shadow budget (see
    // `test_batch_block_at_max_size` for the full explanation).
    s.env.cost_estimate().budget().reset_unlimited();

    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..MAX_BATCH_SIZE {
        accounts.push_back(Address::generate(&s.env));
    }

    // Block all first, then unblock at max size
    s.contract
        .batch_block_users(&s.blocker, &accounts, &s.source);
    s.contract
        .batch_unblock_users(&s.blocker, &accounts, &s.source);

    for account in accounts.iter() {
        assert!(!s.contract.blocked(&account));
    }
}

#[test]
fn test_batch_block_at_max_size() {
    let s = setup();
    // Bypass the Rust SDK test harness's shadow budget, which is consumed by
    // `get_authenticated_authorizations` serializing auth trees for test
    // instrumentation — not a constraint enforced on-chain or in preflight.
    // Real mainnet resource use is asserted in `test_batch_budget.rs` against
    // live per-tx limits (see https://github.com/stellar/stellar-protocol/blob/master/limits/README.md
    // and https://lab.stellar.org/network-limits).
    s.env.cost_estimate().budget().reset_unlimited();

    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..MAX_BATCH_SIZE {
        accounts.push_back(Address::generate(&s.env));
    }

    // Accounts start unauthorized (AUTH_REQUIRED), so freezing is a no-op
    // on auth state but should succeed without hitting resource limits
    s.contract
        .batch_block_users(&s.blocker, &accounts, &s.source);

    for account in accounts.iter() {
        assert!(s.contract.blocked(&account));
    }
}

// =============================================================================
// TRANSFER INTEGRATION — verify block/unblock affects transfers
// =============================================================================

#[test]
fn test_batch_block_blocks_transfers() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    // Authorize and mint to both users
    let users: Vec<Address> =
        Vec::from_array(&s.env, [alice.clone(), bob.clone(), recipient.clone()]);
    s.contract
        .batch_unblock_users(&s.blocker, &users, &s.source);
    s.contract.mint(&s.minter, &alice, &(1_000 * DECIMALS));
    s.contract.mint(&s.minter, &bob, &(1_000 * DECIMALS));

    // Batch block alice and bob
    let to_block: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);
    s.contract
        .batch_block_users(&s.blocker, &to_block, &s.source);

    // Neither can transfer
    let result_alice = s
        .sac_token
        .try_transfer(&alice, &recipient, &(100 * DECIMALS));
    assert!(result_alice.is_err());

    let result_bob = s
        .sac_token
        .try_transfer(&bob, &recipient, &(100 * DECIMALS));
    assert!(result_bob.is_err());
}

#[test]
fn test_batch_unblock_restores_transfers() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    // Authorize, mint, then block
    let all: Vec<Address> =
        Vec::from_array(&s.env, [alice.clone(), bob.clone(), recipient.clone()]);
    s.contract.batch_unblock_users(&s.blocker, &all, &s.source);
    s.contract.mint(&s.minter, &alice, &(1_000 * DECIMALS));
    s.contract.mint(&s.minter, &bob, &(1_000 * DECIMALS));

    let users: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);
    s.contract.batch_block_users(&s.blocker, &users, &s.source);
    s.contract
        .batch_unblock_users(&s.blocker, &users, &s.source);

    // Both can now transfer
    s.sac_token.transfer(&alice, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 100 * DECIMALS);

    s.sac_token.transfer(&bob, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 200 * DECIMALS);
}
