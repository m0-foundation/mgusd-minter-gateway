#!/usr/bin/env bash
#
# probe-batch-limit.sh — empirically find the real batch_onboard_users size
# limit on Stellar testnet by landing actual on-chain transactions.
#
# WHY: the contract caps batches at MAX_BATCH_SIZE. This script proves what the
# NETWORK actually allows by running real batches of increasing size against a
# probe deployment whose cap was raised to 100. The size where the network says
# "ResourceLimitExceeded" is the true ceiling.
#
# HIGH-LEVEL STEPS (each is a numbered section below):
#   STEP 1 — Generate N throwaway keypairs (local, offline)
#   STEP 2 — Fund all N accounts in ONE transaction from a single funder
#   STEP 3 — Each account opens its own trustline to the asset
#   STEP 4 — Call batch_onboard_users(all N) and confirm it landed on-chain
#   STEP 5 — Decode the landed tx and print its resource footprint vs. limits
#
# OUTCOMES:
#   ✅ landed         — this N fits; footprint table shows how close to the limits
#   ❌ ResourceLimit  — the network rejected this N; this IS the ceiling
#   ⚠️  not confirmed — testnet lagged; a tx hash is printed to verify manually
#
# Each run uses fresh accounts, so it is safe to repeat at any size. TESTNET ONLY.
#
# The default deployment is the probe/batch-limit-100 build (MAX_BATCH_SIZE=100).
# Point at a different deployment via the CONFIG block or inline env vars, e.g.
#   WRAPPER=C... ASSET=CODE:G... OPERATOR_KEY=mykey ./probe-batch-limit.sh 40

set -euo pipefail

# ============================================================================
# CONFIG — deployed probe contracts + funder. Override inline if needed, e.g.
#   WRAPPER=CXXX ./probe-batch-limit.sh 40
# ============================================================================
WRAPPER="${WRAPPER:-CD6D6ILNY2V4HEVPX7SPUDWKHKGSKFRSSMSDJXUGACQIRRN2IPG7B3I3}"  # gateway contract (cap=100)
ASSET="${ASSET:-TMGUSD:GDXJH6TORV455DKNK6QLZL3CDNOOPPB72ECHWT4S2V4BC6V6GFQYW6C3}"  # CODE:ISSUER
OPERATOR_KEY="${OPERATOR_KEY:-tmpro}"          # stellar keys identity holding the onboarder role
FUNDER="${FUNDER:-$OPERATOR_KEY}"              # single pre-funded account that funds all test users

# ---- Derived inputs and constants (do not usually need editing) ------------
N="${1:?usage: probe-batch-limit.sh <N>   (N = batch size to test)}"
NETWORK=testnet
RPC=https://soroban-testnet.stellar.org
HORIZON=https://horizon-testnet.stellar.org
RUN_ID="$(date +%s)"                           # unique suffix so key aliases never collide
START_BALANCE_STROOPS=50000000                 # 5 XLM/user: base reserve + trustline reserve + fees
OPERATOR_PK="$(stellar keys address "$OPERATOR_KEY")"
ISSUER_G="${ASSET#*:}"                          # issuer pubkey  (after the ':')
CODE="${ASSET%:*}"                             # asset code     (before the ':')

echo "=== Probe: batch_onboard_users with N=$N ==="
echo "  wrapper : $WRAPPER"
echo "  asset   : $ASSET"
echo "  operator: $OPERATOR_PK"
echo

# ============================================================================
# HELPER FUNCTIONS — on-chain confirmation with retry (testnet lags 30-60s).
# Both poll the chain rather than trusting a single CLI response.
# ============================================================================

