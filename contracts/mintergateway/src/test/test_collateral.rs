use soroban_sdk::testutils::Address as _;

use super::setup::*;

// =============================================================================
// MINT — collateral locking
// =============================================================================

#[test]
fn test_mint_locks_collateral() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &recipient);
    give_collateral(&s, &s.minter, amount);

    s.contract.mint(&s.minter, &recipient, &amount);

    // Collateral transferred from caller (minter) to contract
    assert_eq!(s.collateral_token.balance(&s.contract.address), amount);
    assert_eq!(s.collateral_token.balance(&s.minter), 0);
    // MGUSD minted to recipient
    assert_eq!(s.sac_token.balance(&recipient), amount);
}

#[test]
fn test_burn_returns_collateral() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &user, &amount);

    s.contract.burn(&s.minter, &user, &amount);

    // Collateral returned to user
    assert_eq!(s.collateral_token.balance(&user), amount);
    assert_eq!(s.collateral_token.balance(&s.contract.address), 0);
    // MGUSD burned
    assert_eq!(s.sac_token.balance(&user), 0);
}

#[test]
fn test_mint_burn_round_trip() {
    let s = setup();
    let amount = 500_0000000i128;
    let user = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &user);
    give_collateral(&s, &s.minter, amount);

    s.contract.mint(&s.minter, &user, &amount);
    assert_eq!(s.collateral_token.balance(&s.contract.address), amount);

    s.contract.burn(&s.minter, &user, &amount);
    assert_eq!(s.collateral_token.balance(&s.contract.address), 0);
    assert_eq!(s.contract.total_supply(), 0);
}

#[test]
fn test_multiple_mints_accumulate_collateral() {
    let s = setup();

    give_collateral(&s, &s.minter, 500_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &500_0000000);

    give_collateral(&s, &s.minter, 300_0000000);
    s.contract.mint(&s.minter, &s.yield_recipient, &300_0000000);

    assert_eq!(s.collateral_token.balance(&s.contract.address), 800_0000000);
}

// =============================================================================
// CLAIM YIELD — distributes RD
// =============================================================================

#[test]
fn test_claim_yield_distributes_rd() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let accrued = s.contract.accrued_yield();
    assert!(accrued > 0);

    // Pre-deposit reserves
    deposit_reserves(&s, &s.admin, accrued);

    let claimed = s.contract.claim_yield(&s.yield_recipient);
    assert_eq!(claimed, accrued);

    // Yield recipient received RD tokens
    assert_eq!(s.collateral_token.balance(&s.yield_recipient), claimed);
    // total_supply unchanged
    assert_eq!(s.contract.total_supply(), principal);
}

#[test]
fn test_claim_yield_no_mgusd_minted() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let supply_before = s.contract.total_supply();
    let mgusd_before = s.sac_token.balance(&s.yield_recipient);

    deposit_reserves(&s, &s.admin, 1_000_000_0000000);
    s.contract.claim_yield(&s.yield_recipient);

    // No new MGUSD minted
    assert_eq!(s.contract.total_supply(), supply_before);
    assert_eq!(s.sac_token.balance(&s.yield_recipient), mgusd_before);
}

#[test]
fn test_claim_yield_fails_without_reserves() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // No reserves deposited — claim should fail
    let result = s.contract.try_claim_yield(&s.yield_recipient);
    assert_eq!(
        result,
        Err(Ok(crate::YieldTokenError::InsufficientCollateralReserves))
    );
}

#[test]
fn test_claim_yield_preserves_backing() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    let accrued = s.contract.accrued_yield();
    deposit_reserves(&s, &s.admin, accrued);

    s.contract.claim_yield(&s.yield_recipient);

    // After claim, contract still holds enough to back total_supply
    let contract_balance = s.collateral_token.balance(&s.contract.address);
    assert!(contract_balance >= s.contract.total_supply());
}

// =============================================================================
// SET COLLATERAL TOKEN
// =============================================================================

#[test]
fn test_set_collateral_token_admin_only() {
    let s = setup();
    let new_token = Address::generate(&s.env);

    // Admin can set it (already set in setup, but test explicit call)
    s.contract.set_collateral_token(&new_token);
    assert_eq!(s.contract.collateral_token(), new_token);
}

#[test]
fn test_set_collateral_token_reverts_without_auth() {
    let s = setup_no_mock_auth();
    let new_addr = Address::generate(&s.env);
    let err = s.contract.try_set_collateral_token(&new_addr).unwrap_err().unwrap();
    assert_eq!(soroban_sdk::Error::from(err), auth_error());
}

