# Implementation Plan: SDK ↔ Contract Parity (sdk-integration branch)

**Branch:** `feat/sdk-contract-parity` (off `origin/sdk-integration`)
**Reference:** [contracts/mintergateway/src/contract.rs](../../contracts/mintergateway/src/contract.rs) + [soroban-fireblocks-sdk/src/sctoken-client.ts](../../soroban-fireblocks-sdk/src/sctoken-client.ts)

## Requirements Restatement

- Audit the contract surface in [contract.rs](../../contracts/mintergateway/src/contract.rs) on `sdk-integration` against the SDK wrappers in [sctoken-client.ts](../../soroban-fireblocks-sdk/src/sctoken-client.ts) on the same branch.
- Deliver a parity-first plan: every callable contract method has a matching SDK wrapper, all signatures match, no orphan wrappers.
- Add one cheap regression guard so future contract additions can't silently drift from the SDK.
- Do not pre-create runtime verification scripts unless explicitly requested.

## Architecture Findings

### A. Contract surface — sdk-integration

The contract is `YieldToken` in [contract.rs](../../contracts/mintergateway/src/contract.rs). There are **two** `#[contractimpl]` blocks: `impl YieldToken` (main) and `impl Pausable for YieldToken` (trait). Both export to the contract ABI.

| # | Method | Params | Auth | Behavior |
|---|---|---|---|---|
| 1 | `__constructor` | sac_token, admin, minter, yield_recipient_manager, yield_recipient, forced_transfer_manager, block_operator, unblock_operator, pauser (all Address) | none (one-shot) | Constructor — set at deploy via wrapper |
| 2 | `set_admin` | new_admin: Address | admin | Transfer admin |
| 3 | `set_minter` | new_minter: Address | admin | Set minter |
| 4 | `set_yield_recipient_manager` | new_yield_recipient_manager: Address | admin | Set yield recipient manager |
| 5 | `set_forced_transfer_manager` | new_forced_transfer_manager: Address | admin | Set forced transfer manager |
| 6 | `add_block_operator` | addr: Address | admin | Grant block role |
| 7 | `remove_block_operator` | addr: Address | admin | Revoke block role |
| 8 | `add_unblock_operator` | addr: Address | admin | Grant unblock role |
| 9 | `remove_unblock_operator` | addr: Address | admin | Revoke unblock role |
| 10 | `set_pauser` | new_pauser: Address | admin | Set pauser |
| 11 | `block_user` | user, operator: Address | block operator | SAC `set_authorized(user, false)` |
| 12 | `unblock_user` | user, operator: Address | unblock operator | SAC `set_authorized(user, true)` |
| 13 | `batch_block_users` | users: Vec<Address>, operator: Address | block operator | Up to 40 |
| 14 | `batch_unblock_users` | users: Vec<Address>, operator: Address | unblock operator | Up to 40 |
| 15 | `transfer_sac_admin` | new_sac_admin: Address | admin | SAC `set_admin`; gateway loses admin |
| 16 | `upgrade` | new_wasm_hash: BytesN<32> | admin | WASM upgrade |
| 17 | `mint` | caller, to: Address, amount: i128 | minter | when_not_paused |
| 18 | `burn` | caller, from: Address, amount: i128 | minter | when_not_paused |
| 19 | `reconcile_burn` | amount: i128 | admin | when_not_paused |
| 20 | `set_rate` | caller: Address, rate_bps: u32 | minter | — |
| 21 | `force_transfer` | caller, from, to: Address, amount: i128 | forced_transfer_manager | when_not_paused |
| 22 | `set_yield_recipient` | caller: Address, new_yield_recipient: Address | yield_recipient_manager | — |
| 23 | `claim_yield` | caller: Address | yield_recipient_manager | when_not_paused; returns i128 |
| 24 | `blocked` | account: Address | view | bool |
| 25 | `balance` | id: Address | view | i128 |
| 26 | `sac_token` | — | view | Address |
| 27 | `interest_rate` | — | view | u32 |
| 28 | `current_index` | — | view | i128 |
| 29 | `latest_index` | — | view | i128 |
| 30 | `accrued_yield` | — | view | i128 |
| 31 | `total_principal` | — | view | i128 |
| 32 | `total_supply` | — | view | i128 |
| 33 | `admin` | — | view | Address |
| 34 | `minter` | — | view | Address |
| 35 | `yield_recipient_manager` | — | view | Address |
| 36 | `yield_recipient` | — | view | Address |
| 37 | `forced_transfer_manager` | — | view | Address |
| 38 | `is_block_operator` | addr: Address | view | bool |
| 39 | `is_unblock_operator` | addr: Address | view | bool |
| 40 | `pauser` | — | view | Address |
| 41 | `paused` | — (trait) | view | bool |
| 42 | `pause` | caller: Address (trait) | pauser | `caller.require_auth()` then equality check vs `read_pauser` |
| 43 | `unpause` | caller: Address (trait) | pauser | `caller.require_auth()` then equality check vs `read_pauser` |

