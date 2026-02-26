#!/usr/bin/env bash
#
# Test: Can a holder send tokens back to the issuer via Classic Stellar payment?
#
# In Stellar Classic, the issuer doesn't have a trustline for their own asset,
# so AUTH_REQUIRED shouldn't block payments TO the issuer. Tokens sent to the
# issuer are "un-issued" (destroyed).
#
# In Soroban SAC tests, we saw that the issuer IS blocked (treated like any
# other deauthorized account). This script tests the REAL behavior on testnet
# using Classic Stellar operations (PaymentOp), not SAC calls.
#
# Usage: bash scripts/test-send-to-issuer.sh
#

set -euo pipefail

NETWORK="testnet"
ASSET_CODE="YTEST"

echo "=============================================="
echo " SEND-TO-ISSUER TEST (Stellar Testnet)"
echo "=============================================="
echo ""

# -----------------------------------------------
# Step 1: Generate and fund accounts
# -----------------------------------------------
echo "[1/8] Generating issuer account..."
stellar keys generate issuer-test --network "$NETWORK" --fund --overwrite 2>&1
ISSUER_PK=$(stellar keys address issuer-test)
echo "  Issuer: $ISSUER_PK"

echo "[2/8] Generating holder account..."
stellar keys generate holder-test --network "$NETWORK" --fund --overwrite 2>&1
HOLDER_PK=$(stellar keys address holder-test)
echo "  Holder: $HOLDER_PK"

ASSET="${ASSET_CODE}:${ISSUER_PK}"
echo ""
echo "  Asset: $ASSET"
echo ""

# -----------------------------------------------
# Step 2: Set AUTH_REQUIRED + AUTH_REVOCABLE + CLAWBACK on issuer
# -----------------------------------------------
echo "[3/8] Setting issuer flags: AUTH_REQUIRED, AUTH_REVOCABLE, CLAWBACK_ENABLED..."
stellar tx new set-options \
  --source-account issuer-test \
  --set-required \
  --set-revocable \
  --set-clawback-enabled \
  --network "$NETWORK" 2>&1
echo "  Done."
echo ""

# -----------------------------------------------
# Step 3: Holder creates trustline
# -----------------------------------------------
echo "[4/8] Holder creates trustline for $ASSET_CODE..."
stellar tx new change-trust \
  --source-account holder-test \
  --line "$ASSET" \
  --network "$NETWORK" 2>&1
echo "  Done."
echo ""

# -----------------------------------------------
# Step 4: Issuer authorizes holder's trustline
# -----------------------------------------------
echo "[5/8] Issuer authorizes holder's trustline..."
stellar tx new set-trustline-flags \
  --source-account issuer-test \
  --trustor "$HOLDER_PK" \
  --asset "$ASSET" \
  --set-authorize \
  --network "$NETWORK" 2>&1
echo "  Done."
echo ""

# -----------------------------------------------
# Step 5: Issuer sends 1000 tokens to holder
# -----------------------------------------------
MINT_AMOUNT="10000000000"  # 1000 tokens in stroops (1000 * 10^7)
HALF_AMOUNT="5000000000"   # 500 tokens
echo "[6/12] Issuer sends 1000 $ASSET_CODE to holder..."
stellar tx new payment \
  --source-account issuer-test \
  --destination "$HOLDER_PK" \
  --asset "$ASSET" \
  --amount "$MINT_AMOUNT" \
  --network "$NETWORK" 2>&1
echo "  Done."
echo ""

