use soroban_sdk::testutils::Address as _;

use super::setup::*;
use crate::events::{BlockOperatorAdded, UnblockOperatorAdded};

// =============================================================================
// ROLE GETTERS — verify initial state
// =============================================================================

#[test]
fn test_forced_transfer_manager_view() {
    let s = setup();
    assert_eq!(
        s.contract.forced_transfer_manager(),
        s.forced_transfer_manager
    );
}

#[test]
fn test_block_unblock_operator_views() {
    let s = setup();
    assert!(s.contract.is_block_operator(&s.block_operator));
    assert!(s.contract.is_unblock_operator(&s.unblock_operator));
    let someone = Address::generate(&s.env);
    assert!(!s.contract.is_block_operator(&someone));
    assert!(!s.contract.is_unblock_operator(&someone));
}

// =============================================================================
// ROLE SETTERS — happy-path mutations
// =============================================================================

#[test]
fn test_set_admin() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.contract.set_admin(&new_admin);
    assert_eq!(s.contract.admin(), new_admin);
}

#[test]
fn test_set_minter() {
    let s = setup();
    let new_minter = Address::generate(&s.env);

    s.contract.set_minter(&new_minter);
    assert_eq!(s.contract.minter(), new_minter);
}

#[test]
fn test_set_yield_recipient_manager() {
    let s = setup();
    let new_yrm = Address::generate(&s.env);

    s.contract.set_yield_recipient_manager(&new_yrm);
    assert_eq!(s.contract.yield_recipient_manager(), new_yrm);
}

#[test]
fn test_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    s.contract
        .set_yield_recipient(&s.yield_recipient_manager, &new_yr);
    assert_eq!(s.contract.yield_recipient(), new_yr);
}

#[test]
fn test_set_forced_transfer_manager() {
    let s = setup();
    let new_ftm = Address::generate(&s.env);

    assert_eq!(
        s.contract.forced_transfer_manager(),
        s.forced_transfer_manager
    );

    s.contract.set_forced_transfer_manager(&new_ftm);
    assert_eq!(s.contract.forced_transfer_manager(), new_ftm);
}

#[test]
fn test_add_and_remove_block_operator() {
    let s = setup();
    let extra = Address::generate(&s.env);

    assert!(s.contract.is_block_operator(&s.block_operator));
    assert!(!s.contract.is_block_operator(&extra));

    s.contract.add_block_operator(&extra);
    assert!(s.contract.is_block_operator(&s.block_operator));
    assert!(s.contract.is_block_operator(&extra));

    s.contract.remove_block_operator(&s.block_operator);
    assert!(!s.contract.is_block_operator(&s.block_operator));
    assert!(s.contract.is_block_operator(&extra));
}

#[test]
fn test_add_and_remove_unblock_operator() {
    let s = setup();
    let extra = Address::generate(&s.env);

    assert!(s.contract.is_unblock_operator(&s.unblock_operator));
    assert!(!s.contract.is_unblock_operator(&extra));

    s.contract.add_unblock_operator(&extra);
    assert!(s.contract.is_unblock_operator(&s.unblock_operator));
    assert!(s.contract.is_unblock_operator(&extra));

    s.contract.remove_unblock_operator(&s.unblock_operator);
    assert!(!s.contract.is_unblock_operator(&s.unblock_operator));
    assert!(s.contract.is_unblock_operator(&extra));
}

#[test]
fn test_add_block_operator_is_idempotent() {
    let s = setup();
    s.contract.add_block_operator(&s.block_operator);
    assert!(s.contract.is_block_operator(&s.block_operator));
}

#[test]
fn test_remove_block_operator_is_idempotent() {
    let s = setup();
    let never_added = Address::generate(&s.env);
    s.contract.remove_block_operator(&never_added);
    assert!(!s.contract.is_block_operator(&never_added));
}

#[test]
fn test_add_unblock_operator_is_idempotent() {
    let s = setup();
    s.contract.add_unblock_operator(&s.unblock_operator);
    assert!(s.contract.is_unblock_operator(&s.unblock_operator));
}

#[test]
fn test_remove_unblock_operator_is_idempotent() {
    let s = setup();
    let never_added = Address::generate(&s.env);
    s.contract.remove_unblock_operator(&never_added);
    assert!(!s.contract.is_unblock_operator(&never_added));
}

#[test]
fn test_added_operators_can_block_and_unblock() {
    // Confirms that operators added via `add_block_operator` / `add_unblock_operator`
    // — not the ones wired up in the constructor — can exercise their respective
    // capabilities. Guards against a `require_block_operator` / `require_unblock_operator`
    // regression that checks a single address rather than set membership.
    let s = setup();
    let new_block = Address::generate(&s.env);
    let new_unblock = Address::generate(&s.env);
    let user = Address::generate(&s.env);

    s.contract.add_block_operator(&new_block);
    s.contract.add_unblock_operator(&new_unblock);

    s.contract.unblock_user(&user, &new_unblock);
    assert!(!s.contract.blocked(&user));

    s.contract.block_user(&user, &new_block);
    assert!(s.contract.blocked(&user));
}

