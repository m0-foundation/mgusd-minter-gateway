#!/usr/bin/env bash
#
# deploy-testnet.sh
#
# Testnet/dev deploy pipeline for the Stellar Minter Gateway contract.
# Mirrors the 5-step Fireblocks SDK pipeline using the `stellar` CLI and
# local `stellar keys` identities. NOT for production — Fireblocks-custodied
# production deploys live on the `sdk-integration` branch.
#
# Pipeline:
#   1. Configure issuer (AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED)
#   2. Deploy SAC for the asset
#   3. Upload wrapper WASM
#   4. Deploy wrapper contract with all 8 role addresses + SAC
#   5. Transfer SAC admin to wrapper
#   6. Smoke-test: query the wrapper's admin() view
#
# Prerequisites:
#   - `stellar` CLI installed and in PATH (>= 22.0)
#   - Wrapper WASM built (`make build`)
#   - All required keys exist as `stellar keys` identities OR pubkeys are set
#     via env vars below
#
# Required env vars (Stellar G... pubkeys):
#   ISSUER_PUBLIC_KEY                       — asset issuer / SAC initial admin
#   ADMIN_PUBLIC_KEY                        — top-level authority (M0)
#   MINTER_PUBLIC_KEY                       — bridge / minter
#   YIELD_RECIPIENT_MANAGER_PUBLIC_KEY      — rotates yield recipient (M0)
#   YIELD_RECIPIENT_PUBLIC_KEY              — receives claim_yield mints
#   FORCED_TRANSFER_MANAGER_PUBLIC_KEY      — compliance forced transfers
#   BLOCK_OPERATOR_PUBLIC_KEY               — initial block operator
#   UNBLOCK_OPERATOR_PUBLIC_KEY             — initial unblock operator
#   PAUSER_PUBLIC_KEY                       — pauser of record
#
#   ISSUER_KEY_NAME                         — name of `stellar keys` identity for the issuer
#                                             (used as --source-account on signing ops)
#
# Optional env vars:
#   ASSET_CODE         — defaults to TMGUSD
#   STELLAR_NETWORK    — defaults to testnet
#   WASM_PATH          — defaults to ./target/wasm32v1-none/release/mintergateway.wasm
#
# STEL1-5 NOTE: every privileged role is read from its own env var. There is
# intentionally no "dev mode" that collapses roles. For local single-signer
# testing, set every role var to the same value explicitly.

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

ISSUER=$(require_pubkey ISSUER_PUBLIC_KEY)
ADMIN=$(require_pubkey ADMIN_PUBLIC_KEY)
MINTER=$(require_pubkey MINTER_PUBLIC_KEY)
YRM=$(require_pubkey YIELD_RECIPIENT_MANAGER_PUBLIC_KEY)
YR=$(require_pubkey YIELD_RECIPIENT_PUBLIC_KEY)
FTM=$(require_pubkey FORCED_TRANSFER_MANAGER_PUBLIC_KEY)
BLOCK_OP=$(require_pubkey BLOCK_OPERATOR_PUBLIC_KEY)
UNBLOCK_OP=$(require_pubkey UNBLOCK_OPERATOR_PUBLIC_KEY)
PAUSER=$(require_pubkey PAUSER_PUBLIC_KEY)
ISSUER_KEY=$(require_var ISSUER_KEY_NAME)

if [[ ! -f "$WASM_PATH" ]]; then
  echo "ERROR: WASM not found at $WASM_PATH — run 'make build' first" >&2
  exit 1
fi

echo "=== Stellar Minter Gateway — Testnet Deploy ==="
echo "  Network:                  $STELLAR_NETWORK"
echo "  Asset:                    $ASSET_CODE"
echo "  Issuer:                   $ISSUER"
echo "  Issuer signing identity:  $ISSUER_KEY"
echo "  WASM:                     $WASM_PATH ($(wc -c < "$WASM_PATH") bytes)"
echo ""
echo "  Roles:"
echo "    admin:                  $ADMIN"
echo "    minter:                 $MINTER"
echo "    yieldRecipientManager:  $YRM"
echo "    yieldRecipient:         $YR"
echo "    forcedTransferManager:  $FTM"
echo "    blockOperator:          $BLOCK_OP"
echo "    unblockOperator:        $UNBLOCK_OP"
echo "    pauser:                 $PAUSER"
echo ""

UNIQUE_ROLES=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$ADMIN" "$MINTER" "$YRM" "$YR" "$FTM" "$BLOCK_OP" "$UNBLOCK_OP" "$PAUSER" \
  | sort -u | wc -l | tr -d ' ')
if [[ "$UNIQUE_ROLES" -lt 8 ]]; then
  echo "WARNING: multiple roles share the same pubkey — role separation is reduced ($UNIQUE_ROLES distinct)"
  echo ""
fi

# -----------------------------------------------------------------------------
# Step 1: Configure issuer flags (AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK)
# -----------------------------------------------------------------------------
echo "[1/5] Configuring issuer flags..."
stellar tx new set-options \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --set-required \
  --set-revocable \
  --set-clawback-enabled
echo "      done."
echo ""

# -----------------------------------------------------------------------------
# Step 2: Deploy SAC for the asset
# -----------------------------------------------------------------------------
echo "[2/5] Deploying SAC for $ASSET_CODE:$ISSUER..."
SAC_CONTRACT_ID=$(stellar contract asset deploy \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --asset "$ASSET_CODE:$ISSUER" \
  | tr -d '\r\n')
echo "      SAC contract ID: $SAC_CONTRACT_ID"
echo ""

# -----------------------------------------------------------------------------
# Step 3: Upload wrapper WASM
# -----------------------------------------------------------------------------
echo "[3/5] Uploading wrapper WASM..."
WASM_HASH=$(stellar contract upload \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --wasm "$WASM_PATH" \
  | tr -d '\r\n')
echo "      WASM hash: $WASM_HASH"
echo ""

# -----------------------------------------------------------------------------
# Step 4: Deploy wrapper contract with all role addresses
# -----------------------------------------------------------------------------
echo "[4/5] Deploying wrapper contract..."
WRAPPER_CONTRACT_ID=$(stellar contract deploy \
  --source-account "$ISSUER_KEY" \
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
# Step 5: Transfer SAC admin to wrapper
# -----------------------------------------------------------------------------
echo "[5/5] Transferring SAC admin to wrapper..."
stellar contract invoke \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --id "$SAC_CONTRACT_ID" \
  -- \
  set_admin --new_admin "$WRAPPER_CONTRACT_ID"
echo "      done."
echo ""

# -----------------------------------------------------------------------------
# Smoke test: read admin() back from wrapper
# -----------------------------------------------------------------------------
echo "[smoke] Querying wrapper.admin()..."
ADMIN_FROM_CONTRACT=$(stellar contract invoke \
  --source-account "$ISSUER_KEY" \
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
