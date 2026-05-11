#!/usr/bin/env bash
# Predict the wrapper contract ID for a given deployer + salt without deploying.
#
# On Stellar the contract ID is derived from (deployer, salt, network) — the
# WASM hash is NOT part of the ID.
#
# Required env vars:
#   DEPLOYER_IDENTITY  — stellar identity (or public key) of the deployer account
#   SALT               — 32-byte hex salt (64 hex chars), e.g. 0000...0001
#
# Optional env vars:
#   WASM_PATH          — path to the compiled .wasm file (prints sha256 alongside the contract ID)
#   NETWORK            — testnet | mainnet | futurenet (default: testnet)

set -euo pipefail

NETWORK="${NETWORK:-testnet}"

for var in DEPLOYER_IDENTITY SALT; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is required" >&2
    exit 1
  fi
done

if [ "${#SALT}" -ne 64 ]; then
  echo "ERROR: SALT must be a 64-character hex string (32 bytes)" >&2
  exit 1
fi

WASM_HASH=""
if [ -n "${WASM_PATH:-}" ]; then
  if [ ! -f "$WASM_PATH" ]; then
    echo "ERROR: WASM_PATH file not found: $WASM_PATH" >&2
    exit 1
  fi
  WASM_HASH=$(sha256sum "$WASM_PATH" | awk '{print $1}')
fi

CONTRACT_ID=$(stellar contract id wasm \
  --source-account "$DEPLOYER_IDENTITY" \
  --salt "$SALT" \
  --network "$NETWORK")

echo "Deployer: $(stellar keys address "$DEPLOYER_IDENTITY" 2>/dev/null || echo "$DEPLOYER_IDENTITY")"
echo "Salt:     $SALT"
echo "Network:  $NETWORK"
if [ -n "$WASM_HASH" ]; then
  echo "WASM:     $WASM_PATH"
  echo "WASM hash (sha256): $WASM_HASH"
fi
echo ""
echo "Predicted contract ID: $CONTRACT_ID"
