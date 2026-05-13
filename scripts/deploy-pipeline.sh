# shellcheck shell=bash
# scripts/deploy-pipeline.sh
#
# Shared 5-step deploy pipeline for the Stellar Minter Gateway. Sourced by
# scripts/deploy-testnet.sh and scripts/deploy-renounce.sh. See
# docs/issuer-renunciation.md for the renounce-side context.
#
# Signing model: ISSUER signs steps 1 + 5; DEPLOYER signs steps 2-4 and the
# read-only smoke probe. Both are `stellar keys` identity names.

# Refuse direct execution — sourced only.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "ERROR: deploy-pipeline.sh is a library; source it, do not execute." >&2
  exit 1
fi

horizon_url_for() {
  case "$1" in
    testnet)   echo "https://horizon-testnet.stellar.org" ;;
    public)    echo "https://horizon.stellar.org" ;;
    futurenet) echo "https://horizon-futurenet.stellar.org" ;;
    *) echo "ERROR: unsupported STELLAR_NETWORK=$1" >&2; return 1 ;;
  esac
}

passphrase_for() {
  case "$1" in
    testnet)   echo "Test SDF Network ; September 2015" ;;
    public)    echo "Public Global Stellar Network ; September 2015" ;;
    futurenet) echo "Test SDF Future Network ; October 2022" ;;
  esac
}

require_pubkey() {
  local name="$1"
  local val="${!name:-}"
  if [[ -z "$val" ]]; then
    echo "ERROR: missing required env var: $name" >&2; exit 1
  fi
  if [[ ! "$val" =~ ^G[A-Z2-7]{55}$ ]]; then
    echo "ERROR: $name is not a valid Stellar pubkey: $val" >&2; exit 1
  fi
  echo "$val"
}

require_var() {
  local name="$1"
  local val="${!name:-}"
  [[ -z "$val" ]] && { echo "ERROR: missing required env var: $name" >&2; exit 1; }
  echo "$val"
}

# Loads .env, validates env, sets shell vars (ISSUER, *_KEY, role pubkeys,
# HORIZON_URL, …). Pass --skip-wasm-check when steps 3-4 won't run.
init_deploy_pipeline_env() {
  local skip_wasm_check=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-wasm-check) skip_wasm_check=1 ;;
      *) echo "ERROR: init_deploy_pipeline_env: unknown flag $1" >&2; exit 1 ;;
    esac
    shift
  done

  local tool
  for tool in stellar curl jq awk; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: missing tool: $tool" >&2; exit 1; }
  done

  # Auto-load .env at repo root (resolved relative to this helper's location).
  local helper_dir repo_root
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$helper_dir/.." && pwd)"
  if [[ -f "$repo_root/.env" ]]; then
    echo "Loading $repo_root/.env"
    set -a
    # shellcheck disable=SC1091
    source "$repo_root/.env"
    set +a
  fi

  ASSET_CODE="${ASSET_CODE:-TMGUSD}"
  STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
  WASM_PATH="${WASM_PATH:-./target/wasm32v1-none/release/mintergateway.wasm}"

  ISSUER=$(require_pubkey ISSUER_PUBLIC_KEY)
  ISSUER_KEY=$(require_var ISSUER_KEY_NAME)
  DEPLOYER_KEY=$(require_var DEPLOYER_KEY_NAME)
  ADMIN=$(require_pubkey ADMIN_PUBLIC_KEY)
  MINTER=$(require_pubkey MINTER_PUBLIC_KEY)
  YRM=$(require_pubkey YIELD_RECIPIENT_MANAGER_PUBLIC_KEY)
  YR=$(require_pubkey YIELD_RECIPIENT_PUBLIC_KEY)
  FTM=$(require_pubkey FORCED_TRANSFER_MANAGER_PUBLIC_KEY)
  BLOCK_OP=$(require_pubkey BLOCK_OPERATOR_PUBLIC_KEY)
  UNBLOCK_OP=$(require_pubkey UNBLOCK_OPERATOR_PUBLIC_KEY)
  PAUSER=$(require_pubkey PAUSER_PUBLIC_KEY)

  if [[ "$skip_wasm_check" == "0" && ! -f "$WASM_PATH" ]]; then
    echo "ERROR: WASM not found at $WASM_PATH — run 'make build' first" >&2
    exit 1
  fi

  HORIZON_URL=$(horizon_url_for "$STELLAR_NETWORK")

  # ISSUER_KEY_NAME must resolve to ISSUER_PUBLIC_KEY. A mismatch would
  # silently deploy the SAC for one issuer and sign with another.
  local issuer_key_pubkey
  issuer_key_pubkey=$(stellar keys public-key "$ISSUER_KEY" 2>/dev/null | tr -d '\r\n' || true)
  if [[ -z "$issuer_key_pubkey" ]]; then
    echo "ERROR: \`stellar keys public-key $ISSUER_KEY\` returned no pubkey." >&2
    echo "       Verify the identity exists: \`stellar keys ls\`" >&2
    exit 1
  fi
  if [[ "$issuer_key_pubkey" != "$ISSUER" ]]; then
    echo "ERROR: ISSUER_PUBLIC_KEY ($ISSUER) does not match" >&2
    echo "       pubkey behind ISSUER_KEY_NAME ($issuer_key_pubkey)." >&2
    exit 1
  fi
}

