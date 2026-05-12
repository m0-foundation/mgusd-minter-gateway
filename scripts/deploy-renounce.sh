#!/usr/bin/env bash
#
# deploy-renounce.sh — deploy the Stellar Minter Gateway and (optionally)
# permanently neuter the issuer key.
#
# Steps 1-5 mirror deploy-testnet.sh (via scripts/lib/deploy-pipeline.sh).
# Steps 0, 6, 7, 8 are renounce-specific:
#   0. Pre-deploy issuer-cleanliness preflight  (read-only)
#   6. Renounce-issuer preflight                (read-only)
#   7. [ISSUER] set_options(set-immutable + master-weight 0)   IRREVERSIBLE
#   8. Post-renounce verification — on-chain state read only   (read-only)
#
# Step 8 confirms the renounce landed via Horizon + Soroban reads (master
# weight 0, AUTH_IMMUTABLE set, admin invariants preserved). For behavioral
# confirmation (submit a tx, expect TxBadAuth) run the separate auditor:
#   ./scripts/verify-issuer-burned.sh --probe
# Read docs/issuer-renunciation.md before running --execute.
#
# Quick start:
#   cp scripts/deploy.env.example .env && $EDITOR .env
#   make build
#   ./scripts/deploy-renounce.sh                              # deploy only
#   ./scripts/deploy-renounce.sh --renounce-issuer --dry-run  # build renounce XDR
#   RENOUNCE_ISSUER=1 ./scripts/deploy-renounce.sh --execute  # full pipeline

set -euo pipefail

# Stellar AccountFlags bitmask. Step 1 installs 11 (REQUIRED|REVOCABLE|
# CLAWBACK_ENABLED); step 7 ORs in IMMUTABLE → 15. Step 6 enforces == 11;
# step 8 enforces == 15.
EXPECTED_FLAGS_PRE_RENOUNCE=11
EXPECTED_FLAGS_POST_RENOUNCE=15

RENOUNCE_ISSUER="${RENOUNCE_ISSUER:-0}"
DRY_RUN=0
EXECUTE=0
SKIP_DEPLOY=0

usage() {
  cat <<'EOF'
deploy-renounce.sh — deploy the Stellar Minter Gateway and (optionally)
permanently neuter the issuer key.

Usage: ./scripts/deploy-renounce.sh [flags]

Flags:
  --renounce-issuer    Enable steps 6-8 (the renounce path). Without this,
                       behaves like deploy-testnet.sh. Env: RENOUNCE_ISSUER=1.
  --dry-run            Build the renounce tx and print its XDR; do NOT submit.
                       Steps 1-5 still execute. Requires --renounce-issuer.
  --execute            Submit the full pipeline (step 7 included). On
                       --network=public, requires passphrase confirm.
  --skip-deploy        Skip steps 0-5; run only 6-8 against an existing deploy.
                       Reads SAC_CONTRACT_ID and WRAPPER_CONTRACT_ID from env.
  -h, --help           Print this help and exit.

WARNING: Step 7 is IRREVERSIBLE. After it lands, the issuer key is
         cryptographically unsignable forever; minimum-reserve XLM is locked.
         Read docs/issuer-renunciation.md before running --execute.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --renounce-issuer) RENOUNCE_ISSUER=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --execute) EXECUTE=1 ;;
    --skip-deploy) SKIP_DEPLOY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

# Step 7 is irreversible — every path to it must be explicitly opted into.
if [[ "$RENOUNCE_ISSUER" != "1" ]]; then
  if [[ "$DRY_RUN" == "1" || "$SKIP_DEPLOY" == "1" ]]; then
    echo "ERROR: --dry-run / --skip-deploy require --renounce-issuer (or RENOUNCE_ISSUER=1)" >&2
    exit 1
  fi
else
  if [[ "$DRY_RUN" == "0" && "$EXECUTE" == "0" ]]; then
    echo "ERROR: --renounce-issuer requires either --dry-run or --execute" >&2
    exit 1
  fi
  if [[ "$DRY_RUN" == "1" && "$EXECUTE" == "1" ]]; then
    echo "ERROR: --dry-run and --execute are mutually exclusive" >&2
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/deploy-pipeline.sh
source "$SCRIPT_DIR/lib/deploy-pipeline.sh"

