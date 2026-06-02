# Fireblocks Deploy — One-Pager

End-to-end deploy of the MGUSD wrapper contract from a single operator command, with the issuer-authority transactions signed via a Fireblocks vault and the protocol-permissionless transactions signed by a throwaway local key. This is the Fireblocks equivalent of [`scripts/deploy-pipeline.sh`](../scripts/deploy-pipeline.sh); the bash path is untouched and remains supported for environments that don't use Fireblocks.

Run: `npm run deploy` from `soroban-fireblocks-sdk/` after configuring `.env` per [`.env.example`](../soroban-fireblocks-sdk/.env.example).

## When to use this vs the bash deploy

| Scenario | Use |
|---|---|
| Issuer key lives in a Fireblocks vault (production / staging mainnet) | **This script** |
| Issuer key is a local seed in the stellar-keys identity store (dev / testnet experimentation) | [`scripts/deploy-pipeline.sh`](../scripts/deploy-pipeline.sh) |

Both produce the same on-chain artifacts. The only difference is which signer authorizes the two issuer-authority ops (steps 1 and 5 below).

## Signing model — who signs what

The deploy splits authority between two distinct keys to keep blast radius minimal:

| Role | Key location | Signs | Why |
|---|---|---|---|
| **ISSUER** | Fireblocks vault (`ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID`) | Steps 1 + 5 (issuer-authority Stellar ops) | Custodied, audited, slow. Two TAP cycles per deploy. |
| **DEPLOYER** | Local Ed25519 seed (`DEPLOYER_SECRET_KEY`) | Steps 2–4 (protocol-permissionless Soroban ops) | Throwaway. Funded just enough to deploy. Abandoned post-deploy — has no privileged role on the resulting contract. |

The deployer's pubkey appearing as a role on the wrapper would brick that role when the key is abandoned, so the deploy script warns if any of the 8 wrapper roles equals the deployer pubkey.

## The 5 steps

Numbered to match `soroban-fireblocks-sdk/scripts/deploy-full.ts`.

### Step 0 — Preflights (no signing, no on-chain state)

