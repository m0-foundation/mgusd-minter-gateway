#!/usr/bin/env bash
#
# verify-issuer-burned.sh — verify a Stellar account is permanently burned.
#
# A "burned" account has:
#   - master_weight = 0 (or master entirely removed from signers list)
#   - no non-master signers
#   - AUTH_IMMUTABLE flag set (the state above is permanent)
#
# Can be invoked standalone (ad-hoc burn audit) or from scripts/deploy-renounce.sh
# step 8 (verifies the just-renounced issuer). See docs/issuer-renunciation.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/deploy-pipeline.sh
source "$SCRIPT_DIR/lib/deploy-pipeline.sh"

ISSUER_PUBLIC_KEY="${ISSUER_PUBLIC_KEY:-}"
ISSUER_KEY_NAME="${ISSUER_KEY_NAME:-}"
STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
MODE="state-only"

usage() {
  cat <<'EOF'
verify-issuer-burned.sh — verify a Stellar account is permanently burned.

Usage:
  ./scripts/verify-issuer-burned.sh [flags]

A burned account has master_weight=0, no other signers, and AUTH_IMMUTABLE set.
Reads ISSUER_PUBLIC_KEY, STELLAR_NETWORK, ISSUER_KEY_NAME from .env if present.

Flags:
  -i, --issuer <G...>      Issuer pubkey to check.
  -n, --network <name>     testnet / public / futurenet (default: testnet).
  -k, --key-name <name>    Local `stellar keys` identity for --probe.
  --probe                  Also submit a benign signing op; expect TxBadAuth.
                           Needs the seed locally available AND issuer balance
                           > ~1.1 XLM. If either is missing, the probe is
                           skipped (state checks alone confirm burn).
  -h, --help               Print this help.

Exits 0 if burned, 1 if not.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--issuer)   ISSUER_PUBLIC_KEY="$2"; shift 2 ;;
    -n|--network)  STELLAR_NETWORK="$2"; shift 2 ;;
    -k|--key-name) ISSUER_KEY_NAME="$2"; shift 2 ;;
    --probe)       MODE="probe"; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "ERROR: unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Auto-load .env at repo root for convenience when run standalone.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"

if [[ -z "${ISSUER_PUBLIC_KEY:-}" ]]; then
  echo "ERROR: --issuer or ISSUER_PUBLIC_KEY required" >&2
  exit 1
fi
if [[ ! "$ISSUER_PUBLIC_KEY" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo "ERROR: invalid Stellar pubkey: $ISSUER_PUBLIC_KEY" >&2
  exit 1
fi
if [[ "$MODE" == "probe" && -z "${ISSUER_KEY_NAME:-}" ]]; then
  echo "ERROR: --probe requires --key-name or ISSUER_KEY_NAME" >&2
  exit 1
fi

for tool in curl jq awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: missing tool: $tool" >&2; exit 1; }
done
if [[ "$MODE" == "probe" ]]; then
  command -v stellar >/dev/null 2>&1 || { echo "ERROR: missing tool: stellar" >&2; exit 1; }
fi

HORIZON_URL=$(horizon_url_for "$STELLAR_NETWORK")

echo "=== verify-issuer-burned ==="
echo "  Issuer:    $ISSUER_PUBLIC_KEY"
echo "  Network:   $STELLAR_NETWORK"
echo "  Horizon:   $HORIZON_URL"
echo "  Mode:      $MODE"
echo ""

acct_file=$(mktemp)
trap 'rm -f "$acct_file"' EXIT
http_code=$(curl -sS -o "$acct_file" -w '%{http_code}' \
  "$HORIZON_URL/accounts/$ISSUER_PUBLIC_KEY" || true)
if [[ "$http_code" == "404" ]]; then
  echo "FAIL: account $ISSUER_PUBLIC_KEY not found on $STELLAR_NETWORK" >&2
  exit 1
fi
if [[ "$http_code" != "200" ]]; then
  echo "ERROR: Horizon HTTP $http_code" >&2
  cat "$acct_file" >&2 || true
  exit 1
fi
acct_resp=$(cat "$acct_file")

# Check 1: signers — must be [] or [{key: ISSUER, weight: 0}].
n_signers=$(echo "$acct_resp" | jq '.signers | length')
signers_desc=""
case "$n_signers" in
  0)
    signers_desc="[] (master omitted)"
    ;;
  1)
    signer_key=$(echo "$acct_resp" | jq -r '.signers[0].key')
    signer_weight=$(echo "$acct_resp" | jq -r '.signers[0].weight')
    if [[ "$signer_key" != "$ISSUER_PUBLIC_KEY" ]]; then
      echo "FAIL: signer key = $signer_key, expected $ISSUER_PUBLIC_KEY or empty list" >&2
      exit 1
    fi
    if [[ "$signer_weight" != "0" ]]; then
      echo "FAIL: master weight = $signer_weight, expected 0" >&2
      exit 1
    fi
    signers_desc="[master (weight 0)]"
    ;;
  *)
    echo "FAIL: signer count = $n_signers, expected 0 or 1" >&2
    echo "$acct_resp" | jq -r '.signers[] | "         \(.key) weight=\(.weight)"' >&2
    exit 1
    ;;
