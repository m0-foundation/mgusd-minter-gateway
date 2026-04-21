use soroban_sdk::{contract, contractimpl, panic_with_error, token, Address, BytesN, Env, Vec};

use crate::admin::{has_admin, read_admin, require_admin, write_admin};
use crate::constants::MAX_BATCH_SIZE;
use crate::errors::MinterGatewayError;
use crate::events::{
    emit_account_frozen, emit_account_unfrozen, emit_admin_set, emit_distributor_set,
    emit_force_transfer, emit_forced_transfer_manager_set, emit_interest_rate_set, emit_minter_set,
    emit_pauser_set, emit_supply_synced, emit_upgraded, emit_yield_claimed,
    emit_yield_recipient_manager_set, emit_yield_recipient_set,
};
use crate::roles::{
    read_distributor, read_forced_transfer_manager, read_minter, read_pauser, read_yield_recipient,
    read_yield_recipient_manager, require_role_holder, write_distributor,
    write_forced_transfer_manager, write_minter, write_pauser, write_yield_recipient,
    write_yield_recipient_manager,
};
use crate::sac_token::{read_sac_token, write_sac_token};
use crate::storage_types::{INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD};
use crate::yield_state::{
    decrease_both_accumulators, get_accrued_yield, get_current_index, get_interest_rate,
    get_latest_index, get_total_principal, get_total_supply, increase_both_accumulators,
    increase_total_supply, read_yield_state, set_interest_rate, update_index,
};
use stellar_contract_utils::pausable::{self as pausable, Pausable};

pub(crate) fn check_positive_amount(amount: i128) -> Result<(), MinterGatewayError> {
    if amount <= 0 {
        return Err(MinterGatewayError::InvalidAmountError);
    }
    Ok(())
}

fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

#[contract]
pub struct YieldToken;

#[contractimpl]
impl YieldToken {
    /// Initializes the SAC admin yield token contract.
    ///
    /// # Arguments
    /// * `sac_token` - Address of the SAC token contract this contract administers
    /// * `admin` - Top-level authority address
    /// * `minter` - Address that can mint/burn tokens and set rate
    /// * `yield_recipient_manager` - Address that can set the yield recipient
    /// * `yield_recipient` - Address that can claim yield
    /// * `forced_transfer_manager` - Address that can authorize accounts and transfer tokens
    /// * `distributor` - Address that can batch freeze/unfreeze accounts
    /// * `pauser` - Address that can pause/unpause the contract
    pub fn __constructor(
        e: Env,
        sac_token: Address,
        admin: Address,
        minter: Address,
        yield_recipient_manager: Address,
        yield_recipient: Address,
        forced_transfer_manager: Address,
        distributor: Address,
        pauser: Address,
    ) -> Result<(), MinterGatewayError> {
        if has_admin(&e) {
            return Err(MinterGatewayError::AlreadyInitializedError);
        }

        // Store SAC token address
        write_sac_token(&e, &sac_token);

        // Set all roles
        write_admin(&e, &admin);
        write_minter(&e, &minter);
        write_yield_recipient_manager(&e, &yield_recipient_manager);
        write_yield_recipient(&e, &yield_recipient);
        write_forced_transfer_manager(&e, &forced_transfer_manager);
        write_distributor(&e, &distributor);
        write_pauser(&e, &pauser);

        Ok(())
    }

    // =========================================================================
    // Admin Functions
    // =========================================================================

    /// Transfers admin role to a new address. Current admin only.
    pub fn set_admin(e: Env, new_admin: Address) {
        let admin = require_admin(&e);
        extend_instance_ttl(&e);

        write_admin(&e, &new_admin);

        emit_admin_set(&e, admin, new_admin);
    }

    /// Sets a new minter address. Admin only.
    pub fn set_minter(e: Env, new_minter: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let old = read_minter(&e);
        write_minter(&e, &new_minter);

        emit_minter_set(&e, old, new_minter);
    }

    /// Sets a new yield recipient manager address. Admin only.
    pub fn set_yield_recipient_manager(e: Env, new_yield_recipient_manager: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let old = read_yield_recipient_manager(&e);
        write_yield_recipient_manager(&e, &new_yield_recipient_manager);

        emit_yield_recipient_manager_set(&e, old, new_yield_recipient_manager);
    }

