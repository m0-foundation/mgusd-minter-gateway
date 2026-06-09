use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use super::setup::*;

// =============================================================================
// BASIC REGISTRY STATE
// =============================================================================

#[test]
fn test_get_blocks_empty_for_new_user() {
    let s = setup();
    let user = Address::generate(&s.env);
    let blocks = s.contract.get_blocks(&user);
    assert!(blocks.is_empty());
}

#[test]
fn test_blocked_by_returns_false_by_default() {
    let s = setup();
    let user = Address::generate(&s.env);
    assert!(!s.contract.blocked_by(&user, &s.source));
}

#[test]
fn test_block_adds_source_to_registry() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.block_user(&s.blocker, &user, &s.source);

    assert!(s.contract.blocked_by(&user, &s.source));
    let blocks = s.contract.get_blocks(&user);
    assert_eq!(blocks.len(), 1);
}

#[test]
fn test_unblock_removes_source_from_registry() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.block_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked_by(&user, &s.source));

    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked_by(&user, &s.source));
    assert!(s.contract.get_blocks(&user).is_empty());
}

#[test]
fn test_two_sources_both_must_clear() {
    let s = setup();
    let source_a = s.source.clone();
    let source_b = Symbol::new(&s.env, "source_b");
    let blocker_a = s.blocker.clone();
    let blocker_b = Address::generate(&s.env);
    let user = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&source_b, &blocker_b);

    // Activate user first
    s.contract.unblock_user(&blocker_a, &user, &source_a);

    // Source B blocks the user
    s.contract.block_user(&blocker_b, &user, &source_b);
    assert!(s.contract.blocked(&user));

    // Source A also blocks
    s.contract.block_user(&blocker_a, &user, &source_a);
    assert!(s.contract.blocked(&user));
    assert_eq!(s.contract.get_blocks(&user).len(), 2);

    // Source A unblocks - source B's block still holds
    s.contract.unblock_user(&blocker_a, &user, &source_a);
    assert!(s.contract.blocked(&user));
    assert!(s.contract.blocked_by(&user, &source_b));
    assert!(!s.contract.blocked_by(&user, &source_a));

    // Source B unblocks - now all clear, SAC auth restored
    s.contract.unblock_user(&blocker_b, &user, &source_b);
    assert!(!s.contract.blocked(&user));
    assert!(s.contract.get_blocks(&user).is_empty());
}

#[test]
fn test_party_a_cannot_override_party_b_block() {
    let s = setup();
    let source_b = Symbol::new(&s.env, "source_b");
    let blocker_b = Address::generate(&s.env);
    let user = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&source_b, &blocker_b);

    // Party B blocks the user
    s.contract.block_user(&blocker_b, &user, &source_b);
    assert!(s.contract.blocked(&user));

    // Party A calls unblock for their own source - no effect on B's block
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(s.contract.blocked(&user)); // B's block still active
    assert!(s.contract.blocked_by(&user, &source_b));
}

#[test]
fn test_unblock_own_source_no_op_when_not_blocked() {
    let s = setup();
    let user = Address::generate(&s.env);

    // User was never blocked by s.source - unblock is a no-op
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));
    assert!(s.contract.get_blocks(&user).is_empty());
}

#[test]
fn test_sac_auth_revoked_on_first_block() {
    let s = setup();
    let source_b = Symbol::new(&s.env, "source_b");
    let blocker_b = Address::generate(&s.env);
    let user = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&source_b, &blocker_b);

    // Activate user
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.mint(&s.minter, &user, &(100 * DECIMALS));

    // First block - SAC auth revoked
    s.contract.block_user(&blocker_b, &user, &source_b);

    // SAC transfer fails while blocked
    let recipient = Address::generate(&s.env);
    s.contract.unblock_user(&s.blocker, &recipient, &s.source);
    let result = s.sac_token.try_transfer(&user, &recipient, &(10 * DECIMALS));
    assert!(result.is_err());
}

