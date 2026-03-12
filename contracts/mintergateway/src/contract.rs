use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Vec};

use crate::admin::{has_admin, read_admin, require_admin, write_admin};
use crate::errors::YieldTokenError;
use crate::events::{
    emit_account_frozen, emit_account_unfrozen, emit_distributor_set,
    emit_force_transfer, emit_forced_transfer_manager_set, emit_interest_rate_set,
    emit_minter_set, emit_set_admin, emit_supply_synced, emit_upgraded, emit_yield_claimed,
    emit_yield_recipient_manager_set, emit_yield_recipient_set,
};
use crate::roles::{
    read_distributor, read_forced_transfer_manager, read_minter, read_yield_recipient,
    read_yield_recipient_manager, require_admin_or, write_distributor,
    write_forced_transfer_manager, write_minter, write_yield_recipient,
    write_yield_recipient_manager,
};
use crate::constants::MAX_BATCH_SIZE;
use crate::sac_token::{read_sac_token, write_sac_token};
use crate::storage_types::{INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD};
use crate::yield_state::{
    claim_accrued_yield, decrease_both_accumulators, get_accrued_yield, get_current_index,
    get_interest_rate, get_latest_index, get_total_principal, get_total_supply,
    increase_both_accumulators, increase_total_supply, read_yield_state, set_interest_rate,
    update_index,
};

pub(crate) fn check_nonnegative_amount(amount: i128) -> Result<(), YieldTokenError> {
    if amount < 0 {
        return Err(YieldTokenError::NegativeAmountError);
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
    pub fn __constructor(
        e: Env,
        sac_token: Address,
        admin: Address,
        minter: Address,
        yield_recipient_manager: Address,
        yield_recipient: Address,
        forced_transfer_manager: Address,
        distributor: Address,
    ) -> Result<(), YieldTokenError> {
        if has_admin(&e) {
            return Err(YieldTokenError::AlreadyInitializedError);
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

        emit_set_admin(&e, admin, new_admin);
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

    // =========================================================================
    // Admin Compliance Functions
    // =========================================================================

    /// Freezes an account, preventing it from sending or receiving SAC tokens.
    /// Admin only.
    pub fn freeze_account(e: Env, account: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).set_authorized(&account, &false);

        emit_account_frozen(&e, account);
    }

    /// Unfreezes an account, restoring its ability to send and receive SAC tokens.
    /// Admin only.
    pub fn unfreeze_account(e: Env, account: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).set_authorized(&account, &true);

        emit_account_unfrozen(&e, account);
    }

    // =========================================================================
    // Batch Compliance Functions (Admin or Distributor)
    // =========================================================================

    /// Freezes multiple accounts in a single transaction.
    /// Admin or distributor only. Max 20 accounts per call.
    pub fn batch_freeze_accounts(
        e: Env,
        caller: Address,
        accounts: Vec<Address>,
    ) -> Result<(), YieldTokenError> {
        require_admin_or(&e, &caller, &read_distributor(&e))?;
        extend_instance_ttl(&e);

        if accounts.len() > MAX_BATCH_SIZE {
            return Err(YieldTokenError::BatchTooLargeError);
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
    /// Admin or distributor only. Max 20 accounts per call.
    pub fn batch_unfreeze_accounts(
        e: Env,
        caller: Address,
        accounts: Vec<Address>,
    ) -> Result<(), YieldTokenError> {
        require_admin_or(&e, &caller, &read_distributor(&e))?;
        extend_instance_ttl(&e);

        if accounts.len() > MAX_BATCH_SIZE {
            return Err(YieldTokenError::BatchTooLargeError);
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

        e.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        emit_upgraded(&e, admin, new_wasm_hash);
    }

    // =========================================================================
    // Minter Functions — Direct Mint/Burn/Rate
    // =========================================================================

    /// Mints SAC tokens directly to the recipient and updates accumulators.
    /// Minter or admin only.
    pub fn mint(e: Env, caller: Address, to: Address, amount: i128) -> Result<(), YieldTokenError> {
        check_nonnegative_amount(amount)?;
        require_admin_or(&e, &caller, &read_minter(&e))?;
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Increase both accumulators
        increase_both_accumulators(&e, amount);

        // Mint SAC tokens to recipient
        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).mint(&to, &amount);

        let state = read_yield_state(&e);
        emit_supply_synced(&e, amount, state.total_principal, state.total_supply);
        Ok(())
    }

    /// Burns SAC tokens from an account and updates accumulators.
    /// Minter or admin only.
    pub fn burn(e: Env, caller: Address, from: Address, amount: i128) -> Result<(), YieldTokenError> {
        check_nonnegative_amount(amount)?;
        require_admin_or(&e, &caller, &read_minter(&e))?;
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Decrease both accumulators
        decrease_both_accumulators(&e, amount)?;

        // Remove SAC tokens from account via SAC clawback
        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).clawback(&from, &amount);

        let state = read_yield_state(&e);
        emit_supply_synced(&e, -amount, state.total_principal, state.total_supply);
        Ok(())
    }

    /// Sets the interest rate in basis points (max 10000 = 100%). Minter or admin only.
    /// No-op if the new rate equals the current rate.
    pub fn set_rate(e: Env, caller: Address, rate_bps: u32) -> Result<(), YieldTokenError> {
        require_admin_or(&e, &caller, &read_minter(&e))?;
        extend_instance_ttl(&e);

        // Early return if rate unchanged
        if get_interest_rate(&e) == rate_bps {
            return Ok(());
        }

        set_interest_rate(&e, rate_bps)?;

        emit_interest_rate_set(&e, rate_bps);
        Ok(())
    }

    // =========================================================================
    // Forced Transfer Manager Functions
    // =========================================================================

    /// Forces a transfer of SAC tokens from one account to another.
    /// Forced transfer manager or admin only. Does not require source authorization.
    /// Implemented as clawback + mint. Accumulators are NOT touched — supply is unchanged.
    pub fn force_transfer(
        e: Env,
        caller: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), YieldTokenError> {
        check_nonnegative_amount(amount)?;
        require_admin_or(&e, &caller, &read_forced_transfer_manager(&e))?;
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

    /// Sets a new yield recipient address. Yield recipient manager or admin only.
    pub fn set_yield_recipient(
        e: Env,
        caller: Address,
        new_yield_recipient: Address,
    ) -> Result<(), YieldTokenError> {
        require_admin_or(&e, &caller, &read_yield_recipient_manager(&e))?;
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
    pub fn claim_yield(e: Env, caller: Address) -> Result<i128, YieldTokenError> {
        let recipient = read_yield_recipient(&e);
        require_admin_or(&e, &caller, &recipient)?;
        extend_instance_ttl(&e);

        let claimed = claim_accrued_yield(&e);

        if claimed > 0 {
            // Increase total_supply (but NOT total_principal — no compounding)
            increase_total_supply(&e, claimed);

            // Mint new tokens to yield recipient
            let sac_addr = read_sac_token(&e);
            token::StellarAssetClient::new(&e, &sac_addr).mint(&recipient, &claimed);

            emit_yield_claimed(&e, recipient, claimed);
        }

        Ok(claimed)
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
    pub fn current_index(e: Env) -> u128 {
        extend_instance_ttl(&e);
        get_current_index(&e)
    }

    /// Returns the latest stored index (from last update).
    pub fn latest_index(e: Env) -> u128 {
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
}
