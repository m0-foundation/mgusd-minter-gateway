# Stellar Minter Gateway — Renounce-Issuer Deploy Plan

A second deploy path for the `mintergateway` contract that does not depend on Fireblocks and ends by permanently neutering the issuer G-account's signing capability via classic Stellar `set_options`. After this script runs, the issuer key holds no on-chain authority of any kind: every privileged operation routes through the wrapper contract, and the issuer account is a husk that exists only to anchor the asset's `(code, issuer)` identity.

---

## 1. Problem statement and goals

`scripts/deploy-testnet.sh` finishes by handing SAC admin to the wrapper, but the issuer G-account still retains classic-Stellar authority — `SetTrustLineFlags`, classic `Clawback`, `AllowTrust`, future flag changes, signer rotation, and so on. Any party that gains the issuer seed after deploy can re-attack the asset at the classic layer regardless of the wrapper's role gating.

This plan defines a non-Fireblocks deploy that:

1. Performs the existing 5-step pipeline verbatim (issuer flags → SAC deploy → WASM upload → wrapper deploy → SAC admin handoff), then
2. Submits a final `set_options` from the issuer that locks asset flags as immutable and sets `masterWeight = 0` with no other signers — making it cryptographically impossible for anyone (including the original issuer holder) to ever sign for the issuer account again.

The end state: every compliance lever lives in the wrapper. The issuer account remains as the asset anchor but is permanently inert. There is no operator-side recovery path; that is the point.

### Non-goals

- **Burning the wrapper admin key.** That is the territory of the multisig-admin track (a separate plan, not yet merged onto `develop` — applies the same `masterWeight = 0` primitive to a separate admin G-account behind a 2-of-3 Fireblocks-backed multisig). The wrapper admin in this plan remains a configured `ADMIN_PUBLIC_KEY`; any handoff to a multisig is a follow-up performed by the admin holder, not by this script. Note: after renunciation, the wrapper admin's authority becomes load-bearing — they can still `transfer_sac_admin` and `upgrade` the wrapper WASM, and there is no classic-issuer override anymore. Multisig'ing the wrapper admin is the natural follow-up.
- **Recovering issuer minimum-reserve XLM.** Account merge requires a signature, which `masterWeight = 0` makes impossible. The reserve (~1.5 XLM at current schedule) is locked forever. Operators should fund the issuer with the minimum required, nothing more.
- **Partial renunciation modes.** No "weight 0 but keep a backup signer," no "immutable flags but keep master weight," no "renounce just the master and add Fireblocks signers." The whole proposition of the script is irreversibility; partial modes belong in the multisig-admin doc, not here.
- **Mutating wrapper roles.** The 8 role addresses passed to `__constructor` are out of scope — this script performs no `set_minter` / `set_pauser` / `add_block_operator` calls.

### Assumptions

- The asset is being deployed cleanly: no pre-existing trustlines, claimable balances, liquidity-pool entries, or contract holders for `(asset_code, issuer)`. STEL1-6 still applies; the renounce step amplifies the cost of getting it wrong because there is no classic-clawback fallback once the master is neutered.
- The issuer key is locally signable (a `stellar keys` identity, ideally Ledger-backed for mainnet). The Fireblocks-custodied issuer path stays on the `sdk-integration` branch and is not addressed here.
- The wrapper WASM has been built and its sha256 will be re-verified locally against what the RPC reports (STEL1-7).

---

## 2. The renunciation primitive

Stellar classic `SetOptionsOp` is the only primitive needed. Two fields matter:

- **`master_weight = 0`** — the master signer (the seed that controls the G-account from genesis) contributes 0 to every signature threshold. With no other signers configured, no key on the network can sign for the account, ever. (This is the same primitive the multisig-admin track applies to the wrapper admin G-account; here we apply it to the issuer.)
- **`set_flags = AUTH_IMMUTABLE`** — locks the issuer's asset-control flags (`AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED`, set in step 1) into a permanent state. `AUTH_IMMUTABLE` is itself irreversible — once set, no future op can clear or alter the flag set. This is the belt to `master_weight = 0`'s suspenders: even if a future Stellar protocol change introduced some way to re-enable a master with weight 0 (it won't, but defense in depth), the asset flag configuration is independently locked.

### Single transaction, single op

The renunciation is one `SetOptionsOp` in one transaction, with both `setFlags = AUTH_IMMUTABLE` and `masterWeight = 0` set in the same op. A `SetOptionsOp` is a flat record with optional fields — there is no field-ordering ambiguity within one op. The op is signed by the master, the signature is checked once against the pre-op signer state (`master_weight = 1`, default `high_threshold = 0`, master signature weight 1 ≥ HIGH — authorized), and both fields apply atomically.

Empirical verification on the pinned CLI (`stellar 25.2.0`):

```
$ stellar tx new set-options --master-weight 0 --set-immutable --build-only
$ stellar xdr decode --type TransactionEnvelope ...
operations: [
  { set_options: { set_flags: 4, master_weight: 0, ... } }
]
```

→ exactly one op, both fields set. Open question Q1 resolved.

Atomicity rationale: a single op never observes an intermediate state where one field lands but not the other. The two-op alternative bundled in one tx is also safe *if* `master_weight = 0` is the last op (otherwise op 2 fails signature — Stellar evaluates each op's authorization against the post-op signer state, so a `master_weight = 0` in op 1 zeros the master's weight before op 2's signature is checked), but it is strictly more complex than the single-op form and offers no additional guarantee. We use the single-op form.

### No new signers

The point is a permanent dead-end, not a key handoff. We deliberately do not add other signers in the renunciation tx. Master weight 0 + zero other signers = no signature on earth meets any threshold for this account.

If a future ops requirement emerges that needs *some* signing capability on the issuer (e.g., to claim trustline reserves from defunct holders), it is unrecoverable. Operators must understand and accept that going in. This is not a bug; it is the safety property the plan exists to deliver.

### Irreversibility

- Minimum-reserve XLM (~1.5 XLM at current schedule, ~0.20 USD at current price) is locked on the issuer account forever.
- `account_merge` is impossible (it requires a signature).
- No future `set_options` is possible (no signature, plus `AUTH_IMMUTABLE` blocks flag changes regardless).
- Trustlines to the asset continue to function unchanged; the asset itself is fully usable through the wrapper and SAC. Renouncing the issuer key does not affect token holders.

---

## 3. The compliance trade-off

`scripts/deploy-testnet.sh` step 5 carries this comment verbatim:

> After this, the wrapper is the only address that can call mint / burn / clawback / set_authorized on the SAC. The issuer key is no longer the SAC admin — but it remains the classic-Stellar account that can sign SetTrustLineFlags / Clawback ops directly on classic trustlines (used for hard-freeze compliance flows).

Renouncing the issuer key forfeits exactly those classic-layer levers. The team must agree that the wrapper-side equivalents are sufficient. The mapping:

| Classic issuer op forfeited | Why we'd want it | Wrapper-side equivalent | Fully equivalent? |
|---|---|---|---|
| `SetTrustLineFlags` clearing `AUTHORIZED` | Hard-freeze a holder | `block_user` / `batch_block_users` (block operator → SAC `set_authorized(false)`) | Yes for SAC trustlines. The SAC and the classic asset share the same `(code, issuer)` and the same authorization state, so `set_authorized(false)` is observable to classic-Stellar transfers as well. |
| Classic `ClawbackOp` | Forcibly burn a held balance | `burn(caller, from, amount)` (minter, decrements both accumulators) or `force_transfer(from, to, amount)` (forced-transfer manager, redistributes without changing supply) — both backed by SAC `clawback` | Yes. The wrapper holds SAC admin so it has full clawback authority on every SAC-tracked balance. |
| `AllowTrustOp` setting `AUTHORIZED` | Authorize a holder | `unblock_user` / `batch_unblock_users` (unblock operator → SAC `set_authorized(true)`) | Yes. |
| Future `set_options` flag changes (e.g., enable `AUTH_CLAWBACK_ENABLED` retroactively, change `home_domain`, rotate signers) | Recover from a misconfigured deploy | None. After `AUTH_IMMUTABLE`, flags are locked. | No — this is the irreversibility. Mitigation: enforce the correct flag set in step 1, gate step 7 on a Horizon read-back that confirms the flags are exactly what was intended (see step 6 preflight). |
| Setting `home_domain`, `inflation_dest`, `master_weight > 0` | Asset metadata cosmetics, future signer rotation | None. | Acceptable: we are not running the issuer as a live account post-deploy. |

**Conclusion.** The wrapper-side controls are functionally sufficient *if and only if* the deploy preflight guarantees no non-SAC trustlines exist before step 1's flags are set. STEL1-6's "deploy onto a clean issuer" property carries forward and becomes load-bearing — orphan classic trustlines created against a dirty issuer cannot be reached by the wrapper's `block_user` (they predate `AUTH_REQUIRED` and will be auto-authorized), and after renunciation classic clawback is gone. The script must enforce a clean-issuer preflight as a non-skippable gate.

---

## 4. Script architecture

Two reasonable shapes:

- **Option A — extend `scripts/deploy-testnet.sh` with `--renounce-issuer`.** Pro: single source of truth for the 5-step body; less divergence drift. Con: the file's header banner is explicitly `TESTNET / DEV ONLY`, and the renounce path is the closest thing this repo has to a production-grade no-Fireblocks deploy. Folding it into a "testnet-only" script muddies the framing and invites operators to mis-read the boundary.
- **Option B — new script `scripts/deploy-renounce.sh`** (with shared helpers). Pro: clear separation; the new script can be marketed as the production no-Fireblocks path. Con: duplication of the 5-step body unless extracted to a sourced helper.

**Recommendation: Option B**, with the 5-step body extracted into `scripts/lib/deploy-pipeline.sh` (sourced by both scripts). Rationale:

- The framing distinction matters — `deploy-testnet.sh` should remain a reversible dev tool; `deploy-renounce.sh` is "you are about to brick the issuer, on purpose, forever."
- The renounce script wants extra preflight assertions (Horizon signer-list check, SAC admin assertion, optional WASM-name/symbol/decimals check) that don't belong in the testnet path.
- Extracting steps 1–5 into `lib/deploy-pipeline.sh` keeps both scripts thin and avoids the duplication smell. The testnet script becomes ~30 lines (env load + source helper + smoke); the renounce script becomes ~80 lines (env load + source helper + preflight + renounce + verify).

**Language: bash.** The `stellar` CLI already exposes `tx new set-options` with `--master-weight` and `--set-immutable`; no TypeScript is necessary. (Verification of single-tx multi-op support is an open question — see step 7 below.)

### Files added / changed

| Path | Purpose |
|---|---|
| `scripts/lib/deploy-pipeline.sh` (new) | Sourced helper exporting bash functions for each of the 5 steps + smoke. Idempotent on env-var validation. |
| `scripts/deploy-renounce.sh` (new) | The new pipeline. Refuses to run without `RENOUNCE_ISSUER=1` (or `--renounce-issuer`); supports `--dry-run` and `--execute`. |
| `scripts/deploy-testnet.sh` (refactor) | Slimmed to source `lib/deploy-pipeline.sh`. Behavior unchanged. |
| `scripts/deploy.env.example` (extend) | Documents `RENOUNCE_ISSUER`, `ISSUER_RESERVE_XLM_THRESHOLD` (warn threshold), and the renounce-specific confirmation prompts. |
| `docs/deploy-renounce-issuer-plan.md` (this doc) | Design plan, committed for review before any code lands. |
| `docs/deploy-renounce-runbook.md` (follow-up PR) | Operator-facing runbook; written after the script lands. |

---

## 5. Step-by-step pipeline

Steps 1–5 mirror `scripts/deploy-testnet.sh`. Step 0 and steps 6–8 are new.

### Step 0 — Pre-deploy issuer-cleanliness preflight (read-only, no signing)

`deploy-testnet.sh` today only asks operators to verify cleanliness manually (its in-script comment: *"This script does NOT verify the issuer is clean — verify manually before running."*). The renounce script promotes this to a non-skippable preflight, because — unlike the testnet script — there is no classic-clawback fallback once step 7 lands.

The script aborts if any of the following return non-empty for `(ASSET_CODE, ISSUER_PUBLIC_KEY)`:

| Source | What "non-empty" means | Why |
|---|---|---|
| Horizon `/accounts/{issuer}` | Issuer account already has any of: `flags.auth_required`, `flags.auth_revocable`, `flags.auth_clawback_enabled`, `flags.auth_immutable` set | Step 1 would either no-op or fail; either is a sign of a contaminated deploy. |
| Horizon `/assets?asset_code=…&asset_issuer=…` | Any record returned with `num_accounts > 0` or `num_claimable_balances > 0` or `num_liquidity_pools > 0` | Pre-existing trustlines / claimable balances / pools would predate step 1's `AUTH_REQUIRED` and auto-authorize outside the wrapper's reach. |
| Horizon `/accounts?asset=…:…` | Any holder account returned | Same. |

This is the load-bearing precondition §3 calls out. It must be enforced in code, not in the runbook.

### Step 1 — [ISSUER signs] `set_options` on issuer

Set `AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED`. Same as `deploy-testnet.sh`. Must precede any trustline.

### Step 2 — [DEPLOYER signs] Deploy SAC

`stellar contract asset deploy --asset CODE:ISSUER`. Permissionless. SAC's initial admin is the issuer.

### Step 3 — [DEPLOYER signs] Upload wrapper WASM

`stellar contract upload --wasm <wrapper.wasm>`. The script re-derives `sha256(WASM)` locally and asserts the RPC's returned hash matches before proceeding (STEL1-7).

### Step 4 — [DEPLOYER signs] Deploy wrapper + run constructor

`stellar contract deploy --wasm-hash <hash> -- --sac_token … --admin … …` (all 8 role pubkeys). The deployer gains no privilege; roles are set explicitly.

### Step 5 — [ISSUER signs] Hand SAC admin to wrapper

`stellar contract invoke --id <SAC> -- set_admin --new_admin <wrapper>`. After this, the wrapper is the sole SAC admin.

### Step 6 — Renounce-issuer preflight (read-only, no signing)

The script must abort if any of these checks fails:

| Check | Source | Failure mode |
|---|---|---|
| Issuer flags = `AUTH_REQUIRED \| AUTH_REVOCABLE \| AUTH_CLAWBACK_ENABLED` exactly | Horizon `GET /accounts/{issuer}` `flags` field | Abort. The flags that step 7 makes immutable must be the intended set — no surprises. |
| Issuer signers list contains exactly one signer (the master), `weight = 1`, no extras | Horizon `signers` field | Abort. If extra signers were added between deploy and renounce (e.g., an operator started setting up a multisig but didn't finish), `master_weight = 0` would leave those signers in control — the opposite of the intent. |
| SAC `admin()` returns the wrapper contract id | `stellar contract invoke --send=no --id <SAC> -- admin` | Abort. If step 5 didn't land or was reverted, renouncing strands the asset — neither the issuer (about to be neutered) nor the wrapper (not yet SAC admin) has authority. |
| Wrapper `admin()` returns `ADMIN_PUBLIC_KEY` | `stellar contract invoke --send=no --id <wrapper> -- admin` | Abort. Same smoke test as `deploy-testnet.sh`, but elevated from "informative" to "non-skippable precondition." |
| Issuer XLM balance ≤ `ISSUER_RESERVE_XLM_THRESHOLD` (default 5 XLM) | Horizon `balances` | **Warn** (not abort). Surface the locked-XLM cost to the operator before they confirm. |
| Operator confirms with the network passphrase echoed back | Interactive prompt | Abort on mismatch. Same pattern as the FB pipeline's `--execute --network=public` confirm. Skipped under `--dry-run`. |

Optionally (open question, see §10): assert SAC `name() / symbol() / decimals()` match expected values, defending against a wrong-WASM upload that somehow passed the hash check.

### Step 7 — [ISSUER signs] The renunciation transaction

One atomic transaction, source = `ISSUER`, one `SetOptionsOp` with two fields set:

- `setFlags = AUTH_IMMUTABLE`
- `masterWeight = 0`

CLI invocation (verified on `stellar 25.2.0` — see §2 for decoded XDR):

```bash
stellar tx new set-options \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --set-immutable \
  --master-weight 0
```

This produces a single transaction with one `SetOptionsOp` containing both fields. The op requires HIGH threshold; signature check runs against pre-op state (master weight 1 ≥ default HIGH 0), then both fields apply atomically. After this transaction lands, the script makes no further attempt to sign with `ISSUER_KEY`.

### Step 8 — Post-renounce verification (read-only)

| Assertion | Source |
|---|---|
| `master_weight == 0` | Horizon `thresholds` / `signers` |
| `signers` list is empty (no non-master signers were ever added) | Horizon `signers` |
| Low / med / high thresholds remain at their pre-renounce values (default 1/1/1) — they don't matter functionally with no weighted signers, but we record them for the audit log | Horizon `thresholds` |
| `flags` includes `AUTH_IMMUTABLE` | Horizon `flags` |
| SAC `admin()` still returns wrapper contract id | `stellar contract invoke --send=no` |
| Wrapper `admin()` still returns `ADMIN_PUBLIC_KEY` | `stellar contract invoke --send=no` |

The script prints a final ledger of "what is now immutable forever":

```
=== Issuer Renounced ===
  Issuer:                    G... (PERMANENTLY UNSIGNABLE)
  master_weight:             0
  signers:                   []
  flags:                     AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED | AUTH_IMMUTABLE
  Locked XLM (unrecoverable): N.NNN XLM
  SAC admin:                 <wrapper contract id>
  Wrapper admin:             G... (rotate via wrapper.set_admin)
```

Non-zero exit on any assertion mismatch.

---

## 6. Safety properties

| Where | What it does |
|---|---|
| CLI entry — env load | Refuses to start if any of the 8 role pubkeys is missing or malformed (STEL1-5, inherited from `deploy-testnet.sh`). |
| CLI entry — issuer key consistency | Asserts `stellar keys public-key $ISSUER_KEY_NAME == $ISSUER_PUBLIC_KEY` (inherited). |
| CLI entry — opt-in gate | Refuses to perform step 7 unless `RENOUNCE_ISSUER=1` (or `--renounce-issuer`) is set explicitly. Default behavior is steps 1–5 + smoke only, equivalent to `deploy-testnet.sh`. |
| CLI entry — interactive confirm | On `--execute --network=public`, prompts the operator to type the network passphrase verbatim. Mismatch aborts. Skipped on `--dry-run`. |
| Step 0 — issuer cleanliness preflight | Aborts if issuer flags are non-default, or if `(asset_code, issuer)` already has trustlines, claimable balances, or pools (STEL1-6). Promoted from manual-only in `deploy-testnet.sh` to non-skippable here — see §5 step 0 for the exact Horizon queries. |
| Step 3 — WASM hash verification | Re-derives `sha256(WASM)` locally; aborts if RPC's returned hash differs (STEL1-7). |
| Step 6 — renounce preflight | Five non-skippable assertions: issuer flags exact match, signer list has only master, SAC admin == wrapper, wrapper admin == configured `ADMIN_PUBLIC_KEY`, no extra signers added since deploy. Warn-only on excess issuer XLM. |
| Step 7 — single-op form | Both fields (`AUTH_IMMUTABLE`, `masterWeight = 0`) are set in one `SetOptionsOp`, applied atomically. Script makes no further `ISSUER_KEY` calls after this tx lands. |
| Step 7 — atomicity | One tx, one op, both fields. Never split into two txs. If a future CLI version stops accepting both flags in one invocation, the script aborts with a clear error rather than falling back to two txs. |
| Step 8 — post-renounce verification | Reads back chain state and asserts post-conditions; non-zero exit on mismatch. |

---

## 7. Operator-facing UX

### Required env vars

Same as `scripts/deploy-testnet.sh` plus:

- `RENOUNCE_ISSUER=1` (or `--renounce-issuer` flag) — explicit opt-in. Without this, the script behaves identically to `deploy-testnet.sh` (steps 1–5 + smoke, no renunciation).
- `ISSUER_RESERVE_XLM_THRESHOLD` (optional, default `5`) — warn-only threshold for excess XLM that will be locked.

### Modes

| Flag | Behavior |
|---|---|
| `--dry-run` | Runs steps 1–5 against the network as normal, then prints the renounce tx XDR (un-submitted) and stops. Useful for staging review before the irreversible step. |
| `--execute` | Runs the full pipeline including step 7. On `--network=public`, requires interactive passphrase confirm. |
| `--skip-deploy` | Runs only steps 6–8 against an already-deployed wrapper (e.g., re-running renounce after a partial failure where step 7 didn't land). Reads `SAC_CONTRACT_ID` and `WRAPPER_CONTRACT_ID` from env. |

### Quickstart (in `--help`)

```
deploy-renounce.sh — deploy + permanently neuter the issuer key

Usage:
  cp scripts/deploy.env.example .env
  $EDITOR .env                                       # roles, key names
  make build
  ./scripts/deploy-renounce.sh --dry-run             # rehearsal
  RENOUNCE_ISSUER=1 ./scripts/deploy-renounce.sh --execute

Flags:
  --renounce-issuer    Enable step 7. Without this, behaves like deploy-testnet.sh.
  --dry-run            Build but do not submit the renounce tx. Print XDR.
  --execute            Submit. On --network=public, requires interactive confirm.
  --skip-deploy        Skip steps 1-5 (re-run renounce against existing deploy).

WARNING: Step 7 is IRREVERSIBLE. The issuer key becomes permanently unsignable.
         All future compliance actions must route through the wrapper contract.
         Read docs/deploy-renounce-issuer-plan.md before running with --execute.
```

### Failure-mode runbook (mirrors `docs/fireblocks-deploy.md`)

The accompanying runbook PR will include a table of `(symptom, likely cause, recovery)`. Sketch:

| Symptom | Likely cause | Recovery |
|---|---|---|
| Step 1 fails with `op_auth_already_set` | Issuer flags partially set from a previous run | Verify Horizon flags. If they match the intended set, restart from step 2 with `--skip-step-1`. |
| Step 5 fails with `auth_required` | Issuer key behind `ISSUER_KEY_NAME` doesn't match `ISSUER_PUBLIC_KEY` | Already gated by the consistency check at CLI entry; should not occur. |
| Step 6 aborts: "issuer signers list has 2 entries" | Operator added an FB signer between deploy and renounce | Decide intent. If an FB-multisig issuer was the goal, abandon this script — Option B in `multisig-admin-architecture.md` applies (different shape entirely). |
| Step 7 fails mid-tx | RPC timeout, network blip, Ledger disconnect | Re-run with `--skip-deploy` — preflight will re-check. If it passes, retry. If `master_weight = 0` already landed but `AUTH_IMMUTABLE` did not (impossible with single-tx atomicity but listed for completeness), the issuer is unsignable and `AUTH_IMMUTABLE` cannot be set. Asset is still functional through the wrapper; document the gap and proceed. |
| Step 8 verification fails | Horizon stale | Wait one ledger and re-run with `--skip-deploy`. |

---

## 8. Mainnet vs testnet

The script must work for both via `STELLAR_NETWORK={testnet,public}`. Differences:

| Concern | Testnet | Mainnet |
|---|---|---|
| Issuer key custody | Throwaway local seed via `stellar keys` is acceptable | **Must** be hardware-backed (Ledger via `stellar keys`) or rejected outright. Local plaintext seed for a renouncing issuer key is unacceptable — even though the seed becomes useless after step 7, it holds full asset-control authority through step 5 and during the renounce tx. |
| Confirmation | Default | Interactive passphrase echo (`Public Global Stellar Network ; September 2015`) |
| Rehearsal | N/A | **Required**: deploy on testnet first with the same role pubkeys, run renounce, verify post-state, then re-run against mainnet. The plan document for the mainnet deploy should reference the testnet ledger entries as evidence the script behaves as expected. |
| Reserve XLM | Throwaway | Operator should fund issuer with exactly the minimum (~1.5 XLM at current schedule + buffer for the deploy txs); excess is locked. The script's `ISSUER_RESERVE_XLM_THRESHOLD` warning surfaces this. |

The script should refuse `--network=public` outright if `ISSUER_KEY_NAME` does not resolve to a Ledger-backed identity. (Implementation: `stellar keys ls --verbose` exposes whether an identity is hardware-backed; gate on that.)

---

## 9. Risks

| Severity | Risk | Mitigation |
|---|---|---|
| HIGH | Bricked deploy if step 7 runs before step 5 lands. | Step 6 preflight asserts SAC `admin()` == wrapper. Non-skippable. |
| HIGH | Bricked deploy if extra signers were added to the issuer between deploy and renounce — those signers retain control after `master_weight = 0`, defeating the entire premise. | Step 6 preflight asserts the signer list contains only the master. Abort otherwise. |
| HIGH | Operator runs `--renounce-issuer` without realizing they wanted to keep classic clawback as a compliance backstop. | Opt-in flag is non-default. `--dry-run` mode prints the XDR loudly. README-level documentation (this plan + the follow-up runbook) states "irreversible" prominently. The trade-off table in §3 must be reviewed before sign-off. |
| HIGH | `AUTH_IMMUTABLE` locks in a wrong flag set (e.g., operator forgot `CLAWBACK_ENABLED` in step 1). | Step 6 preflight asserts the exact flag set. Abort otherwise. Forces operators to either (a) re-run step 1 with the correct flags before renouncing, or (b) walk away from the deploy. |
| LOW | A future `stellar` CLI version regresses on accepting both `--set-immutable` and `--master-weight 0` in one invocation. | Verified on pinned `stellar 25.2.0`: one invocation → one `SetOptionsOp` with both fields. The script pins (or asserts) a known-good CLI version at startup. If a future bump regresses this, the script aborts with a clear error rather than splitting into two txs. |
| MEDIUM | Issuer key is on a Ledger and the device fails mid-renounce (battery, cable, firmware). | Pre-step-7 checklist in the runbook: full battery, fresh cable, firmware version verified. The deploy is recoverable up to and including step 5 (SAC admin handoff has already landed; the wrapper is operational). Only step 7 itself blocks on the device. Operator can re-run with `--skip-deploy` once the device is back. |
| LOW | Minimum-reserve XLM (~1.5 XLM) locked forever. | Documented in this plan, in `--help`, in the runbook. The reserve is small enough that we accept it. |
| LOW | Mainnet operators may reflexively assume an `AUTH_IMMUTABLE` issuer is "uncontactable" for compliance. | The runbook's compliance section explicitly maps every classic-issuer compliance action to its wrapper-side equivalent (the table in §3 of this plan). Reviewers must sign off on that table before mainnet rollout. |
| LOW | A future Stellar protocol change introduces some new authority on the issuer account that bypasses `master_weight = 0`. | `AUTH_IMMUTABLE` is the belt to the suspenders — even an exotic future protocol change targeting account-level authority would still hit the immutable-flag wall on the asset side. Both layers would have to be circumvented simultaneously. Acceptable. |

---

## 10. Open questions for review

1. ~~**`stellar tx new set-options` capabilities.** Does the pinned CLI (v25.2.0) accept `--set-immutable` and `--master-weight 0` in the same invocation, producing one tx with two ops? If not, what is the cleanest XDR-stitching path? Implementation must answer this before the script lands.~~ **Resolved.** Verified on `stellar 25.2.0`: one invocation → one tx with one `SetOptionsOp` containing both `set_flags = 4` and `master_weight = 0`. Single-op form is the implementation path. See §2 and §7.
2. **Cosmetic clears.** Should the renunciation tx also clear `home_domain` and `inflation_dest` (and ensure `low/med/high thresholds` are at expected values) before locking? They become immutable too. Recommend yes for `home_domain` (defaults to empty; locking a nonempty stale value is awkward), no for `inflation_dest` (deprecated, no operational impact).
3. **SAC metadata assertions.** Should step 6 assert `sac.name() / symbol() / decimals()` match expected values? Defends against a wrong-WASM upload that somehow passed step 3's hash check (e.g., a malicious mirror RPC that returns the correct hash but stores a different blob). Recommend yes for `decimals()` (cheap, catches the worst-case mismatch); name/symbol are typically stable and lower-leverage.
4. **"Renounce on demand" envelope.** Is there value in a `--build-renounce-only` mode that produces and signs the renounce tx but doesn't submit, so the operator can hold the signed XDR offline and submit later? Recommend no — it defeats the atomic-deploy story and creates a footgun (signed envelope leaks → adversary submits at unexpected time).
5. **Future of `deploy-testnet.sh`.** Once `deploy-renounce.sh` is stable and the shared `lib/deploy-pipeline.sh` exists, should `deploy-testnet.sh` continue to exist as a separate script, or fold into `deploy-renounce.sh` without `--renounce-issuer`? Recommend keep both for clarity; the testnet script is a useful "I'm just iterating on contract code" tool.

---

## 11. Estimated complexity

LOW–MEDIUM. The renunciation primitive is one (atomic) `set_options` invocation; the surrounding work is preflight assertions, Horizon-query plumbing, and operator-facing UX.

| Workstream | Effort |
|---|---|
| `lib/deploy-pipeline.sh` extraction + `deploy-testnet.sh` refactor | 0.5 day |
| `deploy-renounce.sh` (steps 6–8 + opt-in / dry-run UX) | 1 day |
| Resolve open question 1 (CLI capabilities, possibly XDR stitcher) | 0.5–1 day |
| Operator runbook (`docs/deploy-renounce-runbook.md`) | 0.5 day |
| Manual rehearsal on testnet (deploy + renounce + verify) | 0.5 day |
| **Total** | **~2.5–3.5 days** |

Tests: Rust contract has no surface change, so no `cargo test` additions. Bash-level coverage will be a manual rehearsal log captured in the runbook (testnet ledger entries linked from the PR), since shell-script unit testing here adds more friction than it removes.

---

## Files referenced

- `scripts/deploy-testnet.sh`
- `scripts/deploy.env.example`
- `docs/MGUSD-IMPLEMENTATION-OVERVIEW.md`
- `docs/multisig-admin-architecture.md`
- `contracts/mintergateway/src/contract.rs`
- `README.md`
