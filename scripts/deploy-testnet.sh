#!/usr/bin/env bash
#
# deploy-testnet.sh
#
# 5-step deploy pipeline for the Stellar Minter Gateway contract. Targets
# testnet/dev by default but the structure (two distinct signing identities)
# matches what a Fireblocks / hardware-wallet production ceremony would look
# like — point ISSUER_KEY_NAME at a cold-key identity for prod.
#
# =============================================================================
# SIGNING MODEL — two identities
# =============================================================================
#
#   ISSUER (cold)
#     The asset issuer's Stellar account. Production custody for this key is
#     typically Fireblocks MPC, a Ledger, or another out-of-band signer.
#     Signs ONLY the two steps that require issuer authority:
#       - Step 1: set_options on the issuer account
#       - Step 5: set_admin on the SAC (the issuer is initial SAC admin)
#
#   DEPLOYER (warm)
#     A funded operational keypair. Has no privileged relationship to the
#     asset — only pays fees and signs the protocol-permissionless deploy
#     ops. A throwaway keypair is fine; it gains no power over the resulting
#     contract (the wrapper's __constructor takes role addresses explicitly).
#     Signs:
#       - Step 2: SAC deploy for the asset
#       - Step 3: WASM upload
#       - Step 4: wrapper contract deploy + init
#
# For testnet / dev, you can reuse the deployer identity as issuer by
# pointing ISSUER_KEY_NAME and DEPLOYER_KEY_NAME at the same `stellar keys`
# identity. For mainnet, they should be distinct, and ISSUER_KEY_NAME
# should resolve to a cold-key signer.
#
# =============================================================================
# ORDER OF OPERATIONS (per address)
# =============================================================================
#
#   ISSUER     ──────────[1]──────────────────────────[5]──────
#   DEPLOYER   ─────────────[2]──[3]──[4]─────────────────[smoke]
#
#   1. [ISSUER]    set_options(AUTH_REQUIRED + REVOCABLE + CLAWBACK_ENABLED)
#   2. [DEPLOYER]  stellar contract asset deploy --asset CODE:ISSUER
#   3. [DEPLOYER]  stellar contract upload --wasm <wrapper.wasm>
#   4. [DEPLOYER]  stellar contract deploy --wasm-hash <hash>  + __constructor
#   5. [ISSUER]    SAC.set_admin(wrapper)
#   6. [DEPLOYER]  smoke: read wrapper.admin() — verifies the handoff landed
#
# Note: this pipeline mints ZERO tokens. Token supply is created later by
# the bridge / minter role calling `wrapper.mint(minter, to, amount)` after
# this script completes. This script only stands up the infrastructure.
#
# =============================================================================
# PREREQUISITES (out-of-band, NOT done by this script)
# =============================================================================
#
#   - ISSUER account must exist on the network and be funded with XLM.
#       Testnet: curl "https://friendbot.stellar.org?addr=$ISSUER_PUBLIC_KEY"
#       Mainnet: one-time treasury transfer (handled by ops, not this script)
#   - DEPLOYER account must exist on the network and be funded.
#   - Wrapper WASM must be built (`make build` from repo root).
#   - The asset (CODE, ISSUER) must NOT already have any holders, pre-set
#     issuer flags, or trustlines. This is an audit safety property
#     (STEL1-6: deploying onto a "dirty" issuer can bypass AUTH_REQUIRED).
#     This script does NOT verify the issuer is clean — verify manually
#     before mainnet deploy.
#
# =============================================================================
# REQUIRED ENV VARS
# =============================================================================
#
#   Signing identities (`stellar keys` identity NAMES, not pubkeys):
#     ISSUER_KEY_NAME               — identity that controls the issuer account
#     DEPLOYER_KEY_NAME             — identity for the deployer; pays fees on 2,3,4
#                                     (may equal ISSUER_KEY_NAME for testnet/dev)
#
#   Issuer account public key (G...):
#     ISSUER_PUBLIC_KEY             — must be the pubkey behind ISSUER_KEY_NAME
#
#   Wrapper role pubkeys (G...):  (STEL1-5: each role gets its own env var)
#     ADMIN_PUBLIC_KEY                       — top-level authority (M0)
#     MINTER_PUBLIC_KEY                      — bridge / minter
#     YIELD_RECIPIENT_MANAGER_PUBLIC_KEY     — rotates yield recipient
#     YIELD_RECIPIENT_PUBLIC_KEY             — receives claim_yield mints
#     FORCED_TRANSFER_MANAGER_PUBLIC_KEY     — compliance forced transfers
#     BLOCK_OPERATOR_PUBLIC_KEY              — initial block operator
#     UNBLOCK_OPERATOR_PUBLIC_KEY            — initial unblock operator
#     PAUSER_PUBLIC_KEY                      — pauser of record
#
# =============================================================================
# OPTIONAL ENV VARS
# =============================================================================
#
#   ASSET_CODE         — defaults to TMGUSD
#   STELLAR_NETWORK    — defaults to testnet
#   WASM_PATH          — defaults to ./target/wasm32v1-none/release/mintergateway.wasm
#
# =============================================================================

