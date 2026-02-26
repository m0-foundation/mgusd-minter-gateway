#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# deploy-testnet.sh — Deploy SacAdminContract & transfer SAC admin
#
# Usage:
#   ./deploy-testnet.sh <admin_identity> <sac_id> <issuer_identity>
#
# Or run interactively (will prompt for values).
# Run setup-asset.sh first to create the asset + SAC.
# ============================================================

NETWORK="testnet"
WASM="target/wasm32v1-none/release/soroban_sctoken_example_contract.wasm"

echo "=== SAC Admin Contract — Testnet Deploy ==="
echo ""

# --- 1. Collect identities and SAC address ---
if [ -n "${1:-}" ] && [ -n "${2:-}" ] && [ -n "${3:-}" ]; then
  ADMIN_IDENTITY="$1"
  SAC_ID="$2"
  ISSUER_IDENTITY="$3"
else
  echo "Available identities:"
  stellar keys ls 2>/dev/null || true
  echo ""
  read -rp "Admin identity (controls mint):  " ADMIN_IDENTITY
  read -rp "SAC contract address:            " SAC_ID
  read -rp "Issuer identity (current SAC admin): " ISSUER_IDENTITY
fi

ADMIN_ADDR=$(stellar keys address "$ADMIN_IDENTITY")
ISSUER_ADDR=$(stellar keys address "$ISSUER_IDENTITY")

echo "Admin:   $ADMIN_ADDR"
echo "Issuer:  $ISSUER_ADDR"
echo "SAC ID:  $SAC_ID"
echo ""

# --- 2. Build WASM if needed ---
if [ ! -f "$WASM" ]; then
  echo "Building contract..."
  stellar contract build
  echo ""
fi

# --- 3. Deploy the SacAdminContract ---
echo "Deploying SacAdminContract..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ADMIN_IDENTITY" \
  --network "$NETWORK" \
  -- \
  --sac_token "$SAC_ID" \
  --admin "$ADMIN_ADDR")

echo "Contract ID: $CONTRACT_ID"
echo ""

# --- 4. Transfer SAC admin from issuer → contract ---
echo "Transferring SAC admin to contract..."
stellar contract invoke \
  --id "$SAC_ID" \
  --source "$ISSUER_IDENTITY" \
  --network "$NETWORK" \
  -- set_admin \
  --new_admin "$CONTRACT_ID"

echo ""
echo "=== Deploy Complete ==="
echo "Contract ID:   $CONTRACT_ID"
echo "SAC ID:        $SAC_ID"
echo "Admin:         $ADMIN_ADDR"
echo "SAC admin now: $CONTRACT_ID (the contract)"
echo ""
echo "Contract ready. Example invocations:"
echo ""
echo "  # Mint"
echo "  stellar contract invoke --id $CONTRACT_ID --source $ADMIN_IDENTITY --network $NETWORK -- mint --to <RECIPIENT> --amount 1000"
echo ""
echo "  # Burn"
echo "  stellar contract invoke --id $CONTRACT_ID --source <HOLDER_IDENTITY> --network $NETWORK -- burn --from <HOLDER_ADDR> --amount 500"
echo ""
echo "  # Query admin"
echo "  stellar contract invoke --id $CONTRACT_ID --network $NETWORK -- admin"