#[test]
fn test_set_collateral_token_changeable() {
    let s = setup();
    let original = s.contract.collateral_token();

    let new_sac = s.env.register_stellar_asset_contract_v2(s.admin.clone());
    let new_addr = new_sac.address();

    s.contract.set_collateral_token(&new_addr);
    assert_eq!(s.contract.collateral_token(), new_addr);
    assert_ne!(s.contract.collateral_token(), original);
}

// =============================================================================
// ERROR PATHS
// =============================================================================

#[test]
fn test_mint_fails_insufficient_collateral() {
    let s = setup();
    let recipient = Address::generate(&s.env);

    s.contract.unfreeze_account(&s.admin, &recipient);

    // Give minter only 500 but try to mint 1000
    give_collateral(&s, &s.minter, 500_0000000);
    let result = s.contract.try_mint(&s.minter, &recipient, &1_000_0000000);
    assert!(result.is_err());
}

// =============================================================================
// VIEW FUNCTIONS
// =============================================================================

#[test]
fn test_collateral_deficit_view() {
    let s = setup();
    let principal = 1_000_000_0000000i128;

    // No principal, no deficit
    assert_eq!(s.contract.collateral_deficit(), 0);

    give_collateral(&s, &s.minter, principal);
    s.contract.mint(&s.minter, &s.yield_recipient, &principal);
    s.contract.set_rate(&s.minter, &500);

    // No deficit immediately after mint (collateral == total_supply, no yield yet)
    assert_eq!(s.contract.collateral_deficit(), 0);

    advance_time(&s.env, SECONDS_PER_YEAR as u64);

    // Deficit = accrued_yield (need reserves for it)
    let accrued = s.contract.accrued_yield();
    assert!(accrued > 0);
    assert_eq!(s.contract.collateral_deficit(), accrued);

    // Deposit half the reserves
    deposit_reserves(&s, &s.admin, accrued / 2);
    assert_eq!(s.contract.collateral_deficit(), accrued - accrued / 2);

    // Deposit the rest
    deposit_reserves(&s, &s.admin, accrued - accrued / 2);
    assert_eq!(s.contract.collateral_deficit(), 0);
}

#[test]
fn test_collateral_balance_view() {
    let s = setup();

    assert_eq!(s.contract.collateral_balance(), 0);

    let amount = 1_000_0000000i128;
    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.collateral_balance(), amount);
}

// =============================================================================
// AUTH — collateral provider must authorize transfer
// =============================================================================

#[test]
fn test_collateral_provider_must_authorize() {
    let s = setup_no_mock_auth();

    // Without mock auth, mint will fail because neither the minter's
    // nor the provider's auth is available
    let result = s.contract.try_mint(&s.minter, &s.yield_recipient, &1_000_0000000);
    assert_eq!(
        result.unwrap_err().unwrap_err(),
        soroban_sdk::InvokeError::Abort
    );
}

// =============================================================================
// RECONCILE BURN — admin sync after send-to-issuer
// =============================================================================

#[test]
fn test_reconcile_burn_adjusts_accumulators() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let treasury = Address::generate(&s.env);

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.contract.total_principal(), amount);
    assert_eq!(s.contract.total_supply(), amount);

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

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    assert_eq!(s.collateral_token.balance(&s.contract.address), amount);
    assert_eq!(s.collateral_token.balance(&treasury), 0);

    // Reconcile burn — collateral goes to treasury, not the original holder
    let reconcile_amount = 400_0000000i128;
    s.contract.reconcile_burn(&reconcile_amount, &treasury);

    assert_eq!(
        s.collateral_token.balance(&s.contract.address),
        amount - reconcile_amount
    );
    assert_eq!(s.collateral_token.balance(&treasury), reconcile_amount);
}

#[test]
fn test_reconcile_burn_admin_only() {
    let s = setup();
    let amount = 1_000_0000000i128;
    let treasury = Address::generate(&s.env);

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

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

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

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

    give_collateral(&s, &s.minter, amount);
    s.contract.mint(&s.minter, &s.yield_recipient, &amount);

    // Try to reconcile more than what's in accumulators.
    // BurnExceedsSupply fires first (amount > total_supply) before the PV check.
    let excessive = amount * 2;
    let result = s.contract.try_reconcile_burn(&excessive, &treasury);
    assert_eq!(
        result,
        Err(Ok(crate::YieldTokenError::BurnExceedsSupply))
    );
}
