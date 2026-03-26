# MGUSD Implementation Overview

M0's technical proposal for MGUSD on Stellar — a yield-bearing stablecoin built as a Soroban smart contract that administers a Stellar Asset Contract (SAC). This document covers the full implementation: flows, roles, contract interface, yield mechanics, compliance controls, and the Fireblocks SDK used by the Bridge operator.

---

## Flows

### 1. Minting (Bridge → Treasury)

1. MoneyGram receives fiat from an end user and notifies the Bridge
2. Bridge calls `mint(treasury_address, amount)` on the wrapper contract
3. Contract finalizes pending yield, increases `total_principal` and `total_supply`, then mints SAC tokens to the treasury address
4. Treasury now holds MGUSD on-ledger

### 2. User Distribution (Treasury → End User)

1. Admin or Distributor whitelists (unfreezes) accounts — individually via `unfreeze_account(caller, account)` or in batch via `batch_unfreeze_accounts(caller, accounts)` (up to 20 per call)
2. Treasury transfers tokens to the user via the SAC's standard SEP-41 `transfer()`
3. Whitelisted (unfrozen) accounts can freely transfer among themselves
4. Non-whitelisted (frozen) accounts cannot send or receive tokens

### 3. Redemption (End User → MoneyGram → Bridge)

1. End user initiates redemption through MoneyGram
2. Bridge calls `burn(user_address, amount)` — removes tokens at the SAC layer
3. Contract finalizes pending yield, decreases both accumulators
4. MoneyGram sends fiat to the end user off-chain

### 4. Yield Claiming (Bridge → MoneyGram)

1. Bridge calls `set_rate(rate_bps)` to set the current interest rate (this is a **Minter** permission, not Admin)
2. Yield accrues continuously on `total_principal` using the exponential index
3. Yield Recipient (MoneyGram) calls `claim_yield()` to mint accrued yield as new SAC tokens
4. Claimed yield increases `total_supply` but **not** `total_principal` — it does not compound

### 5. Forced Transfer (Compliance Action)

1. Forced Transfer Manager (Crossmint) or Admin identifies a need to move tokens between accounts
2. Caller invokes `force_transfer(from, to, amount)` — no authorization from the source account is needed
3. Contract clawbacks tokens from the source and mints them to the destination at the SAC layer
4. Accumulators are unchanged — this is a balance redistribution, not a supply change
5. Works even if the source account is frozen

---

## Architecture Diagram

![MGUSD Architecture](../images/architecture.png)

---

## Roles

| Role | Permissions | Intended Actor |
|------|------------|----------------|
| **Admin** | All contract functions (super-role) | M0 |
| **Minter** | `mint`, `burn`, `set_rate` | Bridge |
| **Yield Recipient Manager** | `set_yield_recipient` | M0 |
| **Yield Recipient** | `claim_yield` | MoneyGram |
| **Forced Transfer Manager** | `force_transfer` | *(configurable)* |
| **Distributor** | `freeze_account`, `unfreeze_account`, `batch_freeze_accounts`, `batch_unfreeze_accounts` | Crossmint |

**Design properties:**

- **Admin is a super-role** — can call any function in the contract, in addition to admin-exclusive functions (`set_admin`, `set_minter`, `set_yield_recipient_manager`, `set_forced_transfer_manager`, `set_distributor`, `reconcile_burn`, `upgrade`)
- All roles are **single-address** — exactly one holder per role at any time
- Only Admin can reassign roles (except Yield Recipient, which is managed by the Yield Recipient Manager, and Distributor is set by Admin)
- Every role-gated function calls `require_auth()` on the role holder — no implicit trust
- Roles are stored in **Instance** storage

---

## Contract Interface

> **Note:** Admin can call any function below, not just the admin-exclusive ones. Each non-admin role can only call its own functions.

### Admin-Exclusive Functions (7)

| Function | Signature | Description |
|----------|-----------|-------------|
| `set_admin` | `(new_admin: Address)` | Transfer admin role to a new address |
| `set_minter` | `(new_minter: Address)` | Set a new minter address |
| `set_yield_recipient_manager` | `(new_yrm: Address)` | Set a new yield recipient manager |
| `set_forced_transfer_manager` | `(new_ftm: Address)` | Set a new forced transfer manager |
| `set_distributor` | `(new_distributor: Address)` | Set a new distributor address |
| `reconcile_burn` | `(amount: i128)` | Decrease both accumulators to reconcile tokens destroyed outside the contract (e.g., sent to issuer) |
| `upgrade` | `(new_wasm_hash: BytesN<32>)` | Upgrade contract WASM to a new version |

