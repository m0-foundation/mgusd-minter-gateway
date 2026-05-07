use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use super::setup::*;
use crate::events::PauserAdded;

// =============================================================================
// STATE — pause / unpause / paused
// =============================================================================

#[test]
fn test_contract_is_not_paused_by_default() {
    let s = setup();
    assert!(!s.contract.paused());
}

#[test]
fn test_pause_sets_paused_state() {
    let s = setup();
    s.contract.pause(&s.pauser);
    assert!(s.contract.paused());
}

#[test]
fn test_unpause_clears_paused_state() {
    let s = setup();
    s.contract.pause(&s.pauser);
    s.contract.unpause(&s.pauser);
    assert!(!s.contract.paused());
}

#[test]
fn test_admin_cannot_pause() {
    let s = setup_no_mock_auth();
    let result = s.contract.try_pause(&s.admin);
    assert!(result.is_err());
}

#[test]
fn test_admin_cannot_unpause() {
    let s = setup();
    s.contract.pause(&s.pauser);
    s.env.mock_auths(&[]);
    let result = s.contract.try_unpause(&s.admin);
    assert!(result.is_err());
}

// =============================================================================
// BLOCKED THEN RESUMED — each operation reverts when paused, succeeds after unpause
// =============================================================================

#[test]
fn test_mint_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.pause(&s.pauser);

    assert!(s
        .contract
        .try_mint(&s.minter, &user, &(1_000 * DECIMALS))
        .is_err());

    s.contract.unpause(&s.pauser);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), 1_000 * DECIMALS);
}

#[test]
fn test_burn_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));
    s.contract.pause(&s.pauser);

    assert!(s
        .contract
        .try_burn(&s.minter, &user, &(500 * DECIMALS))
        .is_err());

    s.contract.unpause(&s.pauser);
    s.contract.burn(&s.minter, &user, &(500 * DECIMALS));
    assert_eq!(s.sac_token.balance(&user), 500 * DECIMALS);
}

#[test]
fn test_reconcile_burn_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));
    s.contract.pause(&s.pauser);

    assert!(s.contract.try_reconcile_burn(&(500 * DECIMALS)).is_err());

    s.contract.unpause(&s.pauser);
    s.contract.reconcile_burn(&(500 * DECIMALS));
    assert_eq!(s.contract.total_principal(), 500 * DECIMALS);
}

#[test]
fn test_force_transfer_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    s.contract.unblock_user(&alice, &s.unblock_operator);
    s.contract.unblock_user(&bob, &s.unblock_operator);
    s.contract.mint(&s.minter, &alice, &(1_000 * DECIMALS));
    s.contract.pause(&s.pauser);

    assert!(s
        .contract
        .try_force_transfer(&s.forced_transfer_manager, &alice, &bob, &(500 * DECIMALS))
        .is_err());

    s.contract.unpause(&s.pauser);
    s.contract
        .force_transfer(&s.forced_transfer_manager, &alice, &bob, &(500 * DECIMALS));
    assert_eq!(s.sac_token.balance(&bob), 500 * DECIMALS);
}

#[test]
fn test_claim_yield_blocked_when_paused_resumes_after_unpause() {
    let s = setup();

    s.contract
        .mint(&s.minter, &s.yield_recipient, &(1_000 * DECIMALS));
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    s.contract.pause(&s.pauser);

    assert!(s
        .contract
        .try_claim_yield(&s.yield_recipient_manager)
        .is_err());

    s.contract.unpause(&s.pauser);
    let claimed = s.contract.claim_yield(&s.yield_recipient_manager);
    assert!(claimed > 0);
}

// =============================================================================
// UNBLOCKED OPERATIONS — compliance and view calls remain accessible
// =============================================================================

#[test]
fn test_block_unblock_work_when_paused() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.pause(&s.pauser);

    s.contract.block_user(&user, &s.block_operator);
    assert!(s.contract.blocked(&user));

    s.contract.unblock_user(&user, &s.unblock_operator);
    assert!(!s.contract.blocked(&user));
}

#[test]
fn test_view_functions_work_when_paused() {
    let s = setup();

    s.contract
        .mint(&s.minter, &s.yield_recipient, &(1_000 * DECIMALS));
    s.contract.pause(&s.pauser);

    assert_eq!(s.contract.total_supply(), 1_000 * DECIMALS);
    assert_eq!(s.contract.total_principal(), 1_000 * DECIMALS);
    assert!(s.contract.current_index() > 0);
    assert!(s.contract.paused());
}

