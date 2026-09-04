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

# Download the WASM artifact for $RELEASE_TAG from $RELEASE_REPO and verify
# the Sigstore build-provenance attestation. Sets $WASM_PATH on success.
# Used by init_deploy_pipeline_env when RELEASE_TAG is set.
fetch_attested_wasm() {
  command -v gh >/dev/null 2>&1 || {
    echo "ERROR: gh CLI required to fetch the release WASM." >&2
    echo "       Install: https://cli.github.com/  (then \`gh auth login\`)" >&2
    exit 1
  }

  local dist_dir="./dist"
  mkdir -p "$dist_dir"

  echo "Fetching $RELEASE_TAG WASM from $RELEASE_REPO..."
  if ! gh release download "$RELEASE_TAG" \
        --repo "$RELEASE_REPO" \
        --pattern 'mintergateway_v*.wasm' \
        --dir "$dist_dir" \
        --clobber; then
    echo "ERROR: gh release download failed for $RELEASE_REPO@$RELEASE_TAG" >&2
    echo "       Confirm the release exists and you have access." >&2
    exit 1
  fi

  WASM_PATH=$(find "$dist_dir" -maxdepth 1 -type f -name 'mintergateway_v*.wasm' -print -quit)
  if [[ -z "$WASM_PATH" || ! -f "$WASM_PATH" ]]; then
    echo "ERROR: no mintergateway_v*.wasm asset found in $RELEASE_TAG" >&2
    exit 1
  fi

  echo "Verifying GitHub build-provenance attestation..."
  if ! gh attestation verify "$WASM_PATH" --repo "$RELEASE_REPO"; then
    echo "ERROR: attestation verification failed for $WASM_PATH" >&2
    echo "       Refusing to deploy unverified bytes." >&2
    exit 1
  fi
  echo "  ✓ attestation verified"

  if [[ -n "$EXPECTED_WASM_HASH" ]]; then
    verify_wasm_hash "$WASM_PATH" "$EXPECTED_WASM_HASH"
  fi

  cross_verify_local_build
  echo ""
}