// Repeated `add_unblock_operator` calls for the same address must not
// accumulate duplicate entries: the storage layer is keyed-per-address, so
// re-adds are silent no-ops. This test pins that property by (1) asserting
// no event fires on the duplicate add and (2) verifying a single remove
// clears membership — which would fail if the address had been stored more
// than once.
#[test]
fn test_add_unblock_operator_does_not_accumulate_duplicates() {
    let s = setup();
    let extra = Address::generate(&s.env);

    s.contract.add_unblock_operator(&extra);
    s.assert_event(UnblockOperatorAdded {
        addr: extra.clone(),
    });
    assert!(s.contract.is_unblock_operator(&extra));

    s.contract.add_unblock_operator(&extra);
    s.assert_no_events();

    s.contract.add_unblock_operator(&extra);
    s.assert_no_events();

    s.contract.remove_unblock_operator(&extra);
    assert!(!s.contract.is_unblock_operator(&extra));
}

#[test]
fn test_add_block_operator_does_not_accumulate_duplicates() {
    let s = setup();
    let extra = Address::generate(&s.env);

    s.contract.add_block_operator(&extra);
    s.assert_event(BlockOperatorAdded {
        addr: extra.clone(),
    });
    assert!(s.contract.is_block_operator(&extra));

    s.contract.add_block_operator(&extra);
    s.assert_no_events();

    s.contract.add_block_operator(&extra);
    s.assert_no_events();

    s.contract.remove_block_operator(&extra);
    assert!(!s.contract.is_block_operator(&extra));
}

// =============================================================================
// ADMIN IS NOT A SUPER-ROLE — admin cannot bypass role gates
// =============================================================================

#[test]
fn test_admin_cannot_mint() {
    let s = setup();
    let user = Address::generate(&s.env);

    let result = s.contract.try_mint(&s.admin, &user, &(1_000 * DECIMALS));
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_burn() {
    let s = setup();
    let user = Address::generate(&s.env);

    s.contract.unblock_user(&user, &s.unblock_operator);
    s.contract.mint(&s.minter, &user, &(1_000 * DECIMALS));

    let result = s.contract.try_burn(&s.admin, &user, &(400 * DECIMALS));
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_set_rate() {
    let s = setup();

    let result = s.contract.try_set_rate(&s.admin, &500);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_claim_yield() {
    let s = setup();

    let result = s.contract.try_claim_yield(&s.admin);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_admin_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s.contract.try_set_yield_recipient(&s.admin, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

// =============================================================================
// AUTH ENFORCEMENT — require_auth reverts without signature
// =============================================================================

#[test]
fn test_set_admin_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_admin = Address::generate(&s.env);
    let err = s.contract.try_set_admin(&new_admin).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_minter_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_minter = Address::generate(&s.env);
    let err = s.contract.try_set_minter(&new_minter).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_yield_recipient_manager_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_yrm = Address::generate(&s.env);
    let err = s
        .contract
        .try_set_yield_recipient_manager(&new_yrm)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_forced_transfer_manager_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_ftm = Address::generate(&s.env);
    let err = s
        .contract
        .try_set_forced_transfer_manager(&new_ftm)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_add_block_operator_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_addr = Address::generate(&s.env);
    let err = s
        .contract
        .try_add_block_operator(&new_addr)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_remove_block_operator_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let err = s
        .contract
        .try_remove_block_operator(&s.block_operator)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_add_unblock_operator_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_addr = Address::generate(&s.env);
    let err = s
        .contract
        .try_add_unblock_operator(&new_addr)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_remove_unblock_operator_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let err = s
        .contract
        .try_remove_unblock_operator(&s.unblock_operator)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_add_pauser_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_addr = Address::generate(&s.env);
    let err = s.contract.try_add_pauser(&new_addr).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_remove_pauser_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let err = s
        .contract
        .try_remove_pauser(&s.pauser)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, auth_error());
}

#[test]
fn test_set_yield_recipient_reverts_without_caller_auth() {
    let s = setup_no_mock_auth();
    let new_yr = Address::generate(&s.env);
    let result = s
        .contract
        .try_set_yield_recipient(&s.yield_recipient_manager, &new_yr);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_upgrade_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let fake_hash = BytesN::from_array(&s.env, &[0u8; 32]);
    let err = s.contract.try_upgrade(&fake_hash).unwrap_err().unwrap();
    assert_eq!(err, auth_error());
}

// =============================================================================
// ACCESS CONTROL — set_yield_recipient wrong-role rejections
// =============================================================================

#[test]
fn test_minter_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s.contract.try_set_yield_recipient(&s.minter, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_yield_recipient_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&s.yield_recipient, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_forced_transfer_manager_cannot_set_yield_recipient() {
    let s = setup();
    let new_yr = Address::generate(&s.env);

    let result = s
        .contract
        .try_set_yield_recipient(&s.forced_transfer_manager, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}

#[test]
fn test_random_cannot_set_yield_recipient() {
    let s = setup();
    let random = Address::generate(&s.env);
    let new_yr = Address::generate(&s.env);

    let result = s.contract.try_set_yield_recipient(&random, &new_yr);
    assert_eq!(
        result,
        Err(Ok(crate::MinterGatewayError::UnauthorizedError))
    );
}
