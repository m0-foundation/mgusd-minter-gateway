use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, IntoVal};

use super::setup::*;
use crate::events::PauserSet;

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

    s.contract.unfreeze_account(&s.distributor, &user);
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

    s.contract.unfreeze_account(&s.distributor, &user);
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

    s.contract.unfreeze_account(&s.distributor, &user);
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

    s.contract.unfreeze_account(&s.distributor, &alice);
    s.contract.unfreeze_account(&s.distributor, &bob);
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

    assert!(s.contract.try_claim_yield(&s.yield_recipient).is_err());

    s.contract.unpause(&s.pauser);
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

    s.contract.unfreeze_account(&s.distributor, &user);
    s.contract.pause(&s.pauser);

    s.contract.freeze_account(&s.distributor, &user);
    assert!(!s.contract.is_authorized(&user));

    s.contract.unfreeze_account(&s.distributor, &user);
    assert!(s.contract.is_authorized(&user));
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
// SET PAUSER
// =============================================================================

#[test]
fn test_set_pauser_updates_pauser() {
    let s = setup();
    let new_pauser = Address::generate(&s.env);

    s.contract.set_pauser(&new_pauser);
    s.assert_event(PauserSet {
        old: s.pauser.clone(),
        new: new_pauser.clone(),
    });
    assert_eq!(s.contract.pauser(), new_pauser);
}

#[test]
fn test_new_pauser_can_pause_after_set_pauser() {
    let s = setup();
    let new_pauser = Address::generate(&s.env);

    s.contract.set_pauser(&new_pauser);
    s.contract.pause(&new_pauser);
    assert!(s.contract.paused());
}

#[test]
fn test_old_pauser_cannot_pause_after_set_pauser() {
    let s = setup_no_mock_auth();
    let new_pauser = Address::generate(&s.env);

    // Use admin auth to set a new pauser
    s.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &s.admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &s.contract.address,
            fn_name: "set_pauser",
            args: (&new_pauser,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.contract.set_pauser(&new_pauser);

    // Old pauser can no longer pause
    let result = s.contract.try_pause(&s.pauser);
    assert!(result.is_err());
}