# Reproduce the release WASM locally with the same flags CI used and refuse
# to deploy unless the bytes match the attested artifact. Strongest provenance
# check: doesn't require trusting GitHub's signature alone — proves that this
# machine's toolchain produces the same bytes the attestation covers.
#
# Mandatory whenever RELEASE_TAG is set. Local dev that can't reproduce the
# release should use the WASM_PATH + ALLOW_UNATTESTED_WASM=1 path instead.
cross_verify_local_build() {
  for tool in stellar cargo git; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "ERROR: $tool required for cross-verification of the release WASM." >&2
      echo "       Install it, or deploy a local build via WASM_PATH + ALLOW_UNATTESTED_WASM=1." >&2
      exit 1
    }
  done

  local head_sha release_sha
  head_sha=$(git rev-parse HEAD)
  release_sha=$(gh api "repos/$RELEASE_REPO/tags" --paginate --jq ".[] | select(.name == \"$RELEASE_TAG\") | .commit.sha" 2>/dev/null | head -1)
  if [[ -z "$release_sha" ]]; then
    echo "ERROR: could not resolve commit SHA for $RELEASE_REPO@$RELEASE_TAG" >&2
    exit 1
  fi
  if [[ "$head_sha" != "$release_sha" ]]; then
    echo "ERROR: HEAD does not point to the $RELEASE_TAG commit; cannot reproduce." >&2
    echo "  HEAD:        $head_sha" >&2
    echo "  $RELEASE_TAG: $release_sha" >&2
    echo "  Run: git fetch --tags origin && git checkout $RELEASE_TAG" >&2
    exit 1
  fi

  local local_build_dir="./dist/local-build"
  mkdir -p "$local_build_dir"
  rm -f "$local_build_dir"/*.wasm

  echo "Reproducing release bytes locally at $head_sha (matches CI flags)..."
  if ! stellar contract build \
        --package mintergateway \
        --locked \
        --optimize \
        --out-dir "$local_build_dir" \
        --meta "source_repo=github:${RELEASE_REPO}" \
        --meta "home_domain=$HOME_DOMAIN" >/dev/null; then
    echo "ERROR: local build failed" >&2
    exit 1
  fi

  local local_wasm
  local_wasm=$(find "$local_build_dir" -maxdepth 1 -type f -name '*.wasm' -print -quit)
  if [[ -z "$local_wasm" ]]; then
    echo "ERROR: no .wasm produced in $local_build_dir" >&2
    exit 1
  fi

  local local_hash release_hash
  local_hash=$(sha256sum "$local_wasm"  | cut -d ' ' -f 1)
  release_hash=$(sha256sum "$WASM_PATH" | cut -d ' ' -f 1)

  echo "  local   : $local_hash  ($local_wasm)"
  echo "  release : $release_hash  ($WASM_PATH)"

  if [[ "$local_hash" != "$release_hash" ]]; then
    cat >&2 <<EOF

ERROR: local build does not reproduce the attested release bytes.

  local:    $local_hash
  release:  $release_hash

The Sigstore attestation covers the release bytes, but your local toolchain
produces different output. Possible causes:
  - rust-toolchain.toml channel drift (check rustc --version)
  - Stellar CLI version mismatch (check stellar --version, want 25.2.0)
  - macOS↔Linux build-path leak in WASM metadata
  - dirty working tree (uncommitted changes alter compiled bytes)

Refusing to deploy until local build is byte-equivalent to the release.
If your environment fundamentally can't reproduce the release (e.g. you
don't have the Rust toolchain installed), the WASM_PATH + ALLOW_UNATTESTED_WASM=1
path exists for explicit local-build deploys.
EOF
    exit 1
  fi
  echo "  ✓ local build reproduces release bytes"
}

# Print a loud warning before deploying a non-CI-built WASM.
# Called when WASM_PATH is set and ALLOW_UNATTESTED_WASM=1.
warn_unattested_wasm() {
  cat >&2 <<EOF

  ⚠️  WARNING: deploying unattested WASM
  ⚠️
  ⚠️    WASM_PATH=$WASM_PATH
  ⚠️    ALLOW_UNATTESTED_WASM=1 — proceeding without GitHub attestation.
  ⚠️
  ⚠️    For production deploys, prefer RELEASE_TAG=v<version> so the bytes
  ⚠️    are downloaded from the GH release and verified against the
  ⚠️    Sigstore build-provenance attestation.

EOF
}

# Compare a WASM file's sha256 against an expected value; exit on mismatch.
verify_wasm_hash() {
  local path="$1" expected="$2"
  local actual
  actual=$(sha256sum "$path" | cut -d ' ' -f 1)
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: WASM sha256 mismatch:" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "  file:     $path" >&2
    exit 1
  fi
  echo "  ✓ WASM sha256 matches expected $expected"
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
  HOME_DOMAIN="${HOME_DOMAIN:-m0.org}"
  RELEASE_REPO="${RELEASE_REPO:-m0-foundation/mgusd-minter-gateway}"
  RELEASE_TAG="${RELEASE_TAG:-}"
  EXPECTED_WASM_HASH="${EXPECTED_WASM_HASH:-}"
  ALLOW_UNATTESTED_WASM="${ALLOW_UNATTESTED_WASM:-0}"
  WASM_PATH="${WASM_PATH:-}"

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
  ONBOARDER=$(require_pubkey ONBOARDER_PUBLIC_KEY)

  # Resolve the WASM the deploy will upload. Four cases:
  #   RELEASE_TAG  set         → download from GH release, verify attestation
  #   WASM_PATH    set + ALLOW → loud warning, optional hash-pin, proceed
  #   WASM_PATH    set, no ALLOW → hard error (unattested deploy refused)
  #   neither      set         → hard error
  if [[ "$skip_wasm_check" == "0" ]]; then
    if [[ -n "$RELEASE_TAG" ]]; then
      fetch_attested_wasm
    elif [[ -n "$WASM_PATH" ]]; then
      if [[ "$ALLOW_UNATTESTED_WASM" != "1" ]]; then
        echo "ERROR: WASM_PATH set without ALLOW_UNATTESTED_WASM=1." >&2
        echo "       Set RELEASE_TAG=v<version> for an attested deploy," >&2
        echo "       or set ALLOW_UNATTESTED_WASM=1 to force a local-build deploy." >&2
        exit 1
      fi
      if [[ ! -f "$WASM_PATH" ]]; then
        echo "ERROR: WASM not found at $WASM_PATH — run 'make build' first" >&2
        exit 1
      fi
      warn_unattested_wasm
      if [[ -n "$EXPECTED_WASM_HASH" ]]; then
        verify_wasm_hash "$WASM_PATH" "$EXPECTED_WASM_HASH"
      fi
    else
      echo "ERROR: must set RELEASE_TAG (recommended) or WASM_PATH." >&2
      echo "       Production:  RELEASE_TAG=v1.0.0 ./scripts/deploy-testnet.sh" >&2
      echo "       Local dev:   WASM_PATH=./target/wasm32v1-none/release/mintergateway.wasm \\" >&2
      echo "                    ALLOW_UNATTESTED_WASM=1 ./scripts/deploy-testnet.sh" >&2
      exit 1
    fi
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
  echo "    onboarder:             $ONBOARDER"
  echo ""

  local unique_roles
  unique_roles=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$ADMIN" "$MINTER" "$YRM" "$YR" "$FTM" "$BLOCK_OP" "$UNBLOCK_OP" "$PAUSER" "$ONBOARDER" \
    | sort -u | wc -l | tr -d ' ')
  if [[ "$unique_roles" -lt 9 ]]; then
    echo "WARNING: only $unique_roles distinct role pubkeys (expected 9)"
    echo ""
  fi
}

# [ISSUER] AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED + home_domain
# on issuer. Must run before any trustline to (CODE, ISSUER) exists, and —
# critically — BEFORE issuer renunciation (deploy-renounce.sh sets
# master_weight=0 + AUTH_IMMUTABLE, after which no field on this account
# can ever be changed again). home_domain is the SEP-1 entry point that
# wallets/exchanges use to discover the asset's stellar.toml metadata
# (icon, name, validator, etc.) — separate from the contract meta
# home_domain (SEP-0055) read by Lab / stellar.expert.
step_1_issuer_set_options() {
  echo "[1/5] [ISSUER] set_options on issuer account..."
  stellar tx new set-options \
    --source-account "$ISSUER_KEY" \
    --network "$STELLAR_NETWORK" \
    --set-required \
    --set-revocable \
    --set-clawback-enabled \
    --home-domain "$HOME_DOMAIN"
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
    --onboarder "$ONBOARDER" \
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