set -euo pipefail

ASSET_CODE="${ASSET_CODE:-TMGUSD}"
STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
WASM_PATH="${WASM_PATH:-./target/wasm32v1-none/release/mintergateway.wasm}"

require_pubkey() {
  local name="$1"
  local val="${!name:-}"
  if [[ -z "$val" ]]; then
    echo "ERROR: missing required env var: $name" >&2
    exit 1
  fi
  if [[ ! "$val" =~ ^G[A-Z2-7]{55}$ ]]; then
    echo "ERROR: $name is not a valid Stellar pubkey: $val" >&2
    exit 1
  fi
  echo "$val"
}

require_var() {
  local name="$1"
  local val="${!name:-}"
  if [[ -z "$val" ]]; then
    echo "ERROR: missing required env var: $name" >&2
    exit 1
  fi
  echo "$val"
}

# Issuer-side
ISSUER=$(require_pubkey ISSUER_PUBLIC_KEY)
ISSUER_KEY=$(require_var ISSUER_KEY_NAME)

# Deployer-side
DEPLOYER_KEY=$(require_var DEPLOYER_KEY_NAME)

# Wrapper roles (STEL1-5: each role read independently)
ADMIN=$(require_pubkey ADMIN_PUBLIC_KEY)
MINTER=$(require_pubkey MINTER_PUBLIC_KEY)
YRM=$(require_pubkey YIELD_RECIPIENT_MANAGER_PUBLIC_KEY)
YR=$(require_pubkey YIELD_RECIPIENT_PUBLIC_KEY)
FTM=$(require_pubkey FORCED_TRANSFER_MANAGER_PUBLIC_KEY)
BLOCK_OP=$(require_pubkey BLOCK_OPERATOR_PUBLIC_KEY)
UNBLOCK_OP=$(require_pubkey UNBLOCK_OPERATOR_PUBLIC_KEY)
PAUSER=$(require_pubkey PAUSER_PUBLIC_KEY)

if [[ ! -f "$WASM_PATH" ]]; then
  echo "ERROR: WASM not found at $WASM_PATH — run 'make build' first" >&2
  exit 1
fi

echo "=== Stellar Minter Gateway — Deploy ==="
echo "  Network:                 $STELLAR_NETWORK"
echo "  Asset:                   $ASSET_CODE"
echo "  WASM:                    $WASM_PATH ($(wc -c < "$WASM_PATH") bytes)"
echo ""
echo "  Signing identities:"
echo "    ISSUER (steps 1,5):    $ISSUER_KEY  (pubkey: $ISSUER)"
echo "    DEPLOYER (steps 2-4):  $DEPLOYER_KEY"
if [[ "$ISSUER_KEY" == "$DEPLOYER_KEY" ]]; then
  echo "    NOTE: deployer == issuer (single-signer mode — testnet/dev only)"
fi
echo ""
echo "  Wrapper roles (passed to __constructor in step 4):"
echo "    admin:                 $ADMIN"
echo "    minter:                $MINTER"
echo "    yieldRecipientManager: $YRM"
echo "    yieldRecipient:        $YR"
echo "    forcedTransferManager: $FTM"
echo "    blockOperator:         $BLOCK_OP"
echo "    unblockOperator:       $UNBLOCK_OP"
echo "    pauser:                $PAUSER"
echo ""

UNIQUE_ROLES=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$ADMIN" "$MINTER" "$YRM" "$YR" "$FTM" "$BLOCK_OP" "$UNBLOCK_OP" "$PAUSER" \
  | sort -u | wc -l | tr -d ' ')
if [[ "$UNIQUE_ROLES" -lt 8 ]]; then
  echo "WARNING: multiple roles share the same pubkey — role separation is reduced ($UNIQUE_ROLES distinct)"
  echo ""
fi

# -----------------------------------------------------------------------------
# Step 1 — [ISSUER signs]
# Configure issuer flags. Must run BEFORE any trustline to (CODE,ISSUER)
# exists, otherwise that trustline auto-authorizes and falls outside the
# compliance model. The asset itself doesn't need to be "created" — it
# comes into existence implicitly when first referenced.
# -----------------------------------------------------------------------------
echo "[1/5] [ISSUER] set_options on issuer account..."
stellar tx new set-options \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --set-required \
  --set-revocable \
  --set-clawback-enabled
echo "      done."
echo ""

