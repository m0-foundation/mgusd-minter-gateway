#!/usr/bin/env bash
#
# deploy-renounce.sh — deploy the Stellar Minter Gateway and (optionally)
# permanently neuter the issuer key.
#
# Steps 1-5 mirror deploy-testnet.sh (via scripts/deploy-pipeline.sh).
# Steps 6-7 are renounce-specific:
#   6. [ISSUER] set_options(set-immutable + master-weight 0)   IRREVERSIBLE
#   7. Post-renounce verification — on-chain state read only   (read-only)
#
# Step 7 confirms the renounce landed via Horizon + Soroban reads (master
# weight 0, AUTH_IMMUTABLE set, admin invariants preserved). For behavioral
# confirmation (submit a tx, expect TxBadAuth) run the separate auditor:
#   ./scripts/verify-issuer-burned.sh --probe
# Read docs/issuer-renunciation.md before running --execute.
#
# Quick start:
#   cp scripts/deploy.env.example .env && $EDITOR .env
#   export RELEASE_TAG=v1.0.0                                 # downloads attested WASM
#   ./scripts/deploy-renounce.sh                              # deploy only
#   ./scripts/deploy-renounce.sh --renounce-issuer --dry-run  # build renounce XDR
#   RENOUNCE_ISSUER=1 ./scripts/deploy-renounce.sh --execute  # full pipeline

set -euo pipefail

# Step 1 installs flags 11 (REQUIRED|REVOCABLE|CLAWBACK_ENABLED); step 6 ORs
# in IMMUTABLE → 15. Step 7 enforces == 15.
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
  --renounce-issuer    Enable steps 6-7 (the renounce path). Without this,
                       behaves like deploy-testnet.sh. Env: RENOUNCE_ISSUER=1.
  --dry-run            Build the renounce tx and print its XDR; do NOT submit.
                       Steps 1-5 still execute. Requires --renounce-issuer.
  --execute            Submit the full pipeline (step 6 included).
  --skip-deploy        Skip steps 1-5; run only 6-7 against an existing deploy.
                       Reads SAC_CONTRACT_ID and WRAPPER_CONTRACT_ID from env.
  -h, --help           Print this help and exit.

WARNING: Step 6 is IRREVERSIBLE. After it lands, the issuer key is
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

# Step 6 is irreversible — every path to it must be explicitly opted into.
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
# shellcheck source=scripts/deploy-pipeline.sh
source "$SCRIPT_DIR/deploy-pipeline.sh"

if [[ "$SKIP_DEPLOY" == "1" ]]; then
  init_deploy_pipeline_env --skip-wasm-check
  SAC_CONTRACT_ID=$(require_var SAC_CONTRACT_ID)
  WRAPPER_CONTRACT_ID=$(require_var WRAPPER_CONTRACT_ID)
else
  init_deploy_pipeline_env
fi

mode_str="deploy-only (no renounce)"
if [[ "$RENOUNCE_ISSUER" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    mode_str="deploy + renounce (DRY-RUN — step 6 builds XDR but does not submit)"
  elif [[ "$SKIP_DEPLOY" == "1" ]]; then
    mode_str="RENOUNCE ONLY against existing deploy (skip steps 1-5)"
  else
    mode_str="deploy + RENOUNCE (IRREVERSIBLE)"
  fi
fi
print_deploy_banner "Stellar Minter Gateway — Deploy + Renounce  [$mode_str]"

# Trustlines established before step 1 lack the per-trustline TRUSTLINE_CLAWBACK_ENABLED
# bit (which is set only at create time, only if the issuer has AUTH_CLAWBACK_ENABLED then).
# After renunciation those holders are un-clawback-able forever — wrapper.force_transfer
# fails on them. Block/unblock still works (gates on AUTH_REVOCABLE, not a per-trustline bit).
assert_clean_issuer() {
  local http_code acct flags_any holders
  http_code=$(curl -sS -o /tmp/deploy-renounce-acct.json -w '%{http_code}' \
    "$HORIZON_URL/accounts/$ISSUER" || true)
  if [[ "$http_code" == "404" ]]; then
    echo "ERROR: issuer $ISSUER not found on $STELLAR_NETWORK. Fund it first." >&2
    echo "       Testnet: curl \"https://friendbot.stellar.org?addr=$ISSUER\"" >&2
    exit 1
  fi
  [[ "$http_code" != "200" ]] && { echo "ERROR: Horizon HTTP $http_code for /accounts/$ISSUER" >&2; exit 1; }
  acct=$(cat /tmp/deploy-renounce-acct.json)

  flags_any=$(echo "$acct" | jq -r '[.flags.auth_required, .flags.auth_revocable, .flags.auth_clawback_enabled, .flags.auth_immutable] | any')
  [[ "$flags_any" == "true" ]] && { echo "ERROR: issuer $ISSUER already has account flags set — contaminated." >&2; exit 1; }

  # Sum trustline counts (authorized + AML + unauthorized) plus claimable balances and
  # liquidity pools for (asset_code, issuer). Zero confirms nobody has established any
  # relationship with this asset yet — i.e. the issuer is clean for our deploy.
  holders=$(curl -sS "$HORIZON_URL/assets?asset_code=$ASSET_CODE&asset_issuer=$ISSUER" \
    | jq '([._embedded.records[0]? | (.accounts.authorized // 0), (.accounts.authorized_to_maintain_liabilities // 0), (.accounts.unauthorized // 0), (.num_claimable_balances // 0), (.num_liquidity_pools // 0)] | add) // 0')
  if [[ "${holders:-0}" -gt 0 ]]; then
    echo "ERROR: asset $ASSET_CODE:$ISSUER already has $holders holders/CBs/pools — contaminated." >&2
    exit 1
  fi
}

# Single atomic SetOptionsOp: master_weight=0 + AUTH_IMMUTABLE, signed by the
# master against pre-op signer state. After this lands, the master can never
# sign again and the flag set is locked forever.
renounce() {
  echo "[6] [ISSUER] Renouncing issuer key (set-immutable + master-weight 0)..."

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
  echo "[7] Post-renounce verification (on-chain read)..."

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
  assert_clean_issuer
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