### Minter Functions (3)

| Function | Signature | Description |
|----------|-----------|-------------|
| `mint` | `(caller: Address, to: Address, amount: i128)` | Mint SAC tokens and increase both accumulators |
| `burn` | `(caller: Address, from: Address, amount: i128)` | Remove SAC tokens and decrease both accumulators |
| `set_rate` | `(caller: Address, rate_bps: u32)` | Set interest rate in basis points (max 10000 = 100%) |

### Forced Transfer Manager Functions (1)

| Function | Signature | Description |
|----------|-----------|-------------|
| `force_transfer` | `(caller: Address, from: Address, to: Address, amount: i128)` | Force-move SAC tokens between accounts (clawback + mint) |

### Yield Recipient Manager Functions (1)

| Function | Signature | Description |
|----------|-----------|-------------|
| `set_yield_recipient` | `(caller: Address, new_yr: Address)` | Set the address that can claim yield |

### Distributor Functions (4)

| Function | Signature | Description |
|----------|-----------|-------------|
| `freeze_account` | `(caller: Address, account: Address)` | Freeze account on SAC (`set_authorized(false)`) |
| `unfreeze_account` | `(caller: Address, account: Address)` | Unfreeze account on SAC (`set_authorized(true)`) |
| `batch_freeze_accounts` | `(caller: Address, accounts: Vec<Address>)` | Freeze up to 20 accounts in a single transaction |
| `batch_unfreeze_accounts` | `(caller: Address, accounts: Vec<Address>)` | Unfreeze up to 20 accounts in a single transaction |

### Yield Recipient Functions (1)

| Function | Signature | Description |
|----------|-----------|-------------|
| `claim_yield` | `(caller: Address) -> i128` | Claim accrued yield; mints new SAC tokens to yield recipient |

### View / Query Functions (14)

| Function | Returns | Description |
|----------|---------|-------------|
| `admin` | `Address` | Current admin address |
| `minter` | `Address` | Current minter address |
| `yield_recipient_manager` | `Address` | Current yield recipient manager |
| `yield_recipient` | `Address` | Current yield recipient |
| `forced_transfer_manager` | `Address` | Current forced transfer manager |
| `distributor` | `Address` | Current distributor address |
| `sac_token` | `Address` | SAC token contract address |
| `interest_rate` | `u32` | Current rate in basis points |
| `current_index` | `i128` | Real-time index (includes pending growth) |
| `latest_index` | `i128` | Last stored index (from most recent update) |
| `accrued_yield` | `i128` | Pending yield available to claim |
| `total_principal` | `i128` | Yield-earning base (mints − burns) |
| `total_supply` | `i128` | Total outstanding tokens (principal + claimed yield) |
| `is_authorized` | `bool` | Whether an account is unfrozen on the SAC |

---

## Minter Gateway

The Minter acts as the **bridge gateway** — the sole entry point for supply changes.

### Mint

```
mint(to: Address, amount: i128)
```

1. Finalizes pending yield via `update_index()`
2. Increases `total_principal` by the present value of `amount` (`amount × INDEX_SCALE / latest_index`) and `total_supply` by the nominal `amount`
3. Cross-contract call: `StellarAssetClient::mint(to, amount)` on the SAC
4. Emits `sup_chg` event with delta and new accumulator values

Recipient must already be authorized (unfrozen) on the SAC.

### Burn

```
burn(from: Address, amount: i128)
```

1. Finalizes pending yield via `update_index()`
2. Decreases `total_principal` by the present value of `amount` (`amount × INDEX_SCALE / latest_index`) and `total_supply` by the nominal `amount`
3. Cross-contract call: `StellarAssetClient::clawback(from, amount)` on the SAC
4. Emits `sup_chg` event with negative delta

Returns `Err(BurnExceedsPrincipal)` if the present-value amount exceeds `total_principal` — you cannot burn more than was minted (prevents burning claimed yield). Does **not** require the target account's authorization.

### Set Rate

```
set_rate(rate_bps: u32)
```

1. No-op if rate is unchanged
2. Calls `set_interest_rate()` which first updates the index at the old rate, then applies the new rate
3. Emits `int_rate` event

Rate is in basis points: 100 = 1%, max 10,000 = 100%.

### Key Properties

- **Always updates the yield index** before modifying supply (prevents yield loss/gain from ordering)
- Burns use SAC clawback internally (not transfer-to-issuer), bypassing the issuer burn problem

### Reconcile Burn

```
reconcile_burn(amount: i128)
```