// =============================================================================
// AUTH ENFORCEMENT
// =============================================================================

#[test]
fn test_pause_reverts_without_pauser_auth() {
    let s = setup_no_mock_auth();
    let result = s.contract.try_pause(&s.pauser);
    assert!(result.is_err());
}

#[test]
fn test_unpause_reverts_without_pauser_auth() {
    let s = setup();
    s.contract.pause(&s.pauser);
    s.env.mock_auths(&[]);

    let result = s.contract.try_unpause(&s.pauser);
    assert!(result.is_err());
}

#[test]
fn test_random_address_cannot_pause() {
    let s = setup_no_mock_auth();
    let random = Address::generate(&s.env);
    let result = s.contract.try_pause(&random);
    assert!(result.is_err());
}

// =============================================================================
// PAUSER MEMBERSHIP — add / remove / multiple pausers
// =============================================================================

#[test]
fn test_pauser_view() {
    let s = setup();
    assert!(s.contract.is_pauser(&s.pauser));
    let someone = Address::generate(&s.env);
    assert!(!s.contract.is_pauser(&someone));
}

#[test]
fn test_add_and_remove_pauser() {
    let s = setup();
    let extra = Address::generate(&s.env);

    assert!(s.contract.is_pauser(&s.pauser));
    assert!(!s.contract.is_pauser(&extra));

    s.contract.add_pauser(&extra);
    assert!(s.contract.is_pauser(&s.pauser));
    assert!(s.contract.is_pauser(&extra));

    s.contract.remove_pauser(&s.pauser);
    assert!(!s.contract.is_pauser(&s.pauser));
    assert!(s.contract.is_pauser(&extra));
}

#[test]
fn test_add_pauser_is_idempotent() {
    let s = setup();
    s.contract.add_pauser(&s.pauser);
    assert!(s.contract.is_pauser(&s.pauser));
}

#[test]
fn test_remove_pauser_is_idempotent() {
    let s = setup();
    let never_added = Address::generate(&s.env);
    s.contract.remove_pauser(&never_added);
    assert!(!s.contract.is_pauser(&never_added));
}

// Repeated `add_pauser` calls for the same address must not accumulate
// duplicate entries: storage is keyed-per-address, so re-adds are silent
// no-ops. Pinned by (1) asserting no event fires on the duplicate add and
// (2) verifying a single remove clears membership — which would fail if the
// address had been stored more than once.
#[test]
fn test_add_pauser_does_not_accumulate_duplicates() {
    let s = setup();
    let extra = Address::generate(&s.env);

    s.contract.add_pauser(&extra);
    s.assert_event(PauserAdded {
        addr: extra.clone(),
    });
    assert!(s.contract.is_pauser(&extra));

    s.contract.add_pauser(&extra);
    s.assert_no_events();

    s.contract.add_pauser(&extra);
    s.assert_no_events();

    s.contract.remove_pauser(&extra);
    assert!(!s.contract.is_pauser(&extra));
}

// Confirms pausers added via `add_pauser` — not the one wired up in the
// constructor — can pause and unpause. Guards against a `require_pauser`
// regression that checks a single address rather than set membership.
#[test]
fn test_added_pauser_can_pause_and_unpause() {
    let s = setup();
    let new_pauser = Address::generate(&s.env);

    s.contract.add_pauser(&new_pauser);

    s.contract.pause(&new_pauser);
    assert!(s.contract.paused());

    s.contract.unpause(&new_pauser);
    assert!(!s.contract.paused());
}

// Both pausers in the set should be able to act independently — pinning
// that membership grants the role, not exclusive ownership.
#[test]
fn test_multiple_pausers_can_each_pause_and_unpause() {
    let s = setup();
    let second = Address::generate(&s.env);
    s.contract.add_pauser(&second);

    // Original pauser pauses, second pauser unpauses.
    s.contract.pause(&s.pauser);
    assert!(s.contract.paused());
    s.contract.unpause(&second);
    assert!(!s.contract.paused());

    // Reverse: second pauses, original unpauses.
    s.contract.pause(&second);
    assert!(s.contract.paused());
    s.contract.unpause(&s.pauser);
    assert!(!s.contract.paused());
}

#[test]
fn test_removed_pauser_cannot_pause() {
    let s = setup();
    s.contract.remove_pauser(&s.pauser);

    let result = s.contract.try_pause(&s.pauser);
    assert!(result.is_err());
}