Delta vs `develop` (informational — not parity bugs):

- Block/unblock roles were split in commit `5233b6d`. The constructor on `sdk-integration` takes nine addresses (sac_token + 8 roles). The SDK on this branch already reflects the split (see [sctoken-client.ts:188-218](../../soroban-fireblocks-sdk/src/sctoken-client.ts#L188-L218)) and the constructor invocation passes all nine ([sctoken-client.ts:336-346](../../soroban-fireblocks-sdk/src/sctoken-client.ts#L336-L346)). Aligned.

### B. SDK surface — sdk-integration

Source: [sctoken-client.ts](../../soroban-fireblocks-sdk/src/sctoken-client.ts). Exported on `SctokenFireblocksClient`:

| # | SDK method | Contract method | Params (after `contractId`) | Status |
|---|---|---|---|---|
| 1 | `mint` | `mint` | caller, to, amount | OK |
| 2 | `burn` | `burn` | caller, from, amount | OK |
| 3 | `setRate` | `set_rate` | caller, rateBps | OK |
| 4 | `setMinter` | `set_minter` | newMinter | OK |
| 5 | `blockUser` | `block_user` | user, operator | OK |
| 6 | `unblockUser` | `unblock_user` | user, operator | OK |
| 7 | `batchBlockUsers` | `batch_block_users` | users, operator | OK |
| 8 | `batchUnblockUsers` | `batch_unblock_users` | users, operator | OK |
| 9 | `forceTransfer` | `force_transfer` | caller, from, to, amount | OK |
| 10 | `reconcileBurn` | `reconcile_burn` | amount | OK |
| 11 | `claimYield` | `claim_yield` | caller | OK |
| 12 | `addBlockOperator` | `add_block_operator` | addr | OK |
| 13 | `removeBlockOperator` | `remove_block_operator` | addr | OK |
| 14 | `addUnblockOperator` | `add_unblock_operator` | addr | OK |
| 15 | `removeUnblockOperator` | `remove_unblock_operator` | addr | OK |
| 16 | `queryAdmin` | `admin` | — | OK |
| 17 | `querySacToken` | `sac_token` | — | OK |
| 18 | `queryMinter` | `minter` | — | OK |
| 19 | `queryYieldRecipient` | `yield_recipient` | — | OK |
| 20 | `queryYieldRecipientManager` | `yield_recipient_manager` | — | OK |
| 21 | `queryForcedTransferManager` | `forced_transfer_manager` | — | OK |
| 22 | `queryIsBlockOperator` | `is_block_operator` | account | OK |
| 23 | `queryIsUnblockOperator` | `is_unblock_operator` | account | OK |
| 24 | `queryBlocked` | `blocked` | account | OK |
| 25 | `queryBalance` | `balance` | id | OK |
| 26 | `queryTotalSupply` | `total_supply` | — | OK |
| 27 | `queryTotalPrincipal` | `total_principal` | — | OK |
| 28 | `queryAccruedYield` | `accrued_yield` | — | OK |
| 29 | `queryCurrentIndex` | `current_index` | — | OK |
| 30 | `queryLatestIndex` | `latest_index` | — | OK |
| 31 | `queryInterestRate` | `interest_rate` | — | OK |
| 32 | `deployFull` | `__constructor` (orchestrates issuer flags, deploySac, uploadWasm, deployContract, SAC set_admin) | — | OK |

Primitives inherited from `SorobanFireblocksClient` (`invokeContract`, `setupTrustline`, `configureIssuer`, `deploySac`, `uploadWasm`, `deployContract`) are reused and not parity-relevant.

### C. Gap analysis

**(a) Contract methods with NO SDK wrapper — MISSING (11):**

| # | Contract method | Notes |
|---|---|---|
| M1 | `set_admin` | Admin rotation. |
| M2 | `set_yield_recipient_manager` | Admin → set manager. |
| M3 | `set_forced_transfer_manager` | Admin → set manager. |
| M4 | `set_pauser` | Admin → set pauser. |
| M5 | `set_yield_recipient` | yield_recipient_manager-gated. |
| M6 | `transfer_sac_admin` | Admin → SAC handoff (irreversible). |
| M7 | `upgrade` | Admin → WASM upgrade. |
| M8 | `pause` (Pausable trait) | Pauser-gated. |
| M9 | `unpause` (Pausable trait) | Pauser-gated. |
| M10 | `paused` (Pausable trait) | View. |
| M11 | `pauser` | View. |

**(b) SDK wrappers with drifted signatures — STALE:** None. Every existing wrapper's args list matches its target.

**(c) SDK wrappers targeting non-existent contract methods — ORPHANS:** None.

### D. Pre-existing observations — outside parity scope

Flagged for visibility — **not** in the plan (CLAUDE.md §3 surgical changes):

1. `pause`/`unpause` auth model: calls `caller.require_auth()` then compares `caller != read_pauser(e)` rather than using `require_role_holder`. Inconsistent with other role-gated methods but functionally equivalent. Driven by the Pausable trait's signature.
2. `upgrade` does not call `caller.require_auth()` — relies solely on `require_admin`. Consistent with other admin setters on this branch.
3. `reconcile_burn` omits `caller` arg and relies on `require_admin` directly. The SDK wrapper correctly omits `caller`. Worth noting only because every other state-changing method takes an explicit caller.

These should be raised separately if the user wants behavior changes.

---

## Implementation Steps

### Phase 1 — Parity (mechanical fill-in)

All wrappers follow the existing template in [sctoken-client.ts](../../soroban-fireblocks-sdk/src/sctoken-client.ts): one `params` object with `contractId` plus the contract method's argument fields, body delegates to `this.invokeContract` or `this.simulateView`. Add a matching param `interface` to [sctoken-types.ts](../../soroban-fireblocks-sdk/src/sctoken-types.ts) and re-export from [index.ts](../../soroban-fireblocks-sdk/src/index.ts).

**Group A — admin setters (M1–M4).** Each is single-Address, admin-gated. Pattern matches `setMinter` exactly.

1. **`setAdmin`** → `set_admin(new_admin: Address)`
   - Type: `SetAdminParams { contractId: string; newAdmin: string }`
   - Args: `[addressToScVal(params.newAdmin)]`
2. **`setYieldRecipientManager`** → `set_yield_recipient_manager(new_yield_recipient_manager: Address)`
   - Type: `SetYieldRecipientManagerParams { contractId; newYieldRecipientManager: string }`
3. **`setForcedTransferManager`** → `set_forced_transfer_manager(new_forced_transfer_manager: Address)`
   - Type: `SetForcedTransferManagerParams { contractId; newForcedTransferManager: string }`
4. **`setPauser`** → `set_pauser(new_pauser: Address)`
   - Type: `SetPauserParams { contractId; newPauser: string }`

**Group B — manager-gated setter (M5).**

5. **`setYieldRecipient`** → `set_yield_recipient(caller: Address, new_yield_recipient: Address)`
   - Type: `SetYieldRecipientParams { contractId; caller: string; newYieldRecipient: string }`
   - Args: `[addressToScVal(caller), addressToScVal(newYieldRecipient)]`

**Group C — destructive admin ops (M6, M7).**

6. **`transferSacAdmin`** → `transfer_sac_admin(new_sac_admin: Address)`
   - Type: `TransferSacAdminParams { contractId; newSacAdmin: string }`
   - JSDoc: irreversible; wrapper loses mint/burn/clawback/authorize on the SAC.
7. **`upgrade`** → `upgrade(new_wasm_hash: BytesN<32>)`
   - Type: `UpgradeParams { contractId; newWasmHash: Buffer | string }` — accept hex or Buffer.
   - Helper: add `bytesN32ToScVal(b: Buffer): xdr.ScVal` to [scval-helpers.ts](../../soroban-fireblocks-sdk/src/scval-helpers.ts) with a length-32 assertion. Used once.
   - Encoding: `xdr.ScVal.scvBytes(buf)`.

**Group D — Pausable trait (M8–M11).** The trait is part of the contract ABI on this branch.

8. **`pause`** → `pause(caller: Address)`
   - Type: `PauseParams { contractId; caller: string }`
   - Args: `[addressToScVal(caller)]`
9. **`unpause`** → `unpause(caller: Address)`
   - Reuses `PauseParams` (symmetric with `BlockUserParams` shared by block/unblock).
10. **`queryPaused`** → `paused()`
    - View, no args. Returns `boolean` via `scValToNative`. Pattern matches `queryBlocked`.
11. **`queryPauser`** → `pauser()`
    - View, no args. Returns `string` via `Address.fromScVal`. Pattern matches `queryAdmin`.

**Wrap-up:**

12. Re-export all new types from [index.ts](../../soroban-fireblocks-sdk/src/index.ts).
13. **Unit tests** in [tests/unit/sctoken-client.test.ts](../../soroban-fireblocks-sdk/tests/unit/sctoken-client.test.ts), following existing patterns:
    - State-changing wrappers: assert `buildInvokeTransaction` called with expected `method` string and arg ScVal types/values.
    - Views: assert `simulateTransaction` was called, `signHash`/`submitAndPoll` were not, and decoded return value matches.
    - `upgrade`: include a negative test passing a 31-byte buffer; assert `bytesN32ToScVal` throws before any tx is built.

**Acceptance for Phase 1:**
- `npm run build` and `npm test` both green in [soroban-fireblocks-sdk/](../../soroban-fireblocks-sdk/).
- Every entry in the contract surface table (rows 2–43, excluding `__constructor`) maps to exactly one SDK method.
- All existing tests untouched.

---

### Phase 2 — Parity guard

Add a single test that fails loudly when contract surface and SDK surface drift.

14. **New file:** [tests/unit/parity.test.ts](../../soroban-fireblocks-sdk/tests/unit/parity.test.ts)
    - Define `EXPECTED_CONTRACT_METHODS: readonly string[]` containing every contract method name (snake_case strings: `set_admin`, `set_minter`, …, `pause`, `unpause`, `paused`, `pauser`). Exclude `__constructor` (covered by `deployFull`).
    - Read [sctoken-client.ts](../../soroban-fireblocks-sdk/src/sctoken-client.ts) at test time as a string (`fs.readFileSync`).
    - For each expected method, assert the file contains `method: "${name}"`. The wrapper template always uses that literal.
    - On failure: throw with the list of missing method names.
    - Why source-scan vs reflection: TS classes don't expose contract method strings at runtime; instantiating the client doesn't verify the target contract string. Source-scan is the closest mechanical check.
15. **Second assertion (same test):** for each `method: "..."` literal in the source, assert it's in the expected set. Catches orphans on future refactors.

**Acceptance for Phase 2:**
- New test passes after Phase 1.
- Deleting any single wrapper (e.g., commenting out `setAdmin`) fails the test with a message naming `set_admin`.
- ~50-LOC test file, no runtime overhead, no new deps.

---

### Phase 3 — Verification scripts (deferred, by request only)

Not pre-created. Listed for completeness:

- `pause-via-fireblocks.ts` / `unpause-via-fireblocks.ts` (pauser key)
- `transfer-sac-admin-via-fireblocks.ts` (admin key; one-way, gated by a confirmation prompt)
- `upgrade-via-fireblocks.ts` (admin key)
- `set-yield-recipient-via-fireblocks.ts` (yield_recipient_manager key)
- `set-pauser-via-fireblocks.ts`, `set-minter-via-fireblocks.ts`, etc. for admin role rotations

These live in [soroban-fireblocks-sdk/scripts/](../../soroban-fireblocks-sdk/scripts/), modelled on [invoke-mint.ts](../../soroban-fireblocks-sdk/scripts/invoke-mint.ts).

---

## Dependencies

- Phase 1 has no inter-step dependencies; steps 1–13 can land in any order or as one PR.
- Phase 2 depends on Phase 1 only because the parity test would otherwise fail.
- Phase 3 depends on nothing structurally — gated solely on user demand.

## Risks

- **`upgrade` accepting raw `Buffer`** makes it easy to pass the wrong bytes (SHA-512, ASCII, WASM body instead of hash).
  - Mitigation: length-32 assertion in `bytesN32ToScVal`. A `{ wasm: Buffer }` shape that hashes internally is broader scope — deferred.
- **Source-scan test (Step 14) passes silently** if a wrapper exists with a typo in the method string (e.g., `"set_admn"`).
  - Mitigation: per-wrapper unit tests (Step 13) cover correctness; Phase 2 covers cardinality. Both layers together cover both axes.
- **Pausable trait upstream rename** would break contract ABI and parity test together.
  - Mitigation: none needed — loud failure is desired.
- **Operational risk:** `transferSacAdmin` and `upgrade` are irreversible / state-mutating. Putting them in the SDK widens blast radius if a Fireblocks vault is misconfigured.
  - Mitigation: strong JSDoc; keep the corresponding script out of the runners directory until needed (Phase 3).

## Complexity

- Phase 1: ~150–200 LOC of TS across two files, mechanical, plus ~250 LOC of test scaffolding. Low complexity, high tedium.
- Phase 2: ~50 LOC, single file, single test. Low.
- Phase 3: variable, deferred.

## Success Criteria

- [ ] Every row 2–43 of the contract surface table has a corresponding SDK method.
- [ ] `npm test` in [soroban-fireblocks-sdk/](../../soroban-fireblocks-sdk/) green.
- [ ] Parity test fails with a named-method diagnostic if any wrapper is removed.
- [ ] No changes to existing wrappers, types, or tests outside additions enumerated above.
- [ ] No new runtime dependencies.

## Relevant Files

- [contracts/mintergateway/src/contract.rs](../../contracts/mintergateway/src/contract.rs) — source of truth
- [contracts/mintergateway/src/lib.rs](../../contracts/mintergateway/src/lib.rs)
- [contracts/mintergateway/src/roles.rs](../../contracts/mintergateway/src/roles.rs)
- [soroban-fireblocks-sdk/src/sctoken-client.ts](../../soroban-fireblocks-sdk/src/sctoken-client.ts) — Phase 1 edits
- [soroban-fireblocks-sdk/src/sctoken-types.ts](../../soroban-fireblocks-sdk/src/sctoken-types.ts) — Phase 1 edits
- [soroban-fireblocks-sdk/src/scval-helpers.ts](../../soroban-fireblocks-sdk/src/scval-helpers.ts) — add `bytesN32ToScVal`
- [soroban-fireblocks-sdk/src/index.ts](../../soroban-fireblocks-sdk/src/index.ts) — re-export new types
- [soroban-fireblocks-sdk/tests/unit/sctoken-client.test.ts](../../soroban-fireblocks-sdk/tests/unit/sctoken-client.test.ts) — extend with per-wrapper tests
- [soroban-fireblocks-sdk/tests/unit/parity.test.ts](../../soroban-fireblocks-sdk/tests/unit/parity.test.ts) — new file (Phase 2)

---

**WAITING FOR CONFIRMATION** — proceed with the full plan, just Phase 1, or modify?