- WASM source resolved per the [decision matrix](#wasm-source-decision-matrix) (downloads from a GitHub release if `RELEASE_TAG` is set; verifies the Sigstore attestation before proceeding)
- WASM bytes sha256 matches `EXPECTED_WASM_SHA256`
- `ISSUER_PUBLIC_KEY` derives from the configured Fireblocks vault (no mis-paired vault/key)
- Issuer Stellar account has zero pre-existing flags (proves it's a fresh issuer, not a contaminated one)
- Issuer and deployer XLM balances meet `ISSUER_MIN_XLM` / `DEPLOYER_MIN_XLM` thresholds
- Operator confirms an explicit `y/N` showing every value about to be signed

Any failure here aborts before a single Fireblocks TAP is consumed.

### Step 1 — `[ISSUER]` Configure issuer flags + home_domain

A single classic Stellar `setOptions` op signed by the issuer Fireblocks vault. Sets:

- `AUTH_REQUIRED` — accounts must be explicitly authorized before they can hold the asset
- `AUTH_REVOCABLE` — admin can freeze (deauthorize) accounts post-authorization
- `AUTH_CLAWBACK_ENABLED` — admin can reclaim balances (required for the wrapper's `burn()` via SAC clawback)
- `home_domain` — set to the operator's `HOME_DOMAIN` env var; used by wallets to fetch the SEP-1 stellar.toml for asset metadata

**Notably never sets `AUTH_IMMUTABLE`** — the issuer is NOT renounced here. Renouncement is a separate post-deploy step (see [`docs/issuer-renunciation.md`](issuer-renunciation.md)).

One Fireblocks TAP. ~0.00001 XLM in fees.

### Step 2 — `[DEPLOYER]` Deploy the Stellar Asset Contract (SAC)

A Soroban `createStellarAssetContract` op signed locally by the deployer key. Creates the SAC wrapping the classic asset `(ASSET_CODE, ISSUER_PUBLIC_KEY)`. The SAC implements SEP-41 and starts with its admin set to the issuer pubkey by Stellar protocol default.

No Fireblocks TAP. Few seconds end-to-end.

### Step 3 — `[DEPLOYER]` Upload the wrapper WASM

A Soroban `uploadContractWasm` op signed locally by the deployer key. The WASM hash returned by the network is cross-checked against the locally-computed sha256 to refuse a spoofed RPC-returned hash.

No Fireblocks TAP. The most resource-intensive step (WASM is ~27 KB; resource fee dominates).

### Step 4 — `[DEPLOYER]` Deploy the wrapper contract

A Soroban `createCustomContract` op signed locally by the deployer key. Instantiates the wrapper contract from the just-uploaded WASM hash, calling the wrapper's `__constructor(admin, minter, yieldRecipientManager, yieldRecipient, forcedTransferManager, blockOperator, unblockOperator, pauser)` to set all 8 internal role addresses atomically.

No Fireblocks TAP. The wrapper's roles are now in storage but the wrapper has no authority over the SAC yet — that's step 5.

### Step 5 — `[ISSUER]` Transfer SAC admin to the wrapper

A Soroban `SAC.set_admin(wrapper_contract)` op signed by the issuer Fireblocks vault. Hands the SAC's mint / clawback authority from the issuer over to the wrapper contract. Post-step, the issuer has no authority over the SAC layer — all token minting and burning flows through the wrapper.

One Fireblocks TAP. Few seconds end-to-end.

### Post-deploy — Smoke test + receipt

- **Smoke test:** invokes `wrapper.admin()` and verifies the return matches the configured `ADMIN_PUBLIC_KEY`. Catches constructor-arg ordering mistakes.
- **Receipt JSON** written to `./deploys/deploy-<timestamp>.json` with: source git commit + dirty flag, WASM hash, both signer pubkeys, role addresses, home_domain, final SAC + wrapper contract IDs, and whether the WASM came via an attested release (`wasm.attested`, `wasm.releaseTag`, `wasm.releaseRepo`).

## WASM source decision matrix

| Env config | Behavior |
|---|---|
| `RELEASE_TAG=v<version>` | Downloads WASM from the GitHub release. Runs `gh attestation verify` (Sigstore signature check) — refuses to deploy if attestation invalid. **Recommended for production.** |
| `WASM_PATH=...` + `ALLOW_UNATTESTED_WASM=1` | Uses a local build. Loud warning printed. No attestation check. Dev iteration only. |
| `WASM_PATH=...` alone | Hard error — forces explicit choice. |
| Neither set | Hard error. |
| Both `RELEASE_TAG` + `WASM_PATH` | `RELEASE_TAG` wins; `WASM_PATH` ignored with a notice. |

The existing `EXPECTED_WASM_SHA256` check runs **after** the resolver, so the operator-pinned hash gates both paths.

Optional `CROSS_VERIFY_LOCAL_BUILD=1`: when on the attested path, runs `stellar contract build` locally and refuses to deploy unless the freshly-built WASM matches the downloaded release byte-for-byte. Defense in depth; hard-errors if the Rust/Stellar toolchain is missing.

## Source verification chain

When the operator deploys via `RELEASE_TAG`, the resulting on-chain contract is end-to-end verifiable per [SEP-55](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0055.md):

1. Deployed WASM bytes have `source_repo=github:m0-foundation/mgusd-minter-gateway` baked into a `contractmetav0` custom section (set by the CI workflow's `stellar contract build --meta`)
2. Anyone reading the on-chain WASM via RPC sees that meta
3. They query GitHub's attestations endpoint for `sha256:<wasm_hash>` and get a Sigstore-signed attestation that links the bytes to a specific GH Action run + commit
4. They follow the commit link and read the actual source

Stellar Lab and stellar.expert surface this chain as a "Verified Build" badge. The CLI command `stellar contract info build --contract-id <id> --rpc-url ... --network-passphrase ...` walks the entire chain in one call.

## Producing the release (CI workflow)

Releases that the deploy script consumes via `RELEASE_TAG` come from [`.github/workflows/release-contract.yml`](../.github/workflows/release-contract.yml), triggered by either pushing a `v*` git tag or invoking `workflow_dispatch` manually. The workflow builds the WASM reproducibly with two `--meta` entries baked into the binary:

- `source_repo` — derived from `${{ github.repository }}`, always the canonical repo
- `home_domain` — **parameterized**, resolved in this precedence:
  1. `workflow_dispatch` input `home_domain` (one-off override)
  2. `vars.HOME_DOMAIN` (repo variable, set in GitHub → Settings → Secrets and variables → Actions → Variables)
  3. `"m0.org"` (fallback default)

Tag-push releases use the repo variable or the default. The resolved value is echoed into the published release-notes body so reviewers can see what was baked in without inspecting the WASM.

**Important distinction from the asset's home_domain:** the WASM-embedded `home_domain` identifies the **builder organization** (Stellar Lab follows it to the org's stellar.toml). The per-asset `home_domain` set by step 1 of the deploy is **separate** — that one lives on the issuer Stellar account and is what wallets follow for SEP-1 asset metadata. The two values can be the same or different; they serve different purposes.

## Preflight checklist (operator)

Before running `npm run deploy`:

- [ ] Fresh Fireblocks vault on the target network workspace, funded with ≥`ISSUER_MIN_XLM` XLM, signing policy + designated approvers configured
- [ ] Fresh deployer keypair (`stellar keys generate`), corresponding G-pubkey funded with ≥`DEPLOYER_MIN_XLM` XLM
- [ ] 8 distinct role pubkeys decided (collapsing roles onto one key is permitted but flagged with a warning — see [STEL1-5 audit])
- [ ] WASM source decided (`RELEASE_TAG` for production, `WASM_PATH + ALLOW_UNATTESTED_WASM=1` for dev)
- [ ] `EXPECTED_WASM_SHA256` pinned to the exact bytes to be deployed
- [ ] `HOME_DOMAIN` resolved (the deploy sets this on the issuer Stellar account; wallets follow it for SEP-1 metadata)
- [ ] `gh auth status` clean (deploy downloads from GH release on the attested path)
- [ ] Network env vars (`SOROBAN_RPC_URL`, `HORIZON_URL`, `SOROBAN_NETWORK_PASSPHRASE`, `FIREBLOCKS_ASSET_ID`, `FIREBLOCKS_BASE_PATH`) match the target network

## Common failure modes

| Symptom | Likely cause | Remediation |
|---|---|---|
| `SubmissionError: tx X not confirmed after 60 polls` on a Soroban step | RPC silently dropped the tx (returned `PENDING` but didn't propagate). Most often on third-party RPC providers under Soroban surge. | Swap `SOROBAN_RPC_URL` to the official `https://mainnet.sorobanrpc.com` (or testnet equivalent). The lookup URL printed in the error is the fastest diagnostic. |
| `Refusing to deploy unverified bytes: attestation verification failed` | Downloaded WASM doesn't match the release's Sigstore attestation, OR the operator's `gh` CLI is unauthenticated, OR `RELEASE_REPO` points at the wrong repo. | Run `gh attestation verify <wasm> --repo <repo>` manually to isolate the failure. |
| `Issuer X already has account flags set: [...]` | The configured issuer was previously used (either in a partial deploy that completed step 1, or for some other purpose). Pipeline refuses to proceed against a contaminated issuer. | Provision a fresh Fireblocks vault. The previous one's XLM stays where it is — sweep later or leave. |
| `WASM hash mismatch` | The downloaded/local WASM sha256 doesn't match `EXPECTED_WASM_SHA256`. | Either the operator typed the wrong hash, or the source has drifted. Recompute with `sha256sum`, or rebuild via `make build` from the expected commit. |
| Fireblocks signing hangs past `--poll-budget 600s` | Designated signers haven't approved the TAP. | Approve in the Fireblocks app, or check the vault's signing policy. |

## Renouncing the issuer post-deploy

Once the deploy is validated, permanently seal the issuer with the Fireblocks-signed
renounce script:

```bash
cd soroban-fireblocks-sdk
npm run renounce-issuer -- --dry-run   # review the renounce XDR first
npm run renounce-issuer -- --execute   # IRREVERSIBLE: issuer vault signs + submits
```

See [`docs/issuer-renunciation.md`](issuer-renunciation.md) for what renouncing means, the
compliance trade-off, and the Fireblocks-specific notes.

## Source files

- Orchestrator: [`soroban-fireblocks-sdk/scripts/deploy-full.ts`](../soroban-fireblocks-sdk/scripts/deploy-full.ts)
- Attestation helpers: [`soroban-fireblocks-sdk/scripts/lib/attestation.ts`](../soroban-fireblocks-sdk/scripts/lib/attestation.ts)
- Receipt schema: [`soroban-fireblocks-sdk/scripts/lib/deploy-receipt.ts`](../soroban-fireblocks-sdk/scripts/lib/deploy-receipt.ts)
- Preflights: [`soroban-fireblocks-sdk/src/deploy-checks.ts`](../soroban-fireblocks-sdk/src/deploy-checks.ts)
- Bash equivalent (for parity reference): [`scripts/deploy-pipeline.sh`](../scripts/deploy-pipeline.sh)

[STEL1-5 audit]: ../soroban-fireblocks-sdk/tests/unit/deploy-full-script.test.ts