# -----------------------------------------------
# Step 6: Check holder balance before send-to-issuer
# -----------------------------------------------
echo "[7/12] Checking holder balance via Horizon..."
HORIZON="https://horizon-testnet.stellar.org"
HOLDER_BALANCES=$(curl -s "$HORIZON/accounts/$HOLDER_PK" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for b in data.get('balances', []):
    if b.get('asset_code') == '$ASSET_CODE':
        print(f\"  Holder balance: {b['balance']} $ASSET_CODE\")
        print(f\"  Authorized: {b.get('is_authorized', 'N/A')}\")
" 2>/dev/null || echo "  (could not parse)")
echo "$HOLDER_BALANCES"
echo ""

# -----------------------------------------------
# Step 7: TEST A — Authorized holder sends to issuer
# -----------------------------------------------
echo "=============================================="
echo " TEST A: Authorized holder sends 500 $ASSET_CODE to issuer"
echo "=============================================="
echo ""
echo "  In Classic Stellar: issuer has no trustline, so AUTH_REQUIRED"
echo "  should NOT block this. Tokens sent to issuer are un-issued."
echo ""
echo "  Attempting payment..."
echo ""

RESULT_A=$(stellar tx new payment \
  --source-account holder-test \
  --destination "$ISSUER_PK" \
  --asset "$ASSET" \
  --amount "$HALF_AMOUNT" \
  --network "$NETWORK" 2>&1) && TX_A_SUCCESS=true || TX_A_SUCCESS=false

echo "$RESULT_A"
echo ""

if [ "$TX_A_SUCCESS" = true ]; then
  echo "  RESULT: Payment to issuer SUCCEEDED"
  echo ""
  echo "  This means Classic Stellar allows sending to issuer even with"
  echo "  AUTH_REQUIRED — the issuer is exempt (no trustline needed)."
  echo "  Tokens are un-issued (destroyed)."
  echo ""
  echo "  IMPLICATION: If users interact via Classic ops, they CAN burn"
  echo "  tokens by sending to issuer, desyncing the yield accumulators."
else
  echo "  RESULT: Payment to issuer FAILED"
  echo ""
  echo "  This means even Classic Stellar blocks payment to issuer"
  echo "  when AUTH_REQUIRED is set. Same as Soroban SAC behavior."
fi

# -----------------------------------------------
# Step 8: Mid-test balance check
# -----------------------------------------------
echo ""
echo "[8/12] Checking holder balance after Test A..."
curl -s "$HORIZON/accounts/$HOLDER_PK" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for b in data.get('balances', []):
    if b.get('asset_code') == '$ASSET_CODE':
        print(f\"  Holder balance: {b['balance']} $ASSET_CODE\")
        print(f\"  Authorized: {b.get('is_authorized', 'N/A')}\")
" 2>/dev/null || echo "  (could not parse)"
echo ""

# -----------------------------------------------
# Step 9: Freeze (deauthorize) the holder
# -----------------------------------------------
echo "[9/12] Issuer deauthorizes (freezes) holder's trustline..."
stellar tx new set-trustline-flags \
  --source-account issuer-test \
  --trustor "$HOLDER_PK" \
  --asset "$ASSET" \
  --clear-authorize \
  --network "$NETWORK" 2>&1
echo "  Done."
echo ""

echo "[10/12] Verifying holder is frozen..."
curl -s "$HORIZON/accounts/$HOLDER_PK" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for b in data.get('balances', []):
    if b.get('asset_code') == '$ASSET_CODE':
        print(f\"  Holder balance: {b['balance']} $ASSET_CODE\")
        print(f\"  Authorized: {b.get('is_authorized', 'N/A')}\")
" 2>/dev/null || echo "  (could not parse)"
echo ""

# -----------------------------------------------
# Step 10: TEST B — Frozen holder tries to send to issuer
# -----------------------------------------------
echo "=============================================="
echo " TEST B: FROZEN holder sends 500 $ASSET_CODE to issuer"
echo "=============================================="
echo ""
echo "  The holder is now deauthorized (frozen). Can they still"
echo "  send tokens to the issuer via Classic PaymentOp?"
echo ""
echo "  Attempting payment..."
echo ""

RESULT_B=$(stellar tx new payment \
  --source-account holder-test \
  --destination "$ISSUER_PK" \
  --asset "$ASSET" \
  --amount "$HALF_AMOUNT" \
  --network "$NETWORK" 2>&1) && TX_B_SUCCESS=true || TX_B_SUCCESS=false

echo "$RESULT_B"
echo ""

if [ "$TX_B_SUCCESS" = true ]; then
  echo "  RESULT: Frozen holder payment to issuer SUCCEEDED"
  echo ""
  echo "  WARNING: Even frozen accounts can send to the issuer!"
  echo "  This means freezing alone does NOT prevent un-issuing."
  echo "  Frozen holders can still desync the yield accumulators."
else
  echo "  RESULT: Frozen holder payment to issuer FAILED"
  echo ""
  echo "  Frozen accounts CANNOT send to the issuer."
  echo "  Deauthorization blocks ALL outbound payments, including"
  echo "  to the issuer. This matches our Soroban unit test."
fi

# -----------------------------------------------
# Step 11: Re-authorize holder for remaining tests
# -----------------------------------------------
echo "[11/18] Re-authorizing holder for freeze-issuer tests..."
stellar tx new set-trustline-flags \
  --source-account issuer-test \
  --trustor "$HOLDER_PK" \
  --asset "$ASSET" \
  --set-authorize \
  --network "$NETWORK" 2>&1
echo "  Done."
echo ""

# =============================================================================
# FREEZE-THE-ISSUER TESTS (Classic Stellar)
# =============================================================================
#
# In Soroban, set_authorized(issuer, false) panics with "issuer doesn't have
# a trustline". What happens when we try the equivalent Classic operations?
#
# The issuer never creates a trustline for its own asset (Stellar protocol rule).
# set-trustline-flags modifies a trustor's trustline, so attempting to use the
# issuer as trustor for its own asset should fail.

# -----------------------------------------------
# TEST C: Issuer tries to freeze itself via set-trustline-flags
# -----------------------------------------------
echo "=============================================="
echo " TEST C: Freeze the issuer via set-trustline-flags"
echo "=============================================="
echo ""
echo "  The issuer tries to deauthorize (freeze) ITSELF by calling"
echo "  set-trustline-flags with the issuer as trustor."
echo "  Expected: FAIL — issuer has no trustline for its own asset."
echo ""
echo "  Attempting set-trustline-flags --trustor <issuer> --clear-authorize..."
echo ""

RESULT_C=$(stellar tx new set-trustline-flags \
  --source-account issuer-test \
  --trustor "$ISSUER_PK" \
  --asset "$ASSET" \
  --clear-authorize \
  --network "$NETWORK" 2>&1) && TX_C_SUCCESS=true || TX_C_SUCCESS=false

echo "$RESULT_C"
echo ""

if [ "$TX_C_SUCCESS" = true ]; then
  echo "  RESULT: set-trustline-flags on issuer SUCCEEDED"
  echo ""
  echo "  UNEXPECTED: The issuer was able to modify its own trustline flags."
  echo "  This contradicts the Soroban behavior where set_authorized(issuer)"
  echo "  fails with 'issuer doesn't have a trustline'."
else
  echo "  RESULT: set-trustline-flags on issuer FAILED"
  echo ""
  echo "  As expected: the issuer has no trustline for its own asset,"
  echo "  so there are no flags to modify. Matches Soroban behavior."
fi
echo ""

# -----------------------------------------------
# TEST D: Can the issuer create a trustline to itself?
# -----------------------------------------------
echo "=============================================="
echo " TEST D: Issuer creates trustline to itself"
echo "=============================================="
echo ""
echo "  What if we try to create a trustline FROM the issuer TO itself?"
echo "  If this worked, we could then freeze it. But Stellar shouldn't"
echo "  allow an issuer to trust its own asset."
echo ""
echo "  Attempting change-trust from issuer for own asset..."
echo ""

RESULT_D=$(stellar tx new change-trust \
  --source-account issuer-test \
  --line "$ASSET" \
  --network "$NETWORK" 2>&1) && TX_D_SUCCESS=true || TX_D_SUCCESS=false

echo "$RESULT_D"
echo ""

if [ "$TX_D_SUCCESS" = true ]; then
  echo "  RESULT: Issuer self-trustline SUCCEEDED"
  echo ""
  echo "  UNEXPECTED: The issuer created a trustline for its own asset."
  echo "  This opens the door to freezing the issuer — try it next."
else
  echo "  RESULT: Issuer self-trustline FAILED"
  echo ""
  echo "  As expected: an issuer cannot create a trustline for its own asset."
  echo "  The issuer is fundamentally immune to authorization controls."
fi
echo ""

# -----------------------------------------------
# TEST E: After failed freeze, verify issuer still functions normally
# -----------------------------------------------
echo "=============================================="
echo " TEST E: Verify issuer operations after failed freeze"
echo "=============================================="
echo ""
echo "  Confirm that the failed freeze attempts didn't corrupt"
echo "  the issuer's state. Issuer should still be able to:"
echo "  1. Send tokens (mint) to holder"
echo "  2. Receive tokens from holder (un-issue)"
echo ""

# E.1: Issuer mints more tokens to holder
SMALL_AMOUNT="1000000000"  # 100 tokens
echo "  [E.1] Issuer sends 100 $ASSET_CODE to holder..."
RESULT_E1=$(stellar tx new payment \
  --source-account issuer-test \
  --destination "$HOLDER_PK" \
  --asset "$ASSET" \
  --amount "$SMALL_AMOUNT" \
  --network "$NETWORK" 2>&1) && TX_E1_SUCCESS=true || TX_E1_SUCCESS=false

if [ "$TX_E1_SUCCESS" = true ]; then
  echo "  Mint after freeze attempt: SUCCEEDED"
else
  echo "  Mint after freeze attempt: FAILED"
  echo "$RESULT_E1"
fi
echo ""

# E.2: Authorized holder sends tokens back to issuer (un-issue)
echo "  [E.2] Authorized holder sends 100 $ASSET_CODE to issuer..."
RESULT_E2=$(stellar tx new payment \
  --source-account holder-test \
  --destination "$ISSUER_PK" \
  --asset "$ASSET" \
  --amount "$SMALL_AMOUNT" \
  --network "$NETWORK" 2>&1) && TX_E2_SUCCESS=true || TX_E2_SUCCESS=false

if [ "$TX_E2_SUCCESS" = true ]; then
  echo "  Send-to-issuer after freeze attempt: SUCCEEDED"
  echo "  (Issuer still exempt from AUTH_REQUIRED — no change)"
else
  echo "  Send-to-issuer after freeze attempt: FAILED"
  echo "$RESULT_E2"
fi
echo ""

# -----------------------------------------------
# TEST F: Third party tries to freeze the issuer
# -----------------------------------------------
echo "=============================================="
echo " TEST F: Third party tries to freeze the issuer"
echo "=============================================="
echo ""
echo "  What if a different account tries set-trustline-flags on the"
echo "  issuer? Only the issuer can call set-trustline-flags for its"
echo "  own asset, but let's confirm the holder can't freeze the issuer."
echo ""

RESULT_F=$(stellar tx new set-trustline-flags \
  --source-account holder-test \
  --trustor "$ISSUER_PK" \
  --asset "$ASSET" \
  --clear-authorize \
  --network "$NETWORK" 2>&1) && TX_F_SUCCESS=true || TX_F_SUCCESS=false

echo "$RESULT_F"
echo ""

if [ "$TX_F_SUCCESS" = true ]; then
  echo "  RESULT: Third-party freeze of issuer SUCCEEDED"
  echo "  UNEXPECTED: A non-issuer could modify issuer trustline flags."
else
  echo "  RESULT: Third-party freeze of issuer FAILED"
  echo "  As expected: only the issuer can call set-trustline-flags"
  echo "  for its own asset, and even the issuer can't freeze itself."
fi
echo ""

# -----------------------------------------------
# Step 17: Check final balances
# -----------------------------------------------
echo ""
echo "=============================================="
echo " FINAL BALANCES"
echo "=============================================="
echo ""

echo "[17/18] Holder:"
curl -s "$HORIZON/accounts/$HOLDER_PK" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for b in data.get('balances', []):
    if b.get('asset_code') == '$ASSET_CODE':
        print(f\"  Balance: {b['balance']} $ASSET_CODE\")
        print(f\"  Authorized: {b.get('is_authorized', 'N/A')}\")
" 2>/dev/null || echo "  (could not parse)"

echo ""
echo "Issuer (should always be 0 — issuer can't hold own asset):"
curl -s "$HORIZON/accounts/$ISSUER_PK" | python3 -c "
import sys, json
data = json.load(sys.stdin)
found = False
for b in data.get('balances', []):
    if b.get('asset_code') == '$ASSET_CODE':
        print(f\"  Balance: {b['balance']} $ASSET_CODE\")
        found = True
if not found:
    print('  No trustline (expected — issuer never holds own asset)')
" 2>/dev/null || echo "  (could not parse)"

# -----------------------------------------------
# Step 18: Summary
# -----------------------------------------------
echo ""
echo "=============================================="
echo " [18/18] SUMMARY"
echo "=============================================="
echo ""
echo "  --- Original Tests ---"
echo "  Test A (authorized send-to-issuer):    $([ "$TX_A_SUCCESS" = true ] && echo 'SUCCEEDED' || echo 'FAILED')"
echo "  Test B (frozen send-to-issuer):        $([ "$TX_B_SUCCESS" = true ] && echo 'SUCCEEDED' || echo 'FAILED')"
echo ""
echo "  --- Freeze-the-Issuer Tests ---"
echo "  Test C (freeze issuer via flags):      $([ "$TX_C_SUCCESS" = true ] && echo 'SUCCEEDED' || echo 'FAILED')"
echo "  Test D (issuer self-trustline):        $([ "$TX_D_SUCCESS" = true ] && echo 'SUCCEEDED' || echo 'FAILED')"
echo "  Test E.1 (mint after freeze attempt):  $([ "$TX_E1_SUCCESS" = true ] && echo 'SUCCEEDED' || echo 'FAILED')"
echo "  Test E.2 (send-to-issuer still works): $([ "$TX_E2_SUCCESS" = true ] && echo 'SUCCEEDED' || echo 'FAILED')"
echo "  Test F (third-party freeze issuer):    $([ "$TX_F_SUCCESS" = true ] && echo 'SUCCEEDED' || echo 'FAILED')"
echo ""

# Evaluate freeze-issuer findings
if [ "$TX_C_SUCCESS" = false ] && [ "$TX_D_SUCCESS" = false ]; then
  echo "  FREEZE-ISSUER CONCLUSION:"
  echo "  The issuer CANNOT be frozen via Classic Stellar operations."
  echo "  - set-trustline-flags fails (no trustline to modify)"
  echo "  - change-trust fails (issuer can't trust own asset)"
  echo "  This matches the Soroban finding: 'issuer doesn't have a trustline'."
  echo "  The issuer is immune to authorization controls at BOTH layers."
elif [ "$TX_C_SUCCESS" = true ]; then
  echo "  FREEZE-ISSUER CONCLUSION:"
  echo "  UNEXPECTED — set-trustline-flags on issuer SUCCEEDED."
  echo "  This contradicts the Soroban behavior. Investigate further."
fi
echo ""

# Original conclusions
if [ "$TX_A_SUCCESS" = true ] && [ "$TX_B_SUCCESS" = false ]; then
  echo "  SEND-TO-ISSUER CONCLUSION:"
  echo "  Authorized users CAN send to issuer (un-issue),"
  echo "  but frozen users CANNOT. Freezing the SENDER is effective"
  echo "  at blocking the send-to-issuer bypass via Classic PaymentOp."
  echo "  Freezing the ISSUER is not possible and not needed."
elif [ "$TX_A_SUCCESS" = true ] && [ "$TX_B_SUCCESS" = true ]; then
  echo "  SEND-TO-ISSUER CONCLUSION:"
  echo "  Both authorized AND frozen users can send to issuer."
  echo "  Freezing does NOT block send-to-issuer via Classic PaymentOp."
  echo "  This is a potential desync vector!"
elif [ "$TX_A_SUCCESS" = false ] && [ "$TX_B_SUCCESS" = false ]; then
  echo "  SEND-TO-ISSUER CONCLUSION:"
  echo "  NEITHER authorized NOR frozen users can send to issuer."
  echo "  AUTH_REQUIRED blocks ALL send-to-issuer payments."
fi

echo ""
echo "=============================================="
echo " TEST COMPLETE"
echo "=============================================="