# True once `pk` holds a trustline to the asset (used in STEP 3).
confirm_trustline() {  # $1 = account pubkey
  for _ in $(seq 1 10); do
    if curl -s "$HORIZON/accounts/$1" \
         | jq -e --arg c "$CODE" --arg i "$ISSUER_G" \
           '.balances[]? | select(.asset_code==$c and .asset_issuer==$i)' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# True once the first user is onboarded on-chain (used in STEP 4). Patient poll:
# distinguishes a genuine resource rejection (never true) from a slow-but-landed
# tx (becomes true within ~60s).
confirm_onboarded() {  # uses global FIRST_USER
  for _ in $(seq 1 15); do
    stellar contract invoke --id "$WRAPPER" --source-account "$OPERATOR_KEY" \
      --network "$NETWORK" --send=no -- is_onboarded --account "$FIRST_USER" 2>/dev/null \
      | grep -q true && return 0
    sleep 4
  done
  return 1
}

# ============================================================================
# STEP 1 — Generate N throwaway keypairs locally (instant, no network calls).
# ============================================================================
USERS=()   # parallel arrays: USERS[i] is the pubkey, KEYS[i] the CLI alias
KEYS=()
for i in $(seq 1 "$N"); do
  key="probe-$RUN_ID-$i"
  stellar keys generate "$key" --network "$NETWORK" --overwrite >/dev/null 2>&1
  KEYS+=("$key")
  USERS+=("$(stellar keys address "$key")")
  printf '\r  step 1: %d/%d keypairs generated' "$i" "$N"
done
echo

# ============================================================================
# STEP 2 — Fund ALL N accounts in a SINGLE create-account transaction from the
# funder. (No friendbot: one tx of up to 100 create-account ops covers the
# whole batch, avoiding the faucet's per-account rate limit.)
# ============================================================================
echo "  step 2: funding $N accounts from $FUNDER in one transaction ..."
# Build the tx: first op via `tx new`, each remaining op appended via `tx op add`.
XDR="$(stellar tx new create-account \
  --source-account "$FUNDER" --destination "${USERS[0]}" \
  --starting-balance "$START_BALANCE_STROOPS" \
  --network "$NETWORK" --build-only --inclusion-fee 10000000 2>/dev/null)"
for pk in "${USERS[@]:1}"; do
  XDR="$(echo "$XDR" | stellar tx operation add create-account \
    --source-account "$FUNDER" --destination "$pk" \
    --starting-balance "$START_BALANCE_STROOPS" 2>/dev/null)"
done
# Sign once (funder) and send.
FUND_RESULT="$(echo "$XDR" \
  | stellar tx sign --sign-with-key "$FUNDER" --network "$NETWORK" 2>/dev/null \
  | stellar tx send --network "$NETWORK" 2>&1)"
# Verify on-chain, not by parsing send output (formatting varies). All users
# share one tx, so if the LAST user now exists, the whole batch landed.
sleep 3
LAST_USER="${USERS[$((N-1))]}"   # macOS bash 3.2 has no negative array indices
if ! curl -s -o /dev/null -w '%{http_code}' "$HORIZON/accounts/$LAST_USER" 2>/dev/null | grep -q '^200$'; then
  echo "$FUND_RESULT" | grep -iE 'error|status|result' | head -4
  echo; echo "❌ funding transaction did not land — see above"; exit 1
fi
echo "  ✅ all $N accounts funded in one tx"

# ============================================================================
# STEP 3 — Each account opens its OWN trustline to the asset. This cannot be
# batched: a trustline must be signed by the account that owns it. Under
# AUTH_REQUIRED the new trustline starts unauthorized (that is what onboarding
# will flip). Retry per user, since testnet submission can time out.
# ============================================================================
for idx in "${!KEYS[@]}"; do
  key="${KEYS[$idx]}"; pk="${USERS[$idx]}"
  trustline_ok=false
  for _ in 1 2 3 4; do
    stellar tx new change-trust --source-account "$key" --line "$ASSET" --network "$NETWORK" >/dev/null 2>&1 || true
    if confirm_trustline "$pk"; then trustline_ok=true; break; fi
  done
  if [ "$trustline_ok" != true ]; then
    echo; echo "❌ could not establish trustline for $pk after retries (testnet flaky — re-run)"; exit 1
  fi
  printf '\r  step 3: %d/%d trustlines confirmed' "$((idx+1))" "$N"
done
echo

# ============================================================================
# STEP 4 — The actual test: call batch_onboard_users(all N) in ONE transaction,
# then decide the outcome from on-chain state (not the CLI exit code, which is
# unreliable on a lagging testnet).
#   • resource rejection  -> ❌ this IS the ceiling (deterministic, stop)
#   • confirmed onboarded  -> ✅ this N fits
#   • neither after retries-> ⚠️  print the tx hash to verify by hand
# ============================================================================
USERS_JSON="$(printf '"%s",' "${USERS[@]}")"; USERS_JSON="[${USERS_JSON%,}]"
FIRST_USER="${USERS[0]}"
echo "  step 4: invoking batch_onboard_users($N users) ..."

TX_HASH=""
CONFIRMED=false
RESOURCE_FAIL=false
for attempt in 1 2 3; do
  OUT="$(stellar contract invoke \
    --id "$WRAPPER" --source-account "$OPERATOR_KEY" --network "$NETWORK" \
    -- batch_onboard_users --users "$USERS_JSON" --operator "$OPERATOR_PK" 2>&1)" || true

  # The CLI signs+submits before waiting for confirmation, so a tx hash exists
  # even on a confirmation timeout. Grab it regardless of exit status (it is the
  # only 64-hex token; addresses are base32 'G…'/'C…', so no collision).
  H="$(echo "$OUT" | grep -oiE '[a-f0-9]{64}' | head -1)"; [ -n "$H" ] && TX_HASH="$H"

  # A resource rejection is deterministic — the ceiling we are hunting. Stop now.
  if echo "$OUT" | grep -qiE 'resource|exceeded limit|budget|too many|TxSorobanInvalid'; then
    RESOURCE_FAIL=true; break
  fi

  # Otherwise, did it land? Patient on-chain poll rides out testnet lag.
  if confirm_onboarded; then CONFIRMED=true; break; fi

  echo "  attempt $attempt: not confirmed yet (testnet lag), retrying..."
  sleep 5
done

# If the CLI output never carried a hash, recover it from the operator's history.
if [ -z "$TX_HASH" ]; then
  TX_HASH="$(curl -s "$HORIZON/accounts/$OPERATOR_PK/transactions?order=desc&limit=1" \
    | jq -r '._embedded.records[0].hash')"
fi
TX_LINK="https://stellar.expert/explorer/testnet/tx/$TX_HASH"

# --- Report the outcome -----------------------------------------------------
if [ "$RESOURCE_FAIL" = true ]; then
  echo "$OUT" | grep -iE 'error|resource|exceeded|budget' | head -4
  [ -n "$TX_HASH" ] && echo "  rejected tx (for reference): $TX_LINK"
  echo; echo "❌ FAILED at N=$N — network rejected on resources. This IS the ceiling."; exit 1
fi
if [ "$CONFIRMED" != true ]; then
  echo "  last tx hash seen: $TX_HASH"
  echo "  check it manually: $TX_LINK"
  echo; echo "⚠️  N=$N not confirmed after patient retries — testnet may still be catching up."
  echo "    Open the link above; if it shows success, this N PASSES (the script gave up early)."
  exit 1
fi
echo "  ✅ landed: $TX_LINK"
echo

# ============================================================================
# STEP 5 — Decode the landed tx and print its resource footprint next to the
# live network limits (so a passing run shows how much headroom is left, and
# how close the binding resource is to its cap). Never fails a run that already
# landed — the RPC may just not have indexed the tx yet.
# ============================================================================
ENV_XDR=""
for _ in $(seq 1 10); do
  ENV_XDR="$(curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",\"params\":{\"hash\":\"$TX_HASH\"}}" \
    | jq -r '.result.envelopeXdr // empty')"
  [ -n "$ENV_XDR" ] && break
  sleep 3