Admin-only reconciliation for tokens destroyed outside the contract (e.g., sent to the SAC issuer address).

1. Finalizes pending yield via `update_index()`
2. Decreases `total_principal` by the present value of `amount` (`amount × INDEX_SCALE / latest_index`) and `total_supply` by the nominal `amount`
3. Emits `sup_chg` event with negative delta

Does **not** interact with the SAC — no clawback or burn at the token layer. This is purely an accumulator correction to bring the contract's bookkeeping back in line with the actual circulating supply. See the [Issuer Burn Problem](#the-issuer-burn-problem) section for context.

---

## Forced Transfer

```
force_transfer(caller: Address, from: Address, to: Address, amount: i128)
```

Administrative token movement that does not require the source account's authorization. Forced Transfer Manager or Admin only.

1. Validates non-negative amount and caller role
2. Cross-contract call: `StellarAssetClient::clawback(from, amount)` on the SAC
3. Cross-contract call: `StellarAssetClient::mint(to, amount)` on the SAC
4. Emits `force_tx` event with `(from, to, amount)`

### Key Properties

- **No accumulator changes** — supply is unchanged (tokens are moved, not created or destroyed), so `total_principal` and `total_supply` are not touched
- **No source authorization** — only the caller (Forced Transfer Manager or Admin) must authenticate; the `from` account does not need to sign
- **Works on frozen accounts** — clawback bypasses the SAC's `AUTH_REQUIRED` freeze on the source
- **Destination must be authorized** — the `to` account must be unfrozen to receive the minted tokens
- **Dedicated event** — emits `force_tx`, not `sup_chg`, since supply doesn't change

---

## Yield Mechanics

### Continuous Index Model

Yield accrues continuously using an exponential index:

```
currentIndex = latestIndex × e^(rate × elapsed / SECONDS_PER_YEAR)
```

Where:
- `latestIndex` — last stored index value (initialized to `1.0`, scaled as `1e12`)
- `rate` — annual rate converted from basis points (`bps / 10000 × 1e12`)
- `elapsed` — seconds since last update
- `SECONDS_PER_YEAR` — `31,536,000` (365 days)

The `e^x` approximation uses a 4th-order Taylor series: `1 + x + x²/2 + x³/6 + x⁴/24`, accurate for all realistic rates (< 20% annual).

### Two Accumulators

| Accumulator | Tracks | Modified By |
|-------------|--------|-------------|
| `total_principal` | Yield-earning base (mints − burns) | `mint`, `burn`, `reconcile_burn` |
| `total_supply` | All outstanding tokens (principal + claimed yield) | `mint`, `burn`, `reconcile_burn`, `claim_yield` |

### Yield Accrual Formula

```
yield = total_principal × (newIndex − oldIndex) / INDEX_SCALE
```

- `INDEX_SCALE` = `1e12` (fixed-point scaling factor)
- Yield is accumulated in `accrued_yield` on every index update
- Only `total_principal` earns yield — **not** `total_supply`

### Non-Compounding

When `claim_yield()` is called:
1. Accrued yield is minted as new SAC tokens to the yield recipient
2. `total_supply` increases by the claimed amount
3. `total_principal` is **unchanged** — claimed yield does not earn more yield
4. `accrued_yield` resets to zero

### Index Update Ordering

The index is updated **before** every state-changing operation (`mint`, `burn`, `reconcile_burn`, `claim_yield`, `set_rate`). This ensures yield is finalized at the correct principal and rate before any changes take effect.

---

## Transfers & the Issuer Burn Problem

### SAC Transfer Mechanics

- Both sender **and** receiver must be authorized (unfrozen) for a SAC transfer to succeed
- Transfers happen at the SAC layer — the wrapper contract has no `transfer()` function
- Users call the SAC's standard SEP-41 `transfer()` directly

### The Issuer Burn Problem

On classic Stellar, sending tokens to the **issuer address** burns them automatically. If a user sends MGUSD to the issuer:

- Tokens are destroyed at the SAC layer
- The wrapper contract's `total_principal` and `total_supply` are **never updated**
- Yield keeps accruing on phantom principal — breaking the yield invariant

### Mitigation: AUTH_REQUIRED + Whitelist Model

The SAC is configured with `AUTH_REQUIRED` — all accounts start frozen by default.

1. Accounts can only transact after Admin or Distributor calls `unfreeze_account()`
2. The issuer account has no trustline for its own asset and cannot be frozen or unfrozen
3. Frozen accounts hold tokens but cannot move them (including to the issuer)

