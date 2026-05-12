#!/usr/bin/env bash
#
# deploy-testnet.sh — 5-step deploy of the Stellar Minter Gateway.
# TESTNET / DEV ONLY. Reuses scripts/lib/deploy-pipeline.sh for the step bodies.
#
# Production no-Fireblocks deploy (with issuer renunciation):
#   scripts/deploy-renounce.sh + docs/issuer-renunciation.md
#
# Config: copy scripts/deploy.env.example to .env at repo root and fill in.
# Prereq: ISSUER + DEPLOYER funded; wrapper WASM built (`make build`);
# issuer must be clean (no pre-existing trustlines / flags) — not verified here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/deploy-pipeline.sh
source "$SCRIPT_DIR/lib/deploy-pipeline.sh"

init_deploy_pipeline_env
print_deploy_banner

step_1_issuer_set_options
step_2_deploy_sac
step_3_upload_wasm
step_4_deploy_wrapper
step_5_transfer_sac_admin
smoke_test_wrapper_admin

echo "=== Deploy Complete ==="
echo "  SAC Contract ID:     $SAC_CONTRACT_ID"
echo "  WASM Hash:           $WASM_HASH"
echo "  Wrapper Contract ID: $WRAPPER_CONTRACT_ID"
echo ""
echo "  Next: bridge / minter calls wrapper.mint(...) to issue tokens."