    /// Sets a new forced transfer manager address. Admin only.
    pub fn set_forced_transfer_manager(e: Env, new_forced_transfer_manager: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let old = read_forced_transfer_manager(&e);
        write_forced_transfer_manager(&e, &new_forced_transfer_manager);

        emit_forced_transfer_manager_set(&e, old, new_forced_transfer_manager);
    }

    /// Sets a new distributor address. Admin only.
    pub fn set_distributor(e: Env, new_distributor: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let old = read_distributor(&e);
        write_distributor(&e, &new_distributor);

        emit_distributor_set(&e, old, new_distributor);
    }

    /// Sets a new pauser address. Admin only.
    pub fn set_pauser(e: Env, new_pauser: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let old = read_pauser(&e);
        write_pauser(&e, &new_pauser);

        emit_pauser_set(&e, old, new_pauser);
    }

    // =========================================================================
    // Compliance Functions (Distributor)
    // =========================================================================

    /// Freezes an account, preventing it from sending or receiving SAC tokens.
    /// Distributor only.
    pub fn freeze_account(
        e: Env,
        caller: Address,
        account: Address,
    ) -> Result<(), MinterGatewayError> {
        require_role_holder(&caller, &read_distributor(&e))?;
        extend_instance_ttl(&e);

        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).set_authorized(&account, &false);

        emit_account_frozen(&e, account);