if [[ "$SKIP_DEPLOY" == "1" ]]; then
  init_deploy_pipeline_env --skip-wasm-check
  SAC_CONTRACT_ID=$(require_var SAC_CONTRACT_ID)
  WRAPPER_CONTRACT_ID=$(require_var WRAPPER_CONTRACT_ID)
else
  init_deploy_pipeline_env
fi

ISSUER_RESERVE_XLM_THRESHOLD="${ISSUER_RESERVE_XLM_THRESHOLD:-5}"

mode_str="deploy-only (no renounce)"
if [[ "$RENOUNCE_ISSUER" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    mode_str="deploy + renounce (DRY-RUN — step 7 builds XDR but does not submit)"
  elif [[ "$SKIP_DEPLOY" == "1" ]]; then
    mode_str="RENOUNCE ONLY against existing deploy (skip steps 0-5)"
  else
    mode_str="deploy + RENOUNCE (IRREVERSIBLE)"
  fi
fi
print_deploy_banner "Stellar Minter Gateway — Deploy + Renounce  [$mode_str]"

# STEL1-6: pre-existing trustlines / balances / pools predate step 1's
# AUTH_REQUIRED and auto-authorize outside the wrapper's reach. With no
# classic-clawback fallback post-renunciation, this preflight is non-skippable.
preflight_clean_issuer() {
  echo "[0] Issuer-cleanliness preflight (read-only)..."

  local acct_resp http_code
  http_code=$(curl -sS -o /tmp/deploy-renounce-acct.json -w '%{http_code}' \
    "$HORIZON_URL/accounts/$ISSUER" || true)

  if [[ "$http_code" == "404" ]]; then
    echo "      Issuer account not found on $STELLAR_NETWORK."
    echo "      Fund it first. Testnet: curl \"https://friendbot.stellar.org?addr=$ISSUER\""
    exit 1
  fi
  if [[ "$http_code" != "200" ]]; then
    echo "ERROR: Horizon HTTP $http_code for /accounts/$ISSUER" >&2
    cat /tmp/deploy-renounce-acct.json >&2 || true
    exit 1
  fi
  acct_resp=$(cat /tmp/deploy-renounce-acct.json)

  local flags_bools
  flags_bools=$(echo "$acct_resp" | jq -r '[.flags.auth_required, .flags.auth_revocable, .flags.auth_clawback_enabled, .flags.auth_immutable] | join(",")')
  if [[ "$flags_bools" != "false,false,false,false" ]]; then
    echo "ERROR: issuer already has flags set: $flags_bools — contaminated issuer." >&2
    exit 1
  fi

  local assets_resp records_len
  assets_resp=$(curl -sS "$HORIZON_URL/assets?asset_code=$ASSET_CODE&asset_issuer=$ISSUER")
  records_len=$(echo "$assets_resp" | jq '._embedded.records | length')

  if [[ "$records_len" -gt 0 ]]; then
    local na ncb nlp
    na=$(echo "$assets_resp" | jq -r '._embedded.records[0].num_accounts // 0')
    ncb=$(echo "$assets_resp" | jq -r '._embedded.records[0].num_claimable_balances // 0')
    nlp=$(echo "$assets_resp" | jq -r '._embedded.records[0].num_liquidity_pools // 0')

    if [[ "$na" -gt 0 || "$ncb" -gt 0 || "$nlp" -gt 0 ]]; then
      echo "ERROR: asset $ASSET_CODE:$ISSUER already has holders:" >&2
      echo "         num_accounts=$na  num_claimable_balances=$ncb  num_liquidity_pools=$nlp" >&2
      exit 1
    fi
  fi

  echo "      issuer flags:          all false ✓"
  echo "      asset records:         $records_len (na=ncb=nlp=0) ✓"
  echo ""
}

# Each check defends against a specific bricked-deploy class. All non-skippable
# except check 5 (warning only).
preflight_renounce() {
  echo "[6] Renounce-issuer preflight (read-only)..."

  local acct_resp http_code
  http_code=$(curl -sS -o /tmp/deploy-renounce-acct.json -w '%{http_code}' \
    "$HORIZON_URL/accounts/$ISSUER" || true)
  if [[ "$http_code" != "200" ]]; then
    echo "ERROR: Horizon HTTP $http_code for /accounts/$ISSUER" >&2
    exit 1
  fi
  acct_resp=$(cat /tmp/deploy-renounce-acct.json)

  # 1. Flags must match step-1 exactly. Step 7 makes them immutable forever.
  local flags_num
  flags_num=$(echo "$acct_resp" | jq -r '
    .flags |
    (if .auth_required then 1 else 0 end)
    + (if .auth_revocable then 2 else 0 end)
    + (if .auth_immutable then 4 else 0 end)
    + (if .auth_clawback_enabled then 8 else 0 end)
  ')
  if [[ "$flags_num" != "$EXPECTED_FLAGS_PRE_RENOUNCE" ]]; then
    echo "ERROR: issuer flags = $flags_num, expected $EXPECTED_FLAGS_PRE_RENOUNCE (REQUIRED|REVOCABLE|CLAWBACK_ENABLED)" >&2
    echo "$acct_resp" | jq -r '.flags' >&2
    exit 1
  fi
  echo "      issuer flags:          $flags_num (REQUIRED|REVOCABLE|CLAWBACK_ENABLED) ✓"

  # 2. Master must be the only signer. An extra signer would retain control
  # after master_weight=0 — the opposite of the intent.
  local n_signers
  n_signers=$(echo "$acct_resp" | jq '.signers | length')
  if [[ "$n_signers" != "1" ]]; then
    echo "ERROR: issuer has $n_signers signers; expected 1 (master only)" >&2
    echo "$acct_resp" | jq -r '.signers[] | "         \(.key) weight=\(.weight)"' >&2
    exit 1
  fi
  local signer_key signer_weight
  signer_key=$(echo "$acct_resp" | jq -r '.signers[0].key')
  signer_weight=$(echo "$acct_resp" | jq -r '.signers[0].weight')
  if [[ "$signer_key" != "$ISSUER" || "$signer_weight" != "1" ]]; then
    echo "ERROR: issuer signer mismatch — key=$signer_key weight=$signer_weight (expected $ISSUER weight=1)" >&2
    exit 1
  fi
  echo "      signers:               [master weight=1] ✓"

  # 3. SAC admin must be the wrapper. Otherwise renouncing strands the asset.
  local sac_admin
  sac_admin=$(stellar contract invoke \
    --source-account "$DEPLOYER_KEY" \
    --network "$STELLAR_NETWORK" \
    --send=no \
    --id "$SAC_CONTRACT_ID" \
    -- \
    admin \
    | tr -d '\r\n"')
  if [[ "$sac_admin" != "$WRAPPER_CONTRACT_ID" ]]; then
    echo "ERROR: SAC.admin() = $sac_admin, expected wrapper $WRAPPER_CONTRACT_ID (step 5 didn't land?)" >&2
    exit 1
  fi
  echo "      SAC.admin():           $sac_admin (== wrapper) ✓"

  # 4. Wrapper admin must be the configured G-account.
  local wrapper_admin
  wrapper_admin=$(stellar contract invoke \
    --source-account "$DEPLOYER_KEY" \
    --network "$STELLAR_NETWORK" \
    --send=no \
    --id "$WRAPPER_CONTRACT_ID" \
    -- \
    admin \
    | tr -d '\r\n"')
  if [[ "$wrapper_admin" != "$ADMIN" ]]; then
    echo "ERROR: wrapper.admin() = $wrapper_admin, expected $ADMIN" >&2
    exit 1
  fi
  echo "      wrapper.admin():       $wrapper_admin ✓"

  # 5. Warn on excess XLM (locked forever post-step-7). awk for floating-point.
  local xlm
  xlm=$(echo "$acct_resp" | jq -r '.balances[] | select(.asset_type=="native") | .balance')
  if awk -v xlm="$xlm" -v t="$ISSUER_RESERVE_XLM_THRESHOLD" 'BEGIN{exit !(xlm+0 > t+0)}'; then
    echo "      WARNING: issuer XLM $xlm > threshold $ISSUER_RESERVE_XLM_THRESHOLD — anything above min reserve will be locked"
  else
    echo "      issuer XLM:            $xlm (≤ threshold $ISSUER_RESERVE_XLM_THRESHOLD) ✓"
  fi

  # 6. Mainnet --execute: require interactive passphrase confirm.
  if [[ "$EXECUTE" == "1" && "$STELLAR_NETWORK" == "public" && "$DRY_RUN" == "0" ]]; then
    local expected_passphrase confirmation
    expected_passphrase=$(passphrase_for "$STELLAR_NETWORK")
    echo ""
    echo "      ============================================================"
    echo "      ABOUT TO PERMANENTLY BRICK THE ISSUER ON MAINNET"
    echo "        Issuer: $ISSUER"
    echo "      ============================================================"
    echo "      Type the network passphrase verbatim to proceed:"
    echo "        ($expected_passphrase)"
    printf "      > "
    IFS= read -r confirmation
    if [[ "$confirmation" != "$expected_passphrase" ]]; then
      echo "ERROR: passphrase mismatch. Aborting." >&2
      exit 1
    fi
    echo "      passphrase confirmed ✓"
  fi

  echo "      ✓ preflight passed."
  echo ""
}

# Single atomic SetOptionsOp: master_weight=0 + AUTH_IMMUTABLE, signed by the
# master against pre-op signer state. After this lands, the master can never
# sign again and the flag set is locked forever.
renounce() {
  echo "[7] [ISSUER] Renouncing issuer key (set-immutable + master-weight 0)..."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "      DRY-RUN: building tx envelope (--build-only), NOT submitting."
    echo "      ----------------------- renounce XDR -----------------------"
    stellar tx new set-options \
      --source-account "$ISSUER_KEY" \
      --network "$STELLAR_NETWORK" \
      --set-immutable \
      --master-weight 0 \
      --build-only
    echo "      ------------------------------------------------------------"
    echo "      DRY-RUN complete. Re-run with --execute to submit."
    return 0
  fi

  echo "      IRREVERSIBLE. After this tx lands, $ISSUER is unsignable forever."
  stellar tx new set-options \
    --source-account "$ISSUER_KEY" \
    --network "$STELLAR_NETWORK" \
    --set-immutable \
    --master-weight 0
  echo "      done."
  echo ""
}

# Post-renounce verification: re-fetch the issuer from Horizon + read SAC and
# wrapper admin via Soroban, then assert the four state preconditions for a
# successful burn. NO transaction submission — for behavioral confirmation
# (submit-then-expect-TxBadAuth), run scripts/verify-issuer-burned.sh --probe.
verify_renounced() {
  echo "[8] Post-renounce verification (on-chain read)..."

  local acct_resp http_code
  http_code=$(curl -sS -o /tmp/deploy-renounce-acct.json -w '%{http_code}' \
    "$HORIZON_URL/accounts/$ISSUER" || true)
  if [[ "$http_code" != "200" ]]; then
    echo "ERROR: Horizon HTTP $http_code for /accounts/$ISSUER" >&2
    exit 1
  fi
  acct_resp=$(cat /tmp/deploy-renounce-acct.json)

  # Horizon may render a master with weight 0 either as 1 entry (key=ISSUER,
  # weight=0) or as 0 entries (omitted). Both are valid renounced states.
  local n_signers
  n_signers=$(echo "$acct_resp" | jq '.signers | length')
  case "$n_signers" in
    0) : ;;
    1)
      local signer_key signer_weight
      signer_key=$(echo "$acct_resp" | jq -r '.signers[0].key')
      signer_weight=$(echo "$acct_resp" | jq -r '.signers[0].weight')
      if [[ "$signer_key" != "$ISSUER" ]]; then
        echo "ERROR: post-renounce signer = $signer_key, expected $ISSUER or empty" >&2
        exit 1
      fi
      if [[ "$signer_weight" != "0" ]]; then
        echo "ERROR: post-renounce master weight = $signer_weight, expected 0" >&2
        exit 1
      fi
      ;;
    *)
      echo "ERROR: post-renounce signer count = $n_signers, expected 0 or 1" >&2
      echo "$acct_resp" | jq -r '.signers[] | "         \(.key) weight=\(.weight)"' >&2
      exit 1
      ;;
  esac

  local flags_num
  flags_num=$(echo "$acct_resp" | jq -r '
    .flags |
    (if .auth_required then 1 else 0 end)
    + (if .auth_revocable then 2 else 0 end)
    + (if .auth_immutable then 4 else 0 end)
    + (if .auth_clawback_enabled then 8 else 0 end)
  ')
  if [[ "$flags_num" != "$EXPECTED_FLAGS_POST_RENOUNCE" ]]; then
    echo "ERROR: post-renounce flags = $flags_num, expected $EXPECTED_FLAGS_POST_RENOUNCE (pre-renounce + IMMUTABLE)" >&2
    exit 1
  fi

  local sac_admin wrapper_admin
  sac_admin=$(stellar contract invoke \
    --source-account "$DEPLOYER_KEY" --network "$STELLAR_NETWORK" --send=no \
    --id "$SAC_CONTRACT_ID" -- admin | tr -d '\r\n"')
  wrapper_admin=$(stellar contract invoke \
    --source-account "$DEPLOYER_KEY" --network "$STELLAR_NETWORK" --send=no \
    --id "$WRAPPER_CONTRACT_ID" -- admin | tr -d '\r\n"')
  [[ "$sac_admin" != "$WRAPPER_CONTRACT_ID" ]] && { echo "ERROR: SAC admin drifted: $sac_admin" >&2; exit 1; }
  [[ "$wrapper_admin" != "$ADMIN" ]] && { echo "ERROR: wrapper admin drifted: $wrapper_admin" >&2; exit 1; }

  local xlm signers_desc
  xlm=$(echo "$acct_resp" | jq -r '.balances[] | select(.asset_type=="native") | .balance')
  if [[ "$n_signers" == "0" ]]; then
    signers_desc="[] (master omitted; weight 0)"
  else
    signers_desc="[master (weight 0)]"
  fi

  cat <<EOF

=== Issuer Renounced ===
  Issuer:                     $ISSUER (PERMANENTLY UNSIGNABLE per chain state)
  master_weight:              0
  signers:                    $signers_desc
  flags:                      AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED | AUTH_IMMUTABLE (= $flags_num)
  Locked XLM (unrecoverable): $xlm
  SAC admin:                  $sac_admin
  Wrapper admin:              $wrapper_admin (rotate via wrapper.set_admin)

For behavioral confirmation (submit-then-expect-TxBadAuth), run:
  ./scripts/verify-issuer-burned.sh --probe

See docs/issuer-renunciation.md for the wrapper-side compliance mapping.
EOF
}

if [[ "$SKIP_DEPLOY" == "0" ]]; then
  preflight_clean_issuer
  step_1_issuer_set_options
  step_2_deploy_sac
  step_3_upload_wasm
  step_4_deploy_wrapper
  step_5_transfer_sac_admin
  smoke_test_wrapper_admin
else
  echo "[skip-deploy] Using existing deploy:"
  echo "  SAC_CONTRACT_ID:     $SAC_CONTRACT_ID"
  echo "  WRAPPER_CONTRACT_ID: $WRAPPER_CONTRACT_ID"
  echo ""
fi

if [[ "$RENOUNCE_ISSUER" == "1" ]]; then
  preflight_renounce
  renounce
  [[ "$DRY_RUN" == "0" ]] && verify_renounced
else
  echo "=== Deploy Complete (no renounce) ==="
  echo "  SAC Contract ID:     $SAC_CONTRACT_ID"
  echo "  WASM Hash:           $WASM_HASH"
  echo "  Wrapper Contract ID: $WRAPPER_CONTRACT_ID"
  echo ""
  echo "  Next: bridge / minter calls wrapper.mint(...) to issue tokens."
  echo "  To renounce the issuer, re-run with --renounce-issuer --execute."
fi