**Important caveat:** The issuer is **exempt from AUTH_REQUIRED** at the Stellar protocol level. This means authorized (unfrozen) users **can** send tokens directly to the issuer via SAC `transfer()` or classic Stellar operations. The whitelist model reduces accidental issuer burns by limiting who can transact, but does not eliminate the possibility entirely. If tokens are sent to the issuer, Admin can call `reconcile_burn(amount)` to decrease both accumulators and bring the contract's bookkeeping back in line with actual circulating supply. See the [Issuer Burn Prevention section in the README](../README.md#issuer-burn-prevention) and Note 2 for details.

---

## Compliance & Safety

### Freeze / Unfreeze

- SAC operates in `AUTH_REQUIRED` mode — accounts are unauthorized (frozen) by default
- `unfreeze_account(caller, addr)` → SAC `set_authorized(true)` → account can send/receive
- `freeze_account(caller, addr)` → SAC `set_authorized(false)` → account is blocked
- Admin or Distributor can freeze/unfreeze individual accounts
- **Batch operations:** `batch_freeze_accounts` and `batch_unfreeze_accounts` accept up to 20 accounts per call and can be called by Admin or Distributor
- The 20-account cap is derived from Soroban's per-transaction resource limits; each account consumes write entries for the SAC authorization state
- Batch operations are atomic — if any account fails, the entire transaction reverts
- Each account in a batch emits its own `freeze`/`unfreeze` event for indexer compatibility

### Token Transfers

- Transfers use the SAC's standard SEP-41 `transfer()` — the wrapper contract has no transfer function
- Both sender and receiver must be whitelisted (unfrozen) for a transfer to succeed
- Admin or Distributor whitelists accounts via `unfreeze_account()` and can revoke via `freeze_account()`
- Transfers do **not** update accumulators — they are balance redistributions, not mints/burns
- The issuer is exempt from `AUTH_REQUIRED` — authorized users can send tokens to the issuer, which destroys them without updating accumulators (see [Issuer Burn Problem](#the-issuer-burn-problem))

---

## Minter Gateway SDK (Fireblocks)

The `soroban-fireblocks-sdk` provides a TypeScript client for the Bridge to interact with the wrapper contract via Fireblocks' institutional custody infrastructure.

### SDK Methods

The SDK exposes dedicated methods for Minter actions and queries:

| SDK Method | Contract Function | Parameters |
|------------|-------------------|------------|
| `mint()` | `mint(caller, to, amount)` | `contractId`, `caller: string`, `to: string`, `amount: bigint` |
| `burn()` | `burn(caller, from, amount)` | `contractId`, `caller: string`, `from: string`, `amount: bigint` |
| `setRate()` | `set_rate(caller, rate_bps)` | `contractId`, `caller: string`, `rateBps: number` |
| `setMinter()` | `set_minter(new_minter)` | `contractId`, `newMinter: string` |
| `queryAdmin()` | `admin()` | `contractId` |
| `querySacToken()` | `sac_token()` | `contractId` |
| `deployFull()` | *(orchestrates 5-step deploy)* | `assetCode`, `assetIssuer`, `admin`, `minter`, `yieldRecipientManager`, `yieldRecipient`, `forcedTransferManager`, `wasm` |

Other functions are available through the generic `invokeContract({ contractId, method: "..." })` interface.

### Scripts

Runnable scripts are provided in `scripts/`:

| Script | Description |
|--------|-------------|
| `deploy-full.ts` | Full 5-step deploy pipeline (configure issuer → deploy SAC → upload WASM → deploy contract → transfer SAC admin) |
| `invoke-mint.ts` | Mint tokens to a destination address |
| `invoke-burn.ts` | Burn tokens from an address |
| `query-admin.ts` | Query the current admin address |
| `setup-trustline.ts` | Set up a trustline for the token |

### Fireblocks RAW Signing Pipeline

Every transaction follows this flow:

```
Build Tx → Simulate & Prepare → SHA-256 Hash → Fireblocks RAW Sign → Attach Signature → Submit & Poll
```

1. **Build** — Construct the Soroban invoke transaction with the source account's sequence number
2. **Simulate** — Soroban RPC simulates the transaction, returning resource fees and auth entries
3. **Prepare** — Assemble the simulation result into the transaction envelope
4. **Sign** — Send the 32-byte transaction hash to Fireblocks for MPC-based Ed25519 signing (`MPC_EDDSA_ED25519`)
5. **Submit** — Submit the signed transaction to the Stellar network and poll until terminal

> Note: RAW signing is a premium Fireblocks feature that requires explicit enablement on your vault.

