use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use crate::constants::MAX_BATCH_SIZE;

use super::setup::*;

// =============================================================================
// BATCH UNBLOCK / BLOCK — happy path
// =============================================================================

#[test]
fn test_batch_unblock_by_unblock_operator() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(
        &s.env,
        [
            Address::generate(&s.env),
            Address::generate(&s.env),
            Address::generate(&s.env),
        ],
    );

    // Onboard, then block, then verify batch_unblock_users restores authorization
    s.contract.batch_onboard_users(&accounts, &s.onboarder);
    s.contract.batch_block_users(&accounts, &s.block_operator);
    s.contract
        .batch_unblock_users(&accounts, &s.unblock_operator);

    for account in accounts.iter() {
        assert!(!s.contract.blocked(&account));
    }
}

#[test]
fn test_batch_block_by_block_operator() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(
        &s.env,
        [
            Address::generate(&s.env),
            Address::generate(&s.env),
            Address::generate(&s.env),
        ],
    );

    // Onboard, then block
    s.contract.batch_onboard_users(&accounts, &s.onboarder);
    s.contract.batch_block_users(&accounts, &s.block_operator);

    for account in accounts.iter() {
        assert!(s.contract.blocked(&account));
    }
}

#[test]
fn test_batch_unblock_admin_unauthorized() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s.contract.try_batch_unblock_users(&accounts, &s.admin);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_batch_block_admin_unauthorized() {
    let s = setup();
    let accounts: Vec<Address> = Vec::from_array(&s.env, [Address::generate(&s.env)]);

    let result = s.contract.try_batch_block_users(&accounts, &s.admin);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
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

    s.contract.onboard_user(&account, &s.onboarder);
    assert!(!s.contract.blocked(&account));

    s.contract.batch_block_users(&accounts, &s.block_operator);
    assert!(s.contract.blocked(&account));
}

#[test]
fn test_batch_block_empty_vec() {
    let s = setup();
    let accounts: Vec<Address> = Vec::new(&s.env);

    // Empty vec is a no-op, should not panic
    s.contract.batch_block_users(&accounts, &s.block_operator);
    s.contract
        .batch_unblock_users(&accounts, &s.unblock_operator);
}

// =============================================================================
// IDEMPOTENCY — already-in-state addresses are skipped, no duplicate events
// =============================================================================

#[test]
fn test_block_user_already_blocked_is_noop() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.onboard_user(&user, &s.onboarder);
    s.contract.block_user(&user, &s.block_operator);

    // Second block is a silent no-op: no duplicate user_blocked event
    s.contract.block_user(&user, &s.block_operator);
    s.assert_no_events();
    assert!(s.contract.is_on_block_list(&user));
    assert!(s.contract.blocked(&user));
}

#[test]
fn test_unblock_user_not_blocked_is_noop() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.onboard_user(&user, &s.onboarder);

    // Never blocked: unblock is a silent no-op, no user_unblocked event
    s.contract.unblock_user(&user, &s.unblock_operator);
    s.assert_no_events();
    assert!(!s.contract.is_on_block_list(&user));
    assert!(!s.contract.blocked(&user));
}

#[test]
fn test_batch_block_skips_already_blocked() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let users: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);

    s.contract.batch_onboard_users(&users, &s.onboarder);
    s.contract.block_user(&alice, &s.block_operator);

    // alice is already blocked: only bob transitions, one event
    s.contract.batch_block_users(&users, &s.block_operator);
    assert_eq!(s.gateway_event_count(), 1);
    assert!(s.contract.is_on_block_list(&alice));
    assert!(s.contract.is_on_block_list(&bob));
}

#[test]
fn test_batch_unblock_skips_not_blocked() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let users: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);

    s.contract.batch_onboard_users(&users, &s.onboarder);
    s.contract.block_user(&bob, &s.block_operator);

    // alice was never blocked: only bob transitions, one event
    s.contract.batch_unblock_users(&users, &s.unblock_operator);
    assert_eq!(s.gateway_event_count(), 1);
    assert!(!s.contract.is_on_block_list(&alice));
    assert!(!s.contract.is_on_block_list(&bob));
    assert!(!s.contract.blocked(&alice));
    assert!(!s.contract.blocked(&bob));
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
        .try_batch_block_users(&accounts, &s.block_operator);
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
        .try_batch_unblock_users(&accounts, &s.unblock_operator);
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

    let result = s.contract.try_batch_block_users(&accounts, &s.minter);
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

    let result = s.contract.try_batch_block_users(&accounts, &random);
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
        .try_batch_block_users(&accounts, &s.block_operator);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::BatchTooLargeError))
    );
}

#[test]
fn test_batch_unblock_at_max_size() {
    let s = setup();
    enforce_current_mainnet_limits(&s.env);
    s.env.cost_estimate().budget().reset_unlimited();

    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..MAX_BATCH_SIZE {
        accounts.push_back(Address::generate(&s.env));
    }

    // Onboard and block all 18, then verify batch_unblock succeeds at max size
    s.contract.batch_onboard_users(&accounts, &s.onboarder);
    s.contract.batch_block_users(&accounts, &s.block_operator);
    s.contract
        .batch_unblock_users(&accounts, &s.unblock_operator);

    for account in accounts.iter() {
        assert!(!s.contract.blocked(&account));
    }
}

#[test]
fn test_batch_block_at_max_size() {
    let s = setup();
    enforce_current_mainnet_limits(&s.env);
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

    s.contract.batch_onboard_users(&accounts, &s.onboarder);

    // Accounts start unauthorized (AUTH_REQUIRED), so freezing is a no-op
    // on auth state but should succeed without hitting resource limits
    s.contract.batch_block_users(&accounts, &s.block_operator);

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

    // Onboard and mint to both users
    let users: Vec<Address> =
        Vec::from_array(&s.env, [alice.clone(), bob.clone(), recipient.clone()]);
    s.contract.batch_onboard_users(&users, &s.onboarder);
    s.contract.mint(&s.minter, &alice, &(1_000 * DECIMALS));
    s.contract.mint(&s.minter, &bob, &(1_000 * DECIMALS));

    // Batch block alice and bob
    let to_block: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);
    s.contract.batch_block_users(&to_block, &s.block_operator);

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

    // Onboard, mint, then block
    let all: Vec<Address> =
        Vec::from_array(&s.env, [alice.clone(), bob.clone(), recipient.clone()]);
    s.contract.batch_onboard_users(&all, &s.onboarder);
    s.contract.mint(&s.minter, &alice, &(1_000 * DECIMALS));
    s.contract.mint(&s.minter, &bob, &(1_000 * DECIMALS));

    let users: Vec<Address> = Vec::from_array(&s.env, [alice.clone(), bob.clone()]);
    s.contract.batch_block_users(&users, &s.block_operator);

    // Batch unblock
    s.contract.batch_unblock_users(&users, &s.unblock_operator);

    // Both can now transfer
    s.sac_token.transfer(&alice, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 100 * DECIMALS);

    s.sac_token.transfer(&bob, &recipient, &(100 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 200 * DECIMALS);
}