esac
echo "  Signers:           $signers_desc ✓"

# Check 2: AUTH_IMMUTABLE must be set.
flags_num=$(echo "$acct_resp" | jq -r '
  .flags |
  (if .auth_required then 1 else 0 end)
  + (if .auth_revocable then 2 else 0 end)
  + (if .auth_immutable then 4 else 0 end)
  + (if .auth_clawback_enabled then 8 else 0 end)
')
auth_immutable=$(echo "$acct_resp" | jq -r '.flags.auth_immutable')
if [[ "$auth_immutable" != "true" ]]; then
  echo "FAIL: AUTH_IMMUTABLE not set; flags numeric = $flags_num" >&2
  exit 1
fi
echo "  AUTH_IMMUTABLE:    set (flags = $flags_num) ✓"

xlm_balance=$(echo "$acct_resp" | jq -r '.balances[] | select(.asset_type=="native") | .balance')
echo "  XLM balance:       $xlm_balance (LOCKED — account is unsignable)"

# Optional: behavioral probe — submit a benign op, expect network rejection.
if [[ "$MODE" == "probe" ]]; then
  echo ""
  echo "Behavioral probe (expecting TxBadAuth)..."
  if awk -v b="$xlm_balance" 'BEGIN{exit !(b+0 < 1.1)}'; then
    echo "  ⚠ skipping: balance $xlm_balance XLM < 1.1 XLM (need fee headroom)"
    echo "    State checks alone confirm burn."
  else
    probe_out=""
    probe_rc=0
    probe_out=$(stellar tx new set-options \
       --source-account "$ISSUER_KEY_NAME" \
       --network "$STELLAR_NETWORK" \
       --home-domain renounce-check.invalid 2>&1) || probe_rc=$?
    if [[ $probe_rc -eq 0 ]]; then
      echo "FAIL: burned issuer submitted a tx successfully — burn did NOT take effect" >&2
      echo "$probe_out" | tail -5 >&2
      exit 1
    fi
    if echo "$probe_out" | grep -q "TxBadAuth"; then
      echo "  ✓ network returned TxBadAuth — burn behaviorally confirmed"
    elif echo "$probe_out" | grep -qiE "insufficient.balance|insufficient.fee"; then
      echo "  ⚠ probe could not run (insufficient balance/fee despite pre-check):"
      echo "$probe_out" | tail -3 | sed 's/^/    /' >&2
      echo "    State checks alone confirm burn."
    else
      echo "  ⚠ submission failed (exit $probe_rc) but error was not TxBadAuth:"
      echo "$probe_out" | tail -3 | sed 's/^/    /' >&2
      echo "    Tx did not land; state checks pass on their own merit."
    fi
  fi
fi

echo ""
echo "✓ Issuer $ISSUER_PUBLIC_KEY is BURNED."