#[test]
fn test_sac_auth_restored_only_when_all_sources_clear() {
    let s = setup();
    let source_b = Symbol::new(&s.env, "source_b");
    let blocker_b = Address::generate(&s.env);
    let user = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&source_b, &blocker_b);
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    s.contract.unblock_user(&s.blocker, &recipient, &s.source);
    s.contract.mint(&s.minter, &user, &(100 * DECIMALS));

    // Both sources block
    s.contract.block_user(&s.blocker, &user, &s.source);
    s.contract.block_user(&blocker_b, &user, &source_b);

    // Source A clears - source B still holds, SAC auth NOT restored
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    let result = s.sac_token.try_transfer(&user, &recipient, &(10 * DECIMALS));
    assert!(result.is_err());

    // Source B clears - all clear, SAC auth restored
    s.contract.unblock_user(&blocker_b, &user, &source_b);
    s.sac_token.transfer(&user, &recipient, &(10 * DECIMALS));
    assert_eq!(s.sac_token.balance(&recipient), 10 * DECIMALS);
}

#[test]
fn test_recipient_activation_flow() {
    let s = setup();
    let compliance = Symbol::new(&s.env, "compliance");
    let compliance_key = Address::generate(&s.env);
    let onboarding = Symbol::new(&s.env, "onboarding");
    let onboarding_key = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&compliance, &compliance_key);
    s.contract.set_authorized_blocker(&onboarding, &onboarding_key);

    // Step 1: Recipient has no blocks, onboarding party activates them
    s.contract.unblock_user(&onboarding_key, &recipient, &onboarding);
    assert!(!s.contract.blocked(&recipient));

    // Step 2: Compliance detects a sanctions match and blocks
    s.contract.block_user(&compliance_key, &recipient, &compliance);
    assert!(s.contract.blocked(&recipient));
    assert!(s.contract.blocked_by(&recipient, &compliance));

    // Step 3: Onboarding party tries to unblock their source - no-op, compliance block persists
    s.contract.unblock_user(&onboarding_key, &recipient, &onboarding);
    assert!(s.contract.blocked(&recipient));
    assert!(s.contract.blocked_by(&recipient, &compliance));

    // Step 4: Compliance clears - all clear
    s.contract.unblock_user(&compliance_key, &recipient, &compliance);
    assert!(!s.contract.blocked(&recipient));
}

#[test]
fn test_new_source_added_at_runtime_composes_with_existing() {
    let s = setup();
    let user = Address::generate(&s.env);
    let predicate = Symbol::new(&s.env, "predicate");
    let oracle = Address::generate(&s.env);

    // User is activated and not blocked
    s.contract.unblock_user(&s.blocker, &user, &s.source);

    // New blocking party registered at runtime
    s.contract.set_authorized_blocker(&predicate, &oracle);

    // Oracle blocks
    s.contract.block_user(&oracle, &user, &predicate);
    assert!(s.contract.blocked(&user));
    assert_eq!(s.contract.get_blocks(&user).len(), 1);

    // Default source also blocks
    s.contract.block_user(&s.blocker, &user, &s.source);
    assert_eq!(s.contract.get_blocks(&user).len(), 2);

    // Oracle clears - default source still holds
    s.contract.unblock_user(&oracle, &user, &predicate);
    assert!(s.contract.blocked(&user));

    // Default source clears - fully clear
    s.contract.unblock_user(&s.blocker, &user, &s.source);
    assert!(!s.contract.blocked(&user));
}

#[test]
fn test_remove_authorized_blocker_prevents_further_blocks() {
    let s = setup();
    let user = Address::generate(&s.env);

    // Remove the default source
    s.contract.remove_authorized_blocker(&s.source);

    // Blocker can no longer block - source is unknown
    let result = s.contract.try_block_user(&s.blocker, &user, &s.source);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnknownSourceError))
    );
}

#[test]
fn test_batch_block_multiple_sources_per_user() {
    let s = setup();
    let source_b = Symbol::new(&s.env, "source_b");
    let blocker_b = Address::generate(&s.env);
    let user = Address::generate(&s.env);

    s.contract.set_authorized_blocker(&source_b, &blocker_b);

    let users: Vec<Address> = Vec::from_array(&s.env, [user.clone()]);

    // Both sources block via batch
    s.contract.batch_block_users(&s.blocker, &users, &s.source);
    s.contract.batch_block_users(&blocker_b, &users, &source_b);
    assert_eq!(s.contract.get_blocks(&user).len(), 2);

    // Batch unblock source A - source B still holds
    s.contract.batch_unblock_users(&s.blocker, &users, &s.source);
    assert!(s.contract.blocked(&user));

    // Batch unblock source B - all clear
    s.contract.batch_unblock_users(&blocker_b, &users, &source_b);
    assert!(!s.contract.blocked(&user));
}
