use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use super::setup::*;

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
    s.contract.pause(&s.admin);
    assert!(s.contract.paused());
}

#[test]
fn test_unpause_clears_paused_state() {
    let s = setup();
    s.contract.pause(&s.admin);
    s.contract.unpause(&s.admin);
    assert!(!s.contract.paused());
}

// =============================================================================
// BLOCKED THEN RESUMED — each operation reverts when paused, succeeds after unpause
// =============================================================================

#[test]
fn test_mint_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.pause(&s.admin);

    assert!(s.contract.try_mint(&s.minter, &user, &1_000_0000000).is_err());

    s.contract.unpause(&s.admin);
    s.contract.mint(&s.minter, &user, &1_000_0000000);
    assert_eq!(s.sac_token.balance(&user), 1_000_0000000);
}

#[test]
fn test_burn_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);
    s.contract.pause(&s.admin);

    assert!(s.contract.try_burn(&s.minter, &user, &500_0000000).is_err());

    s.contract.unpause(&s.admin);
    s.contract.burn(&s.minter, &user, &500_0000000);
    assert_eq!(s.sac_token.balance(&user), 500_0000000);
}

#[test]
fn test_reconcile_burn_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &user, &1_000_0000000);
    s.contract.pause(&s.admin);

    assert!(s.contract.try_reconcile_burn(&500_0000000, &s.minter).is_err());

    s.contract.unpause(&s.admin);
    s.contract.reconcile_burn(&500_0000000, &s.minter);
    assert_eq!(s.contract.total_principal(), 500_0000000);
}

#[test]
fn test_force_transfer_blocked_when_paused_resumes_after_unpause() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &alice);
    s.contract.unfreeze_account(&s.admin, &bob);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &alice, &1_000_0000000);
    s.contract.pause(&s.admin);

    assert!(s
        .contract
        .try_force_transfer(&s.forced_transfer_manager, &alice, &bob, &500_0000000)
        .is_err());

    s.contract.unpause(&s.admin);
    s.contract.force_transfer(&s.forced_transfer_manager, &alice, &bob, &500_0000000);
    assert_eq!(s.sac_token.balance(&bob), 500_0000000);
}

#[test]
fn test_claim_yield_blocked_when_paused_resumes_after_unpause() {
    let s = setup();

    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    s.contract.set_rate(&s.minter, &500);
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    deposit_reserves(&s, &s.minter, s.contract.accrued_yield());
    s.contract.pause(&s.admin);

    assert!(s.contract.try_claim_yield(&s.yield_recipient).is_err());

    s.contract.unpause(&s.admin);
    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert!(claimed > 0);
}

// =============================================================================
// UNBLOCKED OPERATIONS — compliance and view calls remain accessible
// =============================================================================

#[test]
fn test_freeze_unfreeze_work_when_paused() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    s.contract.pause(&s.admin);

    s.contract.freeze_account(&s.admin, &user);
    assert!(!s.contract.is_authorized(&user));

    s.contract.unfreeze_account(&s.admin, &user);
    assert!(s.contract.is_authorized(&user));
}

#[test]
fn test_view_functions_work_when_paused() {
    let s = setup();

    s.contract.unfreeze_account(&s.admin, &s.yield_recipient);
    give_collateral(&s, &s.minter, 1_000_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    s.contract.pause(&s.admin);

    assert_eq!(s.contract.total_supply(), 1_000_0000000);
    assert_eq!(s.contract.total_principal(), 1_000_0000000);
    assert!(s.contract.current_index() > 0);
    assert!(s.contract.paused());
}

// =============================================================================
// AUTH ENFORCEMENT
// =============================================================================

#[test]
fn test_pause_reverts_without_admin_auth() {
    let s = setup_no_mock_auth();
    let result = s.contract.try_pause(&s.admin);
    assert!(result.is_err());
}

#[test]
fn test_unpause_reverts_without_admin_auth() {
    let s = setup();
    s.contract.pause(&s.admin);
    s.env.mock_auths(&[]);

    let result = s.contract.try_unpause(&s.admin);
    assert!(result.is_err());
}