# -----------------------------------------------------------------------------
# Step 2 — [DEPLOYER signs]
# Deploy the SAC contract for (CODE, ISSUER). The SAC contract address is
# deterministically derived from the asset, so this op is permissionless —
# any funded account can run it. The SAC's initial admin is the issuer
# (transferred to the wrapper in step 5). No tokens are minted.
# -----------------------------------------------------------------------------
echo "[2/5] [DEPLOYER] Deploying SAC for $ASSET_CODE:$ISSUER..."
SAC_CONTRACT_ID=$(stellar contract asset deploy \
  --source-account "$DEPLOYER_KEY" \
  --network "$STELLAR_NETWORK" \
  --asset "$ASSET_CODE:$ISSUER" \
  | tr -d '\r\n')
echo "      SAC contract ID: $SAC_CONTRACT_ID"
echo ""

# -----------------------------------------------------------------------------
# Step 3 — [DEPLOYER signs]
# Upload the wrapper WASM bytecode to the ledger. Permissionless; deployer
# pays fees. This only registers the WASM by hash — it does not instantiate
# a contract.
# -----------------------------------------------------------------------------
echo "[3/5] [DEPLOYER] Uploading wrapper WASM..."
WASM_HASH=$(stellar contract upload \
  --source-account "$DEPLOYER_KEY" \
  --network "$STELLAR_NETWORK" \
  --wasm "$WASM_PATH" \
  | tr -d '\r\n')
echo "      WASM hash: $WASM_HASH"
echo ""

# -----------------------------------------------------------------------------
# Step 4 — [DEPLOYER signs]
# Deploy the wrapper contract from the uploaded WASM hash and run its
# __constructor with all 9 args (sac_token + 8 role addresses). The wrapper
# contract address is derived from (deployer, salt). The deployer gains NO
# privilege over the resulting contract — roles are set explicitly here.
# -----------------------------------------------------------------------------
echo "[4/5] [DEPLOYER] Deploying wrapper contract..."
WRAPPER_CONTRACT_ID=$(stellar contract deploy \
  --source-account "$DEPLOYER_KEY" \
  --network "$STELLAR_NETWORK" \
  --wasm-hash "$WASM_HASH" \
  -- \
  --sac_token "$SAC_CONTRACT_ID" \
  --admin "$ADMIN" \
  --minter "$MINTER" \
  --yield_recipient_manager "$YRM" \
  --yield_recipient "$YR" \
  --forced_transfer_manager "$FTM" \
  --block_operator "$BLOCK_OP" \
  --unblock_operator "$UNBLOCK_OP" \
  --pauser "$PAUSER" \
  | tr -d '\r\n')
echo "      Wrapper contract ID: $WRAPPER_CONTRACT_ID"
echo ""

# -----------------------------------------------------------------------------
# Step 5 — [ISSUER signs]
# Hand SAC admin from issuer to wrapper. After this, the wrapper is the
# only address that can call mint / burn / clawback / set_authorized on the
# SAC. The issuer key is no longer the SAC admin — but it remains the
# classic-Stellar account that can sign SetTrustLineFlags / Clawback ops
# directly on classic trustlines (used for hard-freeze compliance flows).
# -----------------------------------------------------------------------------
echo "[5/5] [ISSUER] Transferring SAC admin to wrapper..."
stellar contract invoke \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --id "$SAC_CONTRACT_ID" \
  -- \
  set_admin --new_admin "$WRAPPER_CONTRACT_ID"
echo "      done."
echo ""

# -----------------------------------------------------------------------------
# Smoke test — [DEPLOYER signs]
# Read wrapper.admin() back. Read-only — any signer works; deployer is
# convenient since it's already configured. Fails closed if the constructor
# didn't land or if the wrong wrapper address was returned.
# -----------------------------------------------------------------------------
echo "[smoke] [DEPLOYER] Querying wrapper.admin()..."
ADMIN_FROM_CONTRACT=$(stellar contract invoke \
  --source-account "$DEPLOYER_KEY" \
  --network "$STELLAR_NETWORK" \
  --send=no \
  --id "$WRAPPER_CONTRACT_ID" \
  -- \
  admin \
  | tr -d '\r\n"')
echo "      admin() = $ADMIN_FROM_CONTRACT"
if [[ "$ADMIN_FROM_CONTRACT" != "$ADMIN" ]]; then
  echo "ERROR: smoke test failed — wrapper.admin() ($ADMIN_FROM_CONTRACT) != configured ADMIN ($ADMIN)" >&2
  exit 1
fi
echo ""

echo "=== Deploy Complete ==="
echo "  SAC Contract ID:     $SAC_CONTRACT_ID"
echo "  WASM Hash:           $WASM_HASH"
echo "  Wrapper Contract ID: $WRAPPER_CONTRACT_ID"
echo ""
echo "  Next: bridge / minter calls wrapper.mint(...) to issue tokens."
