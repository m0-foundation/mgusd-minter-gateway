# Renouncing the Issuer Key

After deploying the Stellar Minter Gateway, we permanently disable the issuer Stellar account's ability to sign anything. From that point on, every privileged operation on the asset routes through the wrapper Soroban contract. This document explains what "renouncing" means and walks through the steps `scripts/deploy-renounce.sh` runs to get there.

## What renouncing means

The asset issuer is a Stellar G-account that holds classic-Stellar authority over the asset — it can freeze holders (`SetTrustLineFlags`), reclaim balances (`Clawback`), change asset flags, and rotate signers. We want those levers to live in the wrapper contract, not on a Stellar account whose seed could be compromised.

Renouncing is one classic-Stellar transaction containing one `SetOptionsOp` that:

1. **Sets `master_weight = 0`** — the master signer (the seed that controls the account from genesis) contributes 0 to every signature threshold. With no other signers configured, no key on the network can sign for the account, ever.
2. **Sets `AUTH_IMMUTABLE`** — locks the issuer's asset-control flags into their current state. No future op can change them.

Both fields apply atomically. After the transaction lands, the issuer is a cryptographically-sealed shell. It exists only to anchor the asset's `(code, issuer)` identity.

## What gets handed off, what gets burned

The script touches three distinct control points:

| Control point | What happens to it | When |
|---|---|---|
| **SAC admin** | Handed off from the issuer to the wrapper Soroban contract | Step 5 |
| **Issuer G-account** | Burned — signing capability destroyed forever | Step 7 |
| **Wrapper admin G-account** | Unchanged — stays as configured `ADMIN_PUBLIC_KEY` | — |

The wrapper admin is a separate Stellar account passed to the wrapper's `__constructor` at deploy time. After renunciation, it's the only on-chain authority left (can `transfer_sac_admin`, `upgrade` the wrapper WASM, rotate roles). Multisig'ing the wrapper admin via Fireblocks is the natural follow-up — that's a separate workstream.

## The pipeline

| Step | Signer | What happens |
|---|---|---|
| **0** | — (read-only) | Preflight: assert issuer has no pre-existing flags / trustlines / balances / pools |
| **1** | Issuer | `set_options` → `AUTH_REQUIRED \| AUTH_REVOCABLE \| AUTH_CLAWBACK_ENABLED` |
| **2** | Deployer | Deploy the Stellar Asset Contract (SAC) for `(code, issuer)` |
| **3** | Deployer | Upload the wrapper contract WASM |
| **4** | Deployer | Deploy the wrapper + run `__constructor` with the 8 role pubkeys |
| **5** | Issuer | Transfer SAC admin from issuer to wrapper |
| **smoke** | Deployer | Read `wrapper.admin()` — verify the deploy landed correctly |
| **6** | — (read-only) | Renounce preflight: assert flags, signers, SAC admin, wrapper admin |
| **7** | Issuer | `set_options` → `AUTH_IMMUTABLE + master_weight = 0`  ⚠️ **IRREVERSIBLE** |
| **8** | — (read-only) | Verify post-renounce chain state |

Steps 1–5 plus the smoke test mirror `scripts/deploy-testnet.sh` exactly (they share the same code via `scripts/lib/deploy-pipeline.sh`). Steps 0, 6, 7, and 8 are renounce-specific.

## The compliance trade-off

Renouncing forfeits the classic-Stellar issuer levers. The wrapper has equivalents for all of them:

| Classic issuer op forfeited | Wrapper equivalent |
|---|---|
| `SetTrustLineFlags` clearing `AUTHORIZED` (hard-freeze a holder) | `block_user` — SAC `set_authorized(false)` |
| Classic `ClawbackOp` (reclaim a balance) | `burn` (decrements supply) or `force_transfer` (redistributes) |
| `AllowTrustOp` setting `AUTHORIZED` (unfreeze) | `unblock_user` — SAC `set_authorized(true)` |
| Future `set_options` flag changes | **None** — flags are locked by `AUTH_IMMUTABLE` |

The "no future flag changes" gap is why step 6 enforces the exact pre-renounce flag set: wrong flags become wrong forever.

## Safety properties

- **Opt-in.** Step 7 only runs if `--renounce-issuer` is set explicitly. Default behavior is steps 0–5 only — equivalent to `deploy-testnet.sh`.
- **Dry-run.** `--dry-run` builds the renounce transaction's XDR and prints it without submitting, so operators can review before committing.
- **Mainnet confirmation gate.** On `--execute --network=public`, the operator must type the network passphrase verbatim to proceed.
- **Six preflight checks.** Step 6 verifies issuer flags, signer list, SAC admin, wrapper admin, and XLM reserve before letting step 7 fire. Any anomaly aborts.
- **Clean-issuer enforcement.** Step 0 makes the "deploy onto a clean issuer" property load-bearing in code, not just in the runbook.

## After renunciation

- The issuer's minimum-reserve XLM (~1.5 XLM at current schedule) is locked forever — account merge requires a signature, which is now impossible.
- The asset continues to function normally through the wrapper / SAC. Token holders are unaffected.
- The wrapper admin G-account is the only remaining on-chain authority. Multisig it.

## Further reading

- Script: [scripts/deploy-renounce.sh](../scripts/deploy-renounce.sh)
- Shared pipeline: [scripts/lib/deploy-pipeline.sh](../scripts/lib/deploy-pipeline.sh)
- Environment template: [scripts/deploy.env.example](../scripts/deploy.env.example)
