use soroban_sdk::{contract, contractimpl, panic_with_error, token, Address, BytesN, Env, Vec};

use crate::admin::{has_admin, read_admin, require_admin, write_admin};
use crate::constants::MAX_BATCH_SIZE;
use crate::errors::MinterGatewayError;
use crate::events::{
    emit_admin_set, emit_block_operator_added, emit_block_operator_removed, emit_burn,
    emit_force_transfer, emit_forced_transfer_manager_set, emit_interest_rate_set, emit_mint,
    emit_minter_set, emit_pauser_added, emit_pauser_removed, emit_reconcile,
    emit_sac_admin_transferred, emit_unblock_operator_added, emit_unblock_operator_removed,
    emit_upgraded, emit_yield_claimed, emit_yield_recipient_manager_set, emit_yield_recipient_set,
};
use crate::roles::{
    delete_block_operator, delete_pauser, delete_unblock_operator, insert_block_operator,
    insert_pauser, insert_unblock_operator, is_block_operator, is_pauser, is_unblock_operator,
    read_forced_transfer_manager, read_minter, read_yield_recipient, read_yield_recipient_manager,
    require_block_operator, require_pauser, require_role_holder, require_unblock_operator,
    write_forced_transfer_manager, write_minter, write_yield_recipient,
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
use stellar_tokens::fungible::blocklist::{emit_user_blocked, emit_user_unblocked};

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

/// Preflights a SAC `mint` destination — converts the no-trustline host trap into a typed `NoTrustline` error. Mirrors `blocked()`: any non-`Ok(true)` is unauthorized.
fn require_destination_trustline_authorized(
    sac_client: &token::StellarAssetClient,
    addr: &Address,
) -> Result<(), MinterGatewayError> {
    match sac_client.try_authorized(addr) {
        Ok(Ok(true)) => Ok(()),
        _ => Err(MinterGatewayError::NoTrustline),
    }
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
    /// * `yield_recipient` - Address that receives claimed yield (passive — `claim_yield` is gated by `yield_recipient_manager`)
    /// * `forced_transfer_manager` - Address that can authorize accounts and transfer tokens
    /// * `block_operator` - Initial address with block permission; added to the block-operator set.
    ///   More addresses can be granted via `add_block_operator`.
    /// * `unblock_operator` - Initial address with unblock permission; added to the unblock-operator set.
    ///   More addresses can be granted via `add_unblock_operator`. May equal `block_operator`.
    /// * `pauser` - Initial address with pause permission; added to the pauser set.
    ///   More addresses can be granted via `add_pauser`.
    pub fn __constructor(
        e: Env,
        sac_token: Address,
        admin: Address,
        minter: Address,
        yield_recipient_manager: Address,
        yield_recipient: Address,
        forced_transfer_manager: Address,
        block_operator: Address,
        unblock_operator: Address,
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
        insert_block_operator(&e, &block_operator);
        insert_unblock_operator(&e, &unblock_operator);
        insert_pauser(&e, &pauser);

        extend_instance_ttl(&e);

        Ok(())
    }

    // =========================================================================
    // Admin Functions
    // =========================================================================

    /// Transfers admin role to a new address. Current admin only.
    pub fn set_admin(e: Env, new_admin: Address) {
        let admin = require_admin(&e);

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        write_admin(&e, &new_admin);

        emit_admin_set(&e, admin, new_admin);
    }

    /// Sets a new minter address. Admin only.
    pub fn set_minter(e: Env, new_minter: Address) {
        require_admin(&e);

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        let old = read_minter(&e);
        write_minter(&e, &new_minter);

        emit_minter_set(&e, old, new_minter);
    }

    /// Sets a new yield recipient manager address. Admin only.
    pub fn set_yield_recipient_manager(e: Env, new_yield_recipient_manager: Address) {
        require_admin(&e);

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        let old = read_yield_recipient_manager(&e);
        write_yield_recipient_manager(&e, &new_yield_recipient_manager);

        emit_yield_recipient_manager_set(&e, old, new_yield_recipient_manager);
    }

    /// Sets a new forced transfer manager address. Admin only.
    pub fn set_forced_transfer_manager(e: Env, new_forced_transfer_manager: Address) {
        require_admin(&e);

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        let old = read_forced_transfer_manager(&e);
        write_forced_transfer_manager(&e, &new_forced_transfer_manager);

        emit_forced_transfer_manager_set(&e, old, new_forced_transfer_manager);
    }

    /// Grants block permission to `addr`. Admin only.
    /// Idempotent: silent no-op (no event) if the address is already a block operator.
    pub fn add_block_operator(e: Env, addr: Address) {
        require_admin(&e);

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        if insert_block_operator(&e, &addr) {
            emit_block_operator_added(&e, addr);
        }
    }

    /// Revokes block permission from `addr`. Admin only.
    /// Idempotent: silent no-op (no event) if the address does not have block permission.
    pub fn remove_block_operator(e: Env, addr: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        if delete_block_operator(&e, &addr) {
            emit_block_operator_removed(&e, addr);
        }
    }

    /// Grants unblock permission to `addr`. Admin only.
    /// Idempotent: silent no-op (no event) if the address is already an unblock operator.
    pub fn add_unblock_operator(e: Env, addr: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        if insert_unblock_operator(&e, &addr) {
            emit_unblock_operator_added(&e, addr);
        }
    }

    /// Revokes unblock permission from `addr`. Admin only.
    /// Idempotent: silent no-op (no event) if the address does not have unblock permission.
    pub fn remove_unblock_operator(e: Env, addr: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        if delete_unblock_operator(&e, &addr) {
            emit_unblock_operator_removed(&e, addr);
        }
    }

    /// Grants pause permission to `addr`. Admin only.
    /// Idempotent: silent no-op (no event) if the address is already a pauser.
    pub fn add_pauser(e: Env, addr: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        if insert_pauser(&e, &addr) {
            emit_pauser_added(&e, addr);
        }
    }

    /// Revokes pause permission from `addr`. Admin only.
    /// Idempotent: silent no-op (no event) if the address does not have pause permission.
    pub fn remove_pauser(e: Env, addr: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        if delete_pauser(&e, &addr) {
            emit_pauser_removed(&e, addr);
        }
    }

    // =========================================================================
    // BlockList Functions (Block / Unblock operators)
    //
    // Mirrors the `stellar_tokens::fungible::blocklist::FungibleBlockList`
    // interface: `block_user` / `unblock_user` / `blocked`. Backed by the SAC
    // allowlist (`set_authorized`) — the SAC is the authoritative source of
    // authorization state, so we do not mirror into contract storage.
    //
    // `blocked` is the inverse of SAC authorization:
    //   `blocked(a) == true`  ⇔  SAC `authorized(a) == false`
    //
    // Note on polarity under AUTH_REQUIRED: untouched accounts are SAC-
    // unauthorized by default, so `blocked` returns `true` for them.
    // =========================================================================

    /// Blocks a user, preventing them from sending or receiving SAC tokens.
    /// Block operator only.
    pub fn block_user(e: Env, user: Address, operator: Address) -> Result<(), MinterGatewayError> {
        require_block_operator(&e, &operator)?;
        extend_instance_ttl(&e);

        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).set_authorized(&user, &false);

        emit_user_blocked(&e, &user);
        Ok(())
    }

    /// Unblocks a user, restoring their ability to send and receive SAC tokens.
    /// Unblock operator only.
    pub fn unblock_user(
        e: Env,
        user: Address,
        operator: Address,
    ) -> Result<(), MinterGatewayError> {
        require_unblock_operator(&e, &operator)?;
        extend_instance_ttl(&e);

        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).set_authorized(&user, &true);

        emit_user_unblocked(&e, &user);
        Ok(())
    }

    /// Blocks multiple users in a single transaction.
    /// Block operator only. Max 40 users per call.
    pub fn batch_block_users(
        e: Env,
        users: Vec<Address>,
        operator: Address,
    ) -> Result<(), MinterGatewayError> {
        require_block_operator(&e, &operator)?;
        extend_instance_ttl(&e);

        if users.len() > MAX_BATCH_SIZE {
            return Err(MinterGatewayError::BatchTooLargeError);
        }

        let sac_addr = read_sac_token(&e);
        let sac_client = token::StellarAssetClient::new(&e, &sac_addr);

        for user in users.iter() {
            sac_client.set_authorized(&user, &false);
            emit_user_blocked(&e, &user);
        }

        Ok(())
    }

    /// Unblocks multiple users in a single transaction.
    /// Unblock operator only. Max 40 users per call.
    pub fn batch_unblock_users(
        e: Env,
        users: Vec<Address>,
        operator: Address,
    ) -> Result<(), MinterGatewayError> {
        require_unblock_operator(&e, &operator)?;
        extend_instance_ttl(&e);

        if users.len() > MAX_BATCH_SIZE {
            return Err(MinterGatewayError::BatchTooLargeError);
        }

        let sac_addr = read_sac_token(&e);
        let sac_client = token::StellarAssetClient::new(&e, &sac_addr);

        for user in users.iter() {
            sac_client.set_authorized(&user, &true);
            emit_user_unblocked(&e, &user);
        }

        Ok(())
    }

    // =========================================================================
    // Admin Upgrade Functions
    // =========================================================================

    /// Transfers SAC admin role to another address. Admin only.
    /// After this call the contract loses the ability to mint, burn,
    /// clawback and authorize accounts on the SAC.
    pub fn transfer_sac_admin(e: Env, new_sac_admin: Address) {
        require_admin(&e);
        extend_instance_ttl(&e);

        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).set_admin(&new_sac_admin);

        emit_sac_admin_transferred(&e, new_sac_admin);
    }

    /// Upgrades the contract WASM to a new version. Admin only.
    /// The new WASM must already be uploaded to the ledger.
    /// Storage is preserved — a separate `migrate()` call may be needed
    /// if the new version changes the storage schema.
    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) {
        let admin = require_admin(&e);

        // Prolongs the Time-To-Live of the contract's instance storage.
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

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Preflight destination so callers see a typed error, not a host trap.
        let sac_addr = read_sac_token(&e);
        let sac_client = token::StellarAssetClient::new(&e, &sac_addr);
        require_destination_trustline_authorized(&sac_client, &to)?;

        // Increase both accumulators
        increase_both_accumulators(&e, amount);

        sac_client.mint(&to, &amount);

        let state = read_yield_state(&e);
        emit_mint(&e, to, amount, state.total_principal, state.total_supply);

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

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Decrease both accumulators
        decrease_both_accumulators(&e, amount)?;

        // Remove SAC tokens from account via SAC clawback
        let sac_addr = read_sac_token(&e);
        token::StellarAssetClient::new(&e, &sac_addr).clawback(&from, &amount);

        let state = read_yield_state(&e);
        emit_burn(&e, from, amount, state.total_principal, state.total_supply);

        Ok(())
    }

    /// Reconciles accumulators after tokens are destroyed by sending to the SAC issuer.
    /// Decreases both accumulators to reflect the reduced supply.
    /// Admin only — this is a reconciliation action, not normal operations.
    pub fn reconcile_burn(e: Env, amount: i128) -> Result<(), MinterGatewayError> {
        require_admin(&e);
        check_positive_amount(amount)?;

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        // Update index before changing principal
        update_index(&e);

        // Decrease both accumulators (same PV logic as burn)
        decrease_both_accumulators(&e, amount)?;

        let state = read_yield_state(&e);
        emit_reconcile(&e, amount, state.total_principal, state.total_supply);

        Ok(())
    }

    /// Sets the interest rate in basis points (max 10000 = 100%). Minter only.
    /// No-op if the new rate equals the current rate.
    pub fn set_interest_rate(
        e: Env,
        caller: Address,
        rate_bps: u32,
    ) -> Result<(), MinterGatewayError> {
        pausable::when_not_paused(&e);
        require_role_holder(&caller, &read_minter(&e))?;

        // Prolongs the Time-To-Live of the contract's instance storage.
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

    /// Forces a transfer of SAC tokens between accounts (clawback + mint).
    /// Forced transfer manager only. Does not require source authorization.
    /// Accumulators are not touched — supply is unchanged.
    ///
    /// Not pause-gated: a compliance primitive must stay executable during a
    /// pause, alongside `block_user` / `unblock_user`.
    pub fn force_transfer(
        e: Env,
        caller: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), MinterGatewayError> {
        check_positive_amount(amount)?;
        require_role_holder(&caller, &read_forced_transfer_manager(&e))?;

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        // Preflight `to` before clawback so `from`'s balance stays intact on a doomed call.
        let sac_addr = read_sac_token(&e);
        let sac_client = token::StellarAssetClient::new(&e, &sac_addr);
        require_destination_trustline_authorized(&sac_client, &to)?;
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

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        let old = read_yield_recipient(&e);
        write_yield_recipient(&e, &new_yield_recipient);

        emit_yield_recipient_set(&e, old, new_yield_recipient);

        Ok(())
    }

    // =========================================================================
    // Yield Recipient Manager Functions (claim)
    // =========================================================================

    /// Claims accrued yield by minting new SAC tokens to the yield recipient.
    /// Yield recipient manager only. Returns the amount of yield claimed.
    ///
    /// Note: Claimed yield is NOT added to principal — it does not earn more yield.
    /// Tokens are always minted to the yield recipient, regardless of who calls.
    pub fn claim_yield(e: Env, caller: Address) -> Result<i128, MinterGatewayError> {
        pausable::when_not_paused(&e);
        let recipient = read_yield_recipient(&e);
        require_role_holder(&caller, &read_yield_recipient_manager(&e))?;

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(&e);

        update_index(&e);

        let unclaimed_yield = get_accrued_yield(&e);

        if unclaimed_yield > 0 {
            // Preflight recipient before advancing total_supply so a misconfigured recipient returns a typed error.
            let sac_addr = read_sac_token(&e);
            let sac_client = token::StellarAssetClient::new(&e, &sac_addr);
            require_destination_trustline_authorized(&sac_client, &recipient)?;

            // Increase total_supply (but NOT total_principal — no compounding)
            increase_total_supply(&e, unclaimed_yield);
            sac_client.mint(&recipient, &unclaimed_yield);

            emit_yield_claimed(&e, recipient, unclaimed_yield);
        }

        Ok(unclaimed_yield)
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /// Returns whether the given account is blocked.
    /// Matches `stellar_tokens::fungible::blocklist::FungibleBlockList::blocked` —
    /// `true` means the account is blocked (SAC-unauthorized). Untouched
    /// accounts return `true` because the SAC issuer uses AUTH_REQUIRED.
    ///
    /// The SAC's `authorized` host function traps (not returns `false`) when
    /// the account has no classic trustline for the asset — so a naive
    /// `!authorized(account)` would make `blocked()` unusable for onboarding
    /// pre-flight checks. We catch that trap via `try_authorized` and treat
    /// any non-success outcome as "blocked": without a trustline there is no
    /// authorization state, so denying is the safe and truthful answer.
    pub fn blocked(e: Env, account: Address) -> bool {
        extend_instance_ttl(&e);
        let sac_addr = read_sac_token(&e);
        match token::StellarAssetClient::new(&e, &sac_addr).try_authorized(&account) {
            Ok(Ok(authorized)) => !authorized,
            _ => true,
        }
    }

    /// Returns the SAC token balance for the given address.
    /// Delegates to the underlying SAC — balances live on the SAC, not here.
    pub fn balance(e: Env, id: Address) -> i128 {
        extend_instance_ttl(&e);
        let sac_addr = read_sac_token(&e);
        token::TokenClient::new(&e, &sac_addr).balance(&id)
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

    /// Returns whether `addr` has block permission.
    pub fn is_block_operator(e: Env, addr: Address) -> bool {
        extend_instance_ttl(&e);
        is_block_operator(&e, &addr)
    }

    /// Returns whether `addr` has unblock permission.
    pub fn is_unblock_operator(e: Env, addr: Address) -> bool {
        extend_instance_ttl(&e);
        is_unblock_operator(&e, &addr)
    }

    /// Returns whether `addr` has pause permission.
    pub fn is_pauser(e: Env, addr: Address) -> bool {
        extend_instance_ttl(&e);
        is_pauser(&e, &addr)
    }
}

// =============================================================================
// Pausable (Pauser only)
// =============================================================================

#[contractimpl]
impl Pausable for YieldToken {
    /// Returns `true` if the contract is currently paused.
    fn paused(e: &Env) -> bool {
        extend_instance_ttl(e);
        pausable::paused(e)
    }

    /// Pauses the contract. Blocks mint, burn, claim_yield, set_interest_rate;
    /// compliance ops (`block_user`, `unblock_user`, `force_transfer`, `reconcile_burn`) stay live.
    /// Pauser only.
    fn pause(e: &Env, caller: Address) {
        if let Err(err) = require_pauser(e, &caller) {
            panic_with_error!(e, err);
        }

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(e);

        pausable::pause(e);
    }

    /// Unpauses the contract, resuming all blocked operations.
    /// Pauser only.
    fn unpause(e: &Env, caller: Address) {
        if let Err(err) = require_pauser(e, &caller) {
            panic_with_error!(e, err);
        }

        // Prolongs the Time-To-Live of the contract's instance storage.
        extend_instance_ttl(e);

        pausable::unpause(e);
    }
}
