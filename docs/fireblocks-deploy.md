# Fireblocks Deploy — Operator's One-Pager

A focused explainer of how the TS pipeline at [`scripts/deploy/`](../scripts/deploy/) signs deploys through Fireblocks. Read this before running `deploy:execute` against mainnet.

## Mental model

You never hold the Stellar private key for the issuer account. Fireblocks does, via MPC, and the key never leaves their custody. What you have is a Fireblocks API user (a separate identity, with its own RSA keypair) authorized to *ask* Fireblocks to sign things on behalf of a specific vault. Our deploy script asks Fireblocks to sign 5 transaction hashes; Fireblocks returns 5 Ed25519 signatures; we attach those signatures to the transactions and submit to Stellar.

There are **two distinct keypairs** in play. Don't conflate them.

| Keypair | Algorithm | Where it lives | What it's for |
|---|---|---|---|
| **API auth keypair** | RSA-4096 | Private PEM on your laptop, public PEM uploaded to Fireblocks | Authenticates *you* to the Fireblocks API. Signs JWTs on every request. |
| **Stellar issuer key** | Ed25519 | Inside Fireblocks MPC vault — held as MPC shares across cosigners; the whole key never exists | Signs Stellar transactions. We never touch it directly. |

## What's secret, what isn't

| Thing | Sensitivity | Notes |
|---|---|---|
| `fireblocks-secret.pem` | **🔴 Secret** | Anyone with this + the API key UUID can submit signing requests as your API user. Vault approval policy is your last line of defense after this leaks. |
| `fireblocks-public.pem` | 🟢 Public | You literally paste this into the Fireblocks UI. Same security level as a TLS public cert. |
| `FIREBLOCKS_API_KEY` (UUID) | 🟡 Sensitive | Identifier, not a secret on its own. Powerful only when combined with the matching private PEM. Treat like an API token. |
| `FIREBLOCKS_VAULT_ACCOUNT_ID` (e.g., `3`) | 🟢 Public | Just a number. Useless without API access to the workspace. |
| `ISSUER_PUBLIC_KEY` (G…) | 🟢 Public | It's the deposit address. Lives on Stellar, queryable by anyone. |
| 8 wrapper role pubkeys (G…) | 🟢 Public | Constructor args; they end up on-chain in instance storage. |
| The actual Ed25519 issuer private key | **🔴 Secret** | Fireblocks's problem, not yours. MPC means even FB can't reconstruct it; signing requires a quorum of cosigners. |
| `.env` (filled in) | 🟡 Sensitive | Gitignored. Contains the API key UUID + path to the PEM. Don't commit, don't paste in chat. |

**Practical implication.** The single highest-value file on your laptop is `fireblocks-secret.pem`. If your laptop is compromised: rotate the API user (revoke in FB UI, regenerate keypair, upload new public). The Stellar issuer key is unaffected.

## How to get the PEM

There is no Fireblocks page that hands you a PEM file. *You* generate it; Fireblocks only ever sees the public half (wrapped in a CSR — Certificate Signing Request — that also carries some org metadata). Three scenarios, in decreasing order of "you're starting fresh":