print_deploy_banner() {
  local title="${1:-Stellar Minter Gateway — Deploy}"

  echo "=== $title ==="
  echo "  Network:                 $STELLAR_NETWORK"
  echo "  Horizon:                 $HORIZON_URL"
  echo "  Asset:                   $ASSET_CODE"
  [[ -f "$WASM_PATH" ]] && echo "  WASM:                    $WASM_PATH ($(wc -c < "$WASM_PATH") bytes)"
  echo ""
  echo "  Signing identities:"
  echo "    ISSUER (steps 1,5):    $ISSUER_KEY  (pubkey: $ISSUER)"
  echo "    DEPLOYER (steps 2-4):  $DEPLOYER_KEY"
  [[ "$ISSUER_KEY" == "$DEPLOYER_KEY" ]] && echo "    NOTE: deployer == issuer (single-signer mode — testnet/dev only)"
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

  local unique_roles
  unique_roles=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$ADMIN" "$MINTER" "$YRM" "$YR" "$FTM" "$BLOCK_OP" "$UNBLOCK_OP" "$PAUSER" \
    | sort -u | wc -l | tr -d ' ')
  if [[ "$unique_roles" -lt 8 ]]; then
    echo "WARNING: only $unique_roles distinct role pubkeys (expected 8)"
    echo ""
  fi
}

# [ISSUER] AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED on issuer.
# Must run before any trustline to (CODE, ISSUER) exists.
step_1_issuer_set_options() {
  echo "[1/5] [ISSUER] set_options on issuer account..."
  stellar tx new set-options \
    --source-account "$ISSUER_KEY" \
    --network "$STELLAR_NETWORK" \
    --set-required \
    --set-revocable \
    --set-clawback-enabled
  echo "      done."
  echo ""
}

# [DEPLOYER] Deploy SAC for (ASSET_CODE, ISSUER). Sets SAC_CONTRACT_ID.
step_2_deploy_sac() {
  echo "[2/5] [DEPLOYER] Deploying SAC for $ASSET_CODE:$ISSUER..."
  SAC_CONTRACT_ID=$(stellar contract asset deploy \
    --source-account "$DEPLOYER_KEY" \
    --network "$STELLAR_NETWORK" \
    --asset "$ASSET_CODE:$ISSUER" \
    | tr -d '\r\n')
  echo "      SAC contract ID: $SAC_CONTRACT_ID"
  echo ""
}

# [DEPLOYER] Upload wrapper WASM. Sets WASM_HASH.
step_3_upload_wasm() {
  echo "[3/5] [DEPLOYER] Uploading wrapper WASM..."
  WASM_HASH=$(stellar contract upload \
    --source-account "$DEPLOYER_KEY" \
    --network "$STELLAR_NETWORK" \
    --wasm "$WASM_PATH" \
    | tr -d '\r\n')
  echo "      WASM hash: $WASM_HASH"
  echo ""
}

# [DEPLOYER] Deploy wrapper + run __constructor with 8 role pubkeys.
# Sets WRAPPER_CONTRACT_ID. Deployer gains no privilege.
step_4_deploy_wrapper() {
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
}

# [ISSUER] Hand SAC admin to wrapper. After this, the wrapper is the sole
# address that can mint/burn/clawback/set_authorized on the SAC.
step_5_transfer_sac_admin() {
  echo "[5/5] [ISSUER] Transferring SAC admin to wrapper..."
  stellar contract invoke \
    --source-account "$ISSUER_KEY" \
    --network "$STELLAR_NETWORK" \
    --id "$SAC_CONTRACT_ID" \
    -- \
    set_admin --new_admin "$WRAPPER_CONTRACT_ID"
  echo "      done."
  echo ""
}

# [DEPLOYER --send=no] Read wrapper.admin(); fail if != $ADMIN.
smoke_test_wrapper_admin() {
  echo "[smoke] [DEPLOYER] Querying wrapper.admin()..."
  local got
  got=$(stellar contract invoke \
    --source-account "$DEPLOYER_KEY" \
    --network "$STELLAR_NETWORK" \
    --send=no \
    --id "$WRAPPER_CONTRACT_ID" \
    -- \
    admin \
    | tr -d '\r\n"')
  echo "      admin() = $got"
  if [[ "$got" != "$ADMIN" ]]; then
    echo "ERROR: smoke test failed — wrapper.admin() ($got) != configured ADMIN ($ADMIN)" >&2
    exit 1
  fi
  echo ""
}