done
if [ -z "$ENV_XDR" ]; then
  echo "  (resource footprint unavailable — RPC hasn't indexed the tx yet; the run PASSED, see link above)"
  echo; echo "  N=$N onboards in ONE transaction. tx: $TX_HASH"
  exit 0
fi

# Actual resource usage, pulled from the transaction envelope.
DECODED="$(echo "$ENV_XDR" | stellar xdr decode --type TransactionEnvelope --output json 2>/dev/null || true)"
RO="$(echo "$DECODED"    | jq -r '.tx.tx.ext.v1.resources.footprint.read_only  | length // "?"' 2>/dev/null || echo '?')"
RW="$(echo "$DECODED"    | jq -r '.tx.tx.ext.v1.resources.footprint.read_write | length // "?"' 2>/dev/null || echo '?')"
INSTR="$(echo "$DECODED" | jq -r '.tx.tx.ext.v1.resources.instructions // "?"'                  2>/dev/null || echo '?')"

# Live per-transaction limits, straight from the network config.
LIMITS="$(stellar network settings --rpc-url "$RPC" \
  --network-passphrase 'Test SDF Network ; September 2015' --output json-formatted 2>/dev/null)"
L_WRITE="$(echo "$LIMITS" | grep -o '"tx_max_write_ledger_entries": [0-9]*' | grep -o '[0-9]*')"
L_READ="$(echo "$LIMITS"  | grep -o '"tx_max_disk_read_entries": [0-9]*'   | grep -o '[0-9]*')"
L_INSTR="$(echo "$LIMITS" | grep -o '"tx_max_instructions": "[0-9]*"'      | grep -o '[0-9]*')"

echo "=== Resource footprint of the landed transaction ==="
printf '  %-22s %10s   (network limit: %s)\n' "write entries"     "$RW"    "$L_WRITE"
printf '  %-22s %10s   (network limit: %s)\n' "read-only entries" "$RO"    "$L_READ (disk reads)"
printf '  %-22s %10s   (network limit: %s)\n' "instructions"      "$INSTR" "$L_INSTR"
echo
echo "  N=$N onboards in ONE transaction. tx: $TX_HASH"
