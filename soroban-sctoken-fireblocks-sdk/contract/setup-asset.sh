#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# setup-asset.sh — Create a classic Stellar asset & deploy SAC
#
# This bypasses Fireblocks for local/testnet development.
# In production, the asset would be issued via Fireblocks
# Tokenization, and only the SAC deploy step is needed.
# ============================================================

NETWORK="testnet"
ASSET_CODE="${1:-TMGUSD}"

echo "=== Setup Stellar Asset + SAC ==="
echo "Asset code: $ASSET_CODE"
echo ""

# --- 1. Create issuer identity ---
ISSUER_NAME="${ASSET_CODE}_issuer"
if stellar keys address "$ISSUER_NAME" &>/dev/null; then
  echo "Issuer identity '$ISSUER_NAME' already exists."
else
  echo "Creating issuer identity '$ISSUER_NAME'..."
  stellar keys generate "$ISSUER_NAME" --network "$NETWORK"
fi
ISSUER_ADDR=$(stellar keys address "$ISSUER_NAME")
echo "Issuer: $ISSUER_ADDR"
echo ""

# --- 2. Create admin identity (will control the SacAdminContract) ---
ADMIN_NAME="${ASSET_CODE}_admin"
if stellar keys address "$ADMIN_NAME" &>/dev/null; then
  echo "Admin identity '$ADMIN_NAME' already exists."
else
  echo "Creating admin identity '$ADMIN_NAME'..."
  stellar keys generate "$ADMIN_NAME" --network "$NETWORK"
fi
ADMIN_ADDR=$(stellar keys address "$ADMIN_NAME")
echo "Admin:  $ADMIN_ADDR"
echo ""

# --- 3. Deploy SAC from the classic asset ---
echo "Deploying SAC for $ASSET_CODE:$ISSUER_ADDR ..."
SAC_ID=$(stellar contract asset deploy \
  --asset "$ASSET_CODE:$ISSUER_ADDR" \
  --source "$ISSUER_NAME" \
  --network "$NETWORK")

echo ""
echo "=== Asset Setup Complete ==="
echo "Asset:   $ASSET_CODE"
echo "Issuer:  $ISSUER_ADDR"
echo "Admin:   $ADMIN_ADDR"
echo "SAC ID:  $SAC_ID"
echo ""
echo "Save these for deploy-testnet.sh:"
echo "  export SAC_ID=$SAC_ID"
echo "  export ADMIN_IDENTITY=$ADMIN_NAME"
echo "  export ISSUER_IDENTITY=$ISSUER_NAME"
echo ""
echo "Next step:"
echo "  ./deploy-testnet.sh $ADMIN_NAME $SAC_ID $ISSUER_NAME"