**1. Provisioning a brand-new API user.** Generate keypair + CSR locally with one openssl command (the [Fireblocks-recommended flow](https://developers.fireblocks.com/docs/generate-a-csr-for-an-api-user)):

```bash
cd scripts/deploy
openssl req -new -newkey rsa:4096 -nodes \
  -keyout fireblocks-secret.pem \
  -out fireblocks.csr \
  -subj '/O=m0-foundation'
chmod 600 fireblocks-secret.pem
```

This creates `fireblocks-secret.pem` (private — stays local) and `fireblocks.csr` (carries the public key — uploadable). Then either:

- **UI path:** Fireblocks Console → Developer Center → API users → "Add API user", select role, **upload the `fireblocks.csr` file** (not the private key). Fireblocks issues an API user UUID — that's `FIREBLOCKS_API_KEY` in `.env`.
- **API path:** workspace admin can call `POST /v1/management/api_users` ([Create API Key](https://developers.fireblocks.com/reference/createapiuser)) with `{ role, csrPem: "<contents of fireblocks.csr>" }`. The call creates an *approval request*, not the user itself — the workspace owner approves, and only then is the API user UUID available. Plan for a human-in-the-loop step even on the API path.

The private `fireblocks-secret.pem` stays on your laptop; `FIREBLOCKS_SECRET_PATH` points at it. Never check it in — `scripts/deploy/.gitignore` covers `fireblocks-secret*`, but verify with `git status` before any commit.

**2. The API user already exists and someone on your team has the PEM.** Get the matching private PEM from them through a secure channel (1Password, encrypted handoff). Save it locally and point `FIREBLOCKS_SECRET_PATH` at it. Skip the openssl + upload steps entirely. *This is what we did for this repo's existing sandbox API user.*

**3. The API user exists but the PEM is lost.** You can't recover it — Fireblocks only stored the public half. The lighter path is **rotating the public key on the existing API user** via Console (Developer Center → API users → the user → upload new public key). Same UUID, same role, same TAP rules — only the PEM swap. Generate a fresh keypair as in scenario 1 and upload the new public half. Full deletion + re-provisioning is only required if the API user identity itself needs to be retired. Plan brief downtime either way — tooling pointing at the old PEM stops working the moment the FB swap happens.

**Storage hygiene.**
- Always `chmod 600` the private PEM.
- Don't store under `~/Downloads` long-term; move to a stable location (e.g. `~/secrets/fireblocks-<workspace>.pem`).
- Production prod-workspace PEMs should live in your team password manager (1Password vault item with attached file), not on individual laptops.
- Rotation policy: rotate at least when an API user owner leaves the team, or annually as hygiene.

## The 5-step deploy

Canonical step list lives in [`scripts/deploy/README.md`](../scripts/deploy/README.md#what-it-does). The trust-relevant invariants:

- Each step is built locally → simulated against Soroban RPC (steps 2-5 only) → tx hash sent to Fireblocks for signing → signature attached to envelope → submitted to Stellar. Step 1 skips simulation because it's a classic Stellar op.
- All 5 signed steps are signed by the **same Fireblocks vault** (the issuer). Vault policy (e.g., 2-of-3 cosigner approval) gates each signing request — that's where multi-party control lives, not in our script.
- The deploy is **not fully idempotent.** If a step fails between submission and confirmation, recovery depends on which step partially landed: Step 1 (`set_options`) re-runs safely; Step 2/3 collisions need a fresh `ASSET_CODE` or fresh issuer; Step 5 (SAC admin handoff) needs a `SAC.admin()` check before re-running, since the role may already be on the wrapper. When in doubt, query on-chain state before retrying.

## Trust boundaries

| Boundary | How it talks | What a leak exposes |
|---|---|---|
| Your laptop → Fireblocks | RSA-signed JWT (PEM auth) | API access only — cannot bypass vault approval policy |
| Fireblocks → Stellar | MPC-produced Ed25519 signature | Nothing — vault key is held as MPC shares, never exists whole |
| Stellar (public chain) | n/a | All data here is public anyway |

## Mainnet vs testnet — the only diffs

```diff
-STELLAR_NETWORK=testnet
+STELLAR_NETWORK=public                # triggers interactive passphrase confirm on --execute
-FIREBLOCKS_API_KEY=<sandbox UUID>
+FIREBLOCKS_API_KEY=<production UUID>
-FIREBLOCKS_VAULT_ACCOUNT_ID=<sandbox vault id>
+FIREBLOCKS_VAULT_ACCOUNT_ID=<production vault id>
-FIREBLOCKS_BASE_PATH=sandbox
+FIREBLOCKS_BASE_PATH=us               # or eu / eu2 — wherever your prod workspace lives
-FIREBLOCKS_ASSET_ID=XLM_TEST
+FIREBLOCKS_ASSET_ID=XLM
-ISSUER_PUBLIC_KEY=<sandbox vault wallet pubkey>
+ISSUER_PUBLIC_KEY=<production vault wallet pubkey>
```

Plus the 8 role pubkeys point at production addresses (real M0 admin, real bridge minter, real MoneyGram yield recipient, etc.). The contract code path is identical.

## Pre-flight checklist

**Universal:**

- [ ] `make build` succeeded; WASM at `target/wasm32v1-none/release/mintergateway.wasm`
- [ ] `npm run deploy:dry-run -- --network=<net>` prints clean XDR for steps 1-3
- [ ] Fireblocks API user's public key matches `fireblocks-secret.pem` on disk (test with a read-only call — e.g. list vault accounts — instead of a signing request, so you don't burn an approver's attention)
- [ ] Vault wallet has enough XLM (≥ 10 XLM testnet, mainnet sized for fees + storage rent)
- [ ] Vault approval policy mirrors what you intend (sandbox: 1-of-1 fine; mainnet: as configured)
- [ ] All approvers are reachable and ready to approve

**Additional for mainnet:**

- [ ] You've eyeballed the dry-run XDR for the 3 buildable steps and it matches expectations
- [ ] Issuer pubkey is freshly generated, no prior trustlines (Step 0 will catch this anyway, but verify out-of-band)

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `401 invalid signature` | One of: (a) public PEM in FB doesn't match local private PEM, (b) laptop clock skewed >30s (Fireblocks JWT expires ~30s after issue), (c) `FIREBLOCKS_BASE_PATH` points at a different region than the API user lives in | (a) upload matching public PEM or fix `FIREBLOCKS_SECRET_PATH`; (b) `sudo sntp -sS time.apple.com` or equivalent; (c) set `FIREBLOCKS_BASE_PATH` to the correct region |
| `Fireblocks transaction not completed after N polls` | Approver(s) didn't approve in time | Bump `FIREBLOCKS_POLL_TIMEOUT_SECONDS` (default 600s); rerun |
| `IssuerContaminatedError` at Step 0 | Issuer has prior on-chain footprint | Provision a fresh issuer (new Fireblocks vault wallet) — there is no on-chain mitigation |
| `SimulationError: Storage, ExistingValue` at Step 2 | SAC for `(ASSET_CODE, ISSUER)` already exists | Bump `ASSET_CODE` (e.g. `TMGUSD2`) or use a fresh issuer |
| `WasmHashMismatchError` at Step 3 | RPC returned a different hash than local sha256 | Switch RPCs (compromise or wrong endpoint) |

## Post-deploy verification

```bash
# Wrapper admin should equal the configured ADMIN_PUBLIC_KEY
stellar contract invoke --send=no --network <net> --source-account <any-funded-acct> \
  --id <wrapper-contract-id> -- admin

# SAC admin should equal the wrapper (Step 5 handoff)
stellar contract invoke --send=no --network <net> --source-account <any-funded-acct> \
  --id <sac-contract-id> -- admin
```

Then record the deployed artifacts (SAC id, WASM hash, wrapper id) in `memory/testnet_deployments.md` or your equivalent.
