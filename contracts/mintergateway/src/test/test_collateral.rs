use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// RECONCILE BURN — adjusts accumulators and releases collateral
// =============================================================================

#[test]
fn test_reconcile_burn_adjusts_accumulators() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let treasury = Address::generate(&s.env);

    // Mint MGUSD
    s.contract.unfreeze_account(&s.admin, &s.yield_recipient);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);

    // Deposit collateral (RD) to contract so reconcile_burn can release it
    let contract_addr = s.contract.address.clone();
    s.collateral_sac.mint(&contract_addr, &amount);

    // Simulate: user sent tokens to issuer (destroyed at protocol level).
    // Admin calls reconcile_burn to sync accumulators.
    let reconcile_amount = 400_0000000i128;
    s.contract.reconcile_burn(&reconcile_amount, &treasury);

    assert_eq!(s.contract.total_principal(), amount - reconcile_amount);
    assert_eq!(s.contract.total_supply(), amount - reconcile_amount);
}

#[test]
fn test_reconcile_burn_releases_collateral_to_treasury() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let treasury = Address::generate(&s.env);

    // Mint MGUSD and deposit collateral to contract
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    let contract_addr = s.contract.address.clone();
    s.collateral_sac.mint(&contract_addr, &amount);

    assert_eq!(s.collateral_token.balance(&contract_addr), amount);
    assert_eq!(s.collateral_token.balance(&treasury), 0);

    // Reconcile burn — collateral goes to treasury, not the original holder
    let reconcile_amount = 400_0000000i128;
    s.contract.reconcile_burn(&reconcile_amount, &treasury);

    assert_eq!(
        s.collateral_token.balance(&contract_addr),
        amount - reconcile_amount
    );
    assert_eq!(s.collateral_token.balance(&treasury), reconcile_amount);
}

#[test]
fn test_reconcile_burn_admin_only() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let treasury = Address::generate(&s.env);

    // Set up state while mock_all_auths is active
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    let contract_addr = s.contract.address.clone();
    s.collateral_sac.mint(&contract_addr, &amount);

    // Switch to no-mock-auth mode — reconcile_burn should fail without admin auth
    s.env.mock_auths(&[]);
    let result = s.contract.try_reconcile_burn(&amount, &treasury);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

#[test]
fn test_reconcile_burn_with_yield_accrued() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let treasury = Address::generate(&s.env);

    // Mint and set up collateral
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    let contract_addr = s.contract.address.clone();
    s.collateral_sac.mint(&contract_addr, &amount);

    // Set rate and advance time to accrue yield
    s.contract.set_rate(&s.minter, &500); // 5%
    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let yield_before = s.contract.accrued_yield();
    assert!(yield_before > 0);

    // Reconcile half — update_index called first, yield preserved
    let reconcile_amount = 500_0000000i128;
    let idx_at_reconcile = s.contract.current_index();
    s.contract.reconcile_burn(&reconcile_amount, &treasury);

    // Yield should still be there (reconcile_burn calls update_index first)
    assert!(s.contract.accrued_yield() > 0);

    // Principal reduced by PV of reconcile amount
    let pv_reconcile = reconcile_amount * INDEX_SCALE / idx_at_reconcile;
    assert_eq!(s.contract.total_principal(), amount - pv_reconcile);

    // After reconcile, yield accrues on reduced principal
    advance_time(&s.env, SECONDS_PER_YEAR as u64);
    let second_year_yield = s.contract.accrued_yield() - yield_before;
    // With half principal gone, second year yield should be roughly half
    let ratio = (second_year_yield as f64) / (yield_before as f64);
    assert!(
        ratio > 0.40 && ratio < 0.65,
        "Expected ~0.5 ratio, got {}",
        ratio
    );
}

#[test]
fn test_reconcile_burn_exceeds_principal_reverts() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let treasury = Address::generate(&s.env);

    s.contract.mint(&s.minter, &s.yield_recipient, &amount);
    let contract_addr = s.contract.address.clone();
    s.collateral_sac.mint(&contract_addr, &(amount * 2));

    // Try to reconcile more than what's in accumulators
    let excessive = amount * 2;
    let result = s.contract.try_reconcile_burn(&excessive, &treasury);
    assert_eq!(
        result,
        Err(Ok(crate::YieldTokenError::BurnExceedsPrincipal))
    );
}
