# Fireblocks Deploy Pipeline

Production-grade deploy pipeline for the Stellar Minter Gateway contract. Signs every step through a Fireblocks vault — works for both testnet and mainnet by changing one env var (`STELLAR_NETWORK`).

For local dev (no Fireblocks, just `stellar keys` identities), use the bash script at [`../deploy-testnet.sh`](../deploy-testnet.sh) instead. Both paths share the same [`scripts/deploy.env.example`](../deploy.env.example) template and the same `.env` at the repo root — populate only the section(s) you need.

## What it does

Five-step pipeline, all signed by the issuer Fireblocks vault:

1. **Configure issuer** — `set_options(AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED)` on the issuer account
2. **Deploy SAC** — Stellar Asset Contract for `(ASSET_CODE, ISSUER_PUBLIC_KEY)`
3. **Upload WASM** — wrapper bytecode, with local sha256 verification
4. **Deploy wrapper** — `createCustomContract` with the constructor's 9 arguments (SAC + 8 role addresses)
5. **Transfer SAC admin** — `SAC.set_admin(wrapper)` so the wrapper becomes the only address that can mint/burn/clawback the SAC

A pre-step (Step 0) checks Horizon for any pre-existing trustlines on the asset and aborts if found.

## Quick start

```bash
# 1. Build the wrapper WASM (from repo root)
make build

# 2. Install deps (one-time)
cd scripts/deploy
npm install

# 3. Configure — single .env at the repo root, shared with the bash deploy
cd <repo-root>
cp scripts/deploy.env.example .env
$EDITOR .env                          # populate the Fireblocks section + role pubkeys

# 4. Dry run — prints XDR for buildable steps, never calls Fireblocks.
#    Does not require FIREBLOCKS_SECRET_PATH to point at a real file.
cd scripts/deploy
npm run deploy:dry-run

# 5. Execute — actually submits txs and waits for Fireblocks approval.
#    Reads the Fireblocks secret PEM at this point (lazy).
npm run deploy:execute
```

## Mainnet rehearsal recipe

The whole point of this pipeline: the same code path runs against testnet and mainnet. To rehearse a Fireblocks-signed mainnet deploy without burning real keys:

1. Set up a **dedicated testnet Fireblocks vault** that mirrors your production approval policy (e.g., 2-of-3 cosigners, same approver identities).
2. Use `STELLAR_NETWORK=testnet` and the testnet vault's API key/secret in `.env`.
3. Run `npm run deploy:dry-run` — verify XDR for all 5 steps prints cleanly, role pubkeys match.
4. Run `npm run deploy:execute` — exercises the **real** Fireblocks multi-approval flow against testnet. Approvers approve in Fireblocks UI exactly as they would on mainnet day.

Mainnet day = same `.env`, three diffs:

```diff
-STELLAR_NETWORK=testnet
+STELLAR_NETWORK=public
-FIREBLOCKS_API_KEY=<test workspace>
+FIREBLOCKS_API_KEY=<prod workspace>
-FIREBLOCKS_ASSET_ID=XLM_TEST
+FIREBLOCKS_ASSET_ID=XLM
```

When `STELLAR_NETWORK=public` and `--execute` is passed, the script will demand the network passphrase be typed back before submitting.

## Safety properties

| Where | What it does |
|---|---|
| CLI entry — env load | Refuses to start if any of the 8 role pubkeys is missing or malformed. No "collapse all roles to one signer" mode. |
| Step 0 (pre-deploy) | Queries Horizon for the `(asset_code, issuer)` pair; aborts if any trustlines, claimable balances, pools, or contract holders exist. Pre-flag trustlines are permanently unclawbackable. |
| Step 3 (uploadWasm) | Re-derives sha256(WASM) locally and refuses to proceed if the RPC returns a different hash. Defends against compromised RPCs. |

## CLI flags

```
--dry-run      (default) Build + simulate + print XDR for all 5 steps, never sign
--execute      Submit each step to Fireblocks and wait for terminal state
--network=     testnet | public — overrides STELLAR_NETWORK env var
```

If neither `--dry-run` nor `--execute` is passed, dry-run is assumed.

## Troubleshooting

- **"Fireblocks transaction not completed after N polls"** — bump `FIREBLOCKS_POLL_TIMEOUT_SECONDS` if your approvers take longer than the default 600s.
- **"IssuerContaminatedError"** — the issuer pubkey already has trustlines/balances on the network. Provision a fresh issuer keypair before deploy. There is no on-chain mitigation.
- **"WasmHashMismatchError"** — the RPC returned a different hash than your local WASM. Either RPC compromise or you're pointing at the wrong WASM file. Verify `WASM_PATH` and switch to a trusted RPC.
- **Simulation errors** — usually missing constructor args or wrong types. Run `npm run deploy:dry-run` and inspect the Step 4 simulation output.