        Ok(())
    }

    /// Unfreezes an account, restoring its ability to send and receive SAC tokens.
    /// Distributor only.
    pub fn unfreeze_account(
        e: Env,
        caller: Address,
        account: Address,
    ) -> Result<(), MinterGatewayError> {
        require_role_holder(&caller, &read_distributor(&e))?;
        extend_instance_ttl(&e);

        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).set_authorized(&account, &true);

        emit_account_unfrozen(&e, account);

        Ok(())
    }

    // =========================================================================
    // Batch Compliance Functions (Distributor)
    // =========================================================================

    /// Freezes multiple accounts in a single transaction.
    /// Distributor only. Max 40 accounts per call.
    pub fn batch_freeze_accounts(
        e: Env,
        caller: Address,
        accounts: Vec<Address>,
    ) -> Result<(), MinterGatewayError> {
        require_role_holder(&caller, &read_distributor(&e))?;
        extend_instance_ttl(&e);

        if accounts.len() > MAX_BATCH_SIZE {
            return Err(MinterGatewayError::BatchTooLargeError);
        }

        let sac_addr = read_sac_token(&e);
        let sac_client = token::StellarAssetClient::new(&e, &sac_addr);

        for account in accounts.iter() {
            sac_client.set_authorized(&account, &false);
            emit_account_frozen(&e, account);
        }

        Ok(())
    }

    /// Unfreezes multiple accounts in a single transaction.
    /// Distributor only. Max 40 accounts per call.
    pub fn batch_unfreeze_accounts(
        e: Env,
        caller: Address,
        accounts: Vec<Address>,
    ) -> Result<(), MinterGatewayError> {
        require_role_holder(&caller, &read_distributor(&e))?;
        extend_instance_ttl(&e);

        if accounts.len() > MAX_BATCH_SIZE {
            return Err(MinterGatewayError::BatchTooLargeError);
        }

        let sac_addr = read_sac_token(&e);
        let sac_client = token::StellarAssetClient::new(&e, &sac_addr);

        for account in accounts.iter() {
            sac_client.set_authorized(&account, &true);
            emit_account_unfrozen(&e, account);
        }

        Ok(())
    }

    // =========================================================================
    // Admin Upgrade Functions
    // =========================================================================

    /// Upgrades the contract WASM to a new version. Admin only.
    /// The new WASM must already be uploaded to the ledger.
    /// Storage is preserved — a separate `migrate()` call may be needed
    /// if the new version changes the storage schema.
    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) {
        let admin = require_admin(&e);
        extend_instance_ttl(&e);

        e.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        emit_upgraded(&e, admin, new_wasm_hash);
    }

    // =========================================================================
    // Minter Functions — Direct Mint/Burn/Rate
    // =========================================================================

    /// Mints SAC tokens directly to the recipient and updates accumulators.
    /// Minter only.
    pub fn mint(
        e: Env,
        caller: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), MinterGatewayError> {
        pausable::when_not_paused(&e);
        check_positive_amount(amount)?;
        require_role_holder(&caller, &read_minter(&e))?;
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Increase both accumulators
        increase_both_accumulators(&e, amount);

        // Mint SAC tokens to recipient
        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).mint(&to, &amount);

        let state = read_yield_state(&e);
        emit_supply_synced(
            &e,
            amount,
            state.total_principal,
            state.total_supply,
            state.latest_index,
        );

        Ok(())
    }

    /// Burns SAC tokens from an account and updates accumulators.
    /// Minter only.
    pub fn burn(
        e: Env,
        caller: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), MinterGatewayError> {
        pausable::when_not_paused(&e);
        check_positive_amount(amount)?;
        require_role_holder(&caller, &read_minter(&e))?;
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Decrease both accumulators
        decrease_both_accumulators(&e, amount)?;

        // Remove SAC tokens from account via SAC clawback
        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).clawback(&from, &amount);

        let state = read_yield_state(&e);
        emit_supply_synced(
            &e,
            -amount,
            state.total_principal,
            state.total_supply,
            state.latest_index,
        );

        Ok(())
    }

    /// Reconciles accumulators after tokens are destroyed by sending to the SAC issuer.
    /// Decreases both accumulators to reflect the reduced supply.
    /// Admin only — this is a reconciliation action, not normal operations.
    pub fn reconcile_burn(e: Env, amount: i128) -> Result<(), MinterGatewayError> {
        pausable::when_not_paused(&e);
        require_admin(&e);
        check_positive_amount(amount)?;
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Guard: can't reconcile more tokens than the contract believes exist
        if amount > get_total_supply(&e) {
            return Err(MinterGatewayError::BurnExceedsSupply);
        }

        // Decrease both accumulators (same PV logic as burn)
        decrease_both_accumulators(&e, amount)?;

        let state = read_yield_state(&e);
        emit_supply_synced(
            &e,
            -amount,
            state.total_principal,
            state.total_supply,
            state.latest_index,
        );

        Ok(())
    }

    /// Sets the interest rate in basis points (max 10000 = 100%). Minter only.
    /// No-op if the new rate equals the current rate.
    pub fn set_rate(e: Env, caller: Address, rate_bps: u32) -> Result<(), MinterGatewayError> {
        require_role_holder(&caller, &read_minter(&e))?;
        extend_instance_ttl(&e);

        // Early return if rate unchanged
        if get_interest_rate(&e) == rate_bps {
            return Ok(());
        }

        // First update index at the old rate
        update_index(&e);

        set_interest_rate(&e, rate_bps)?;

        emit_interest_rate_set(&e, rate_bps);

        Ok(())
    }

    // =========================================================================
    // Forced Transfer Manager Functions
    // =========================================================================

    /// Forces a transfer of SAC tokens from one account to another.
    /// Forced transfer manager only. Does not require source authorization.
    /// Implemented as clawback + mint. Accumulators are NOT touched — supply is unchanged.
    pub fn force_transfer(
        e: Env,
        caller: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), MinterGatewayError> {
        pausable::when_not_paused(&e);
        check_positive_amount(amount)?;
        require_role_holder(&caller, &read_forced_transfer_manager(&e))?;

        extend_instance_ttl(&e);

        // SAC operations: clawback from source, mint to destination
        let sac_addr = read_sac_token(&e);
        let sac_client = token::StellarAssetClient::new(&e, &sac_addr);
        sac_client.clawback(&from, &amount);
        sac_client.mint(&to, &amount);

        emit_force_transfer(&e, from, to, amount);

        Ok(())
    }

    // =========================================================================
    // Yield Recipient Manager Functions
    // =========================================================================

    /// Sets a new yield recipient address. Yield recipient manager.
    pub fn set_yield_recipient(
        e: Env,
        caller: Address,
        new_yield_recipient: Address,
    ) -> Result<(), MinterGatewayError> {
        require_role_holder(&caller, &read_yield_recipient_manager(&e))?;

        extend_instance_ttl(&e);

        let old = read_yield_recipient(&e);
        write_yield_recipient(&e, &new_yield_recipient);

        emit_yield_recipient_set(&e, old, new_yield_recipient);

        Ok(())
    }

    // =========================================================================
    // Yield Recipient Functions
    // =========================================================================

    /// Claims accrued yield by minting new SAC tokens to the yield recipient.
    /// Yield recipient or admin only. Returns the amount of yield claimed.
    ///
    /// Note: Claimed yield is NOT added to principal — it does not earn more yield.
    /// Tokens are always minted to the yield recipient, regardless of who calls.
    pub fn claim_yield(e: Env, caller: Address) -> Result<i128, MinterGatewayError> {
        pausable::when_not_paused(&e);

        let recipient = read_yield_recipient(&e);
        require_role_holder(&caller, &recipient)?; // TODO - review who can claim

        extend_instance_ttl(&e);

        update_index(&e);

        let unclaimed_yield = get_accrued_yield(&e);

        if unclaimed_yield > 0 {
            // Increase total_supply (but NOT total_principal — no compounding)
            increase_total_supply(&e, unclaimed_yield);
            // Mint new tokens to yield recipient
            let sac_addr = read_sac_token(&e);
            token::StellarAssetClient::new(&e, &sac_addr).mint(&recipient, &unclaimed_yield);

            emit_yield_claimed(&e, recipient, unclaimed_yield, get_latest_index(&e));
        }

        Ok(unclaimed_yield)
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /// Returns whether the given account is authorized (not frozen) on the SAC.
    pub fn is_authorized(e: Env, account: Address) -> bool {
        extend_instance_ttl(&e);
        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).authorized(&account)
    }

    /// Returns the SAC token address this contract administers.
    pub fn sac_token(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_sac_token(&e)
    }

    /// Returns the current interest rate in basis points.
    pub fn interest_rate(e: Env) -> u32 {
        extend_instance_ttl(&e);
        get_interest_rate(&e)
    }

    /// Returns the current index (real-time, includes pending growth).
    pub fn current_index(e: Env) -> i128 {
        extend_instance_ttl(&e);
        get_current_index(&e)
    }

    /// Returns the latest stored index (from last update).
    pub fn latest_index(e: Env) -> i128 {
        extend_instance_ttl(&e);
        get_latest_index(&e)
    }

    /// Returns the current accrued yield available to claim.
    pub fn accrued_yield(e: Env) -> i128 {
        extend_instance_ttl(&e);
        get_accrued_yield(&e)
    }

    /// Returns the total_principal (yield-earning base).
    /// This is the sum of mints minus burns, excluding claimed yield.
    pub fn total_principal(e: Env) -> i128 {
        extend_instance_ttl(&e);
        get_total_principal(&e)
    }

    /// Returns the total_supply (principal + cumulative claimed yield).
    pub fn total_supply(e: Env) -> i128 {
        extend_instance_ttl(&e);
        get_total_supply(&e)
    }

    /// Returns the admin address.
    pub fn admin(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_admin(&e)
    }

    /// Returns the minter address.
    pub fn minter(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_minter(&e)
    }

    /// Returns the yield recipient manager address.
    pub fn yield_recipient_manager(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_yield_recipient_manager(&e)
    }

    /// Returns the yield recipient address.
    pub fn yield_recipient(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_yield_recipient(&e)
    }

    /// Returns the forced transfer manager address.
    pub fn forced_transfer_manager(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_forced_transfer_manager(&e)
    }

    /// Returns the distributor address.
    pub fn distributor(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_distributor(&e)
    }

    /// Returns the pauser address.
    pub fn pauser(e: Env) -> Address {
        extend_instance_ttl(&e);
        read_pauser(&e)
    }
}

// =============================================================================
// Pausable (Pauser or Admin)
// =============================================================================

#[contractimpl]
impl Pausable for YieldToken {
    /// Returns `true` if the contract is currently paused.
    fn paused(e: &Env) -> bool {
        extend_instance_ttl(e);
        pausable::paused(e)
    }

    /// Pauses the contract. Blocks mint, burn, reconcile_burn, force_transfer, claim_yield.
    /// Pauser only.
    fn pause(e: &Env, caller: Address) {
        caller.require_auth();
        if caller != read_pauser(e) {
            panic_with_error!(e, MinterGatewayError::UnauthorizedError);
        }
        extend_instance_ttl(e);
        pausable::pause(e);
    }

    /// Unpauses the contract, resuming all blocked operations.
    /// Pauser only.
    fn unpause(e: &Env, caller: Address) {
        caller.require_auth();
        if caller != read_pauser(e) {
            panic_with_error!(e, MinterGatewayError::UnauthorizedError);
        }
        extend_instance_ttl(e);
        pausable::unpause(e);
    }
}
