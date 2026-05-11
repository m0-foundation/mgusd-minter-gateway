#!/usr/bin/env bash
#
# deploy-testnet.sh
#
# 5-step (+ optional Step 6 lock) deploy pipeline for the Stellar Minter
# Gateway contract. Works for testnet/dev AND production: the only
# difference is whether ISSUER_KEY_NAME resolves to a hot key (testnet
# convenience) or a cold-key signer (Ledger via `stellar keys add
# --ledger`), and whether LOCK_ISSUER=true is set to permanently retire
# the issuer signer after the SAC admin handoff.
#
# Both signing identities (ISSUER and DEPLOYER) are resolved through
# `stellar keys`. The two-identity structure (issuer signs steps 1+5+6,
# deployer signs steps 2-4) keeps fee-paying and privileged-signing
# concerns separated.
#
# =============================================================================
# SIGNING MODEL — two identities
# =============================================================================
#
#   ISSUER
#     The asset issuer's Stellar account. For production this should
#     resolve to a cold-key signer (Ledger, or another out-of-band
#     signer). Signs ONLY the steps that require issuer authority:
#       - Step 1: set_options on the issuer account (auth flags)
#       - Step 5: set_admin on the SAC (the issuer is initial SAC admin)
#       - Step 6: set_options (master_weight=0)  [opt-in via LOCK_ISSUER]
#     After Step 6, the issuer key is inert — all ongoing authority
#     flows through the wrapper (SAC admin), so the key can be destroyed.
#
#   DEPLOYER
#     A funded operational keypair. Has no privileged relationship to the
#     asset — only pays fees and signs the protocol-permissionless deploy
#     ops. A throwaway keypair is fine; it gains no power over the
#     resulting contract (the wrapper's __constructor takes role addresses
#     explicitly).
#     Signs:
#       - Step 2: SAC deploy for the asset
#       - Step 3: WASM upload
#       - Step 4: wrapper contract deploy + init
#       - smoke / verify reads (no state change)
#
# For testnet / dev, you can reuse the deployer identity as issuer by
# pointing ISSUER_KEY_NAME and DEPLOYER_KEY_NAME at the same `stellar
# keys` identity. For mainnet, they should be distinct.
#
# =============================================================================
# ORDER OF OPERATIONS (per address)
# =============================================================================
#
#   ISSUER     ──────[1]────────────────────────[5]──[6?]──
#   DEPLOYER   ────────[2]──[3]──[4]──────────────[smoke]──[verify?]
#
#   1. [ISSUER]    set_options(AUTH_REQUIRED + REVOCABLE + CLAWBACK_ENABLED)
#   2. [DEPLOYER]  stellar contract asset deploy --asset CODE:ISSUER
#   3. [DEPLOYER]  stellar contract upload --wasm <wrapper.wasm>
#   4. [DEPLOYER]  stellar contract deploy --wasm-hash <hash> + __constructor
#   5. [ISSUER]    SAC.set_admin(wrapper)
#   6. [ISSUER]    set_options(master_weight=0, thresholds=0/0/0
#                              [+ AUTH_IMMUTABLE])              [opt-in]
#                  Permanently retires the issuer signer. After this op
#                  the issuer account has no live signers; all authority
#                  over mint/burn/auth flows through the wrapper. Recovery
#                  paths that depend on the issuer key cease to exist —
#                  this is the point.
#   smoke. [DEPLOYER]  read wrapper.admin() — verifies handoff landed
#   verify. [Horizon read, no signing] confirms master_weight=0,
#                                      thresholds=0/0/0, no extra signers,
#                                      and AUTH_IMMUTABLE if requested.
#
# Note: this pipeline mints ZERO tokens. Token supply is created later by
# the bridge / minter role calling `wrapper.mint(minter, to, amount)` after
# this script completes. This script only stands up the infrastructure.
#
# =============================================================================
# WHY THE LOCK STEP (security model rationale)
# =============================================================================
#
# After Step 5 the wrapper is the SAC admin. All operational authority
# (mint, burn, force-transfer, set_authorized for block/unblock,
# clawback, claim_yield, set_admin migration) flows through the wrapper.
# The issuer Stellar account has no remaining operational role — it
# cannot mint via SAC, cannot authorize trustlines (the wrapper does
# that via SAC.set_authorized), and the only thing it can still do is
# clear its own auth flags or be merged.
#
# Step 6 closes those last two affordances by zeroing the master key
# weight (and, with LOCK_ISSUER_SET_IMMUTABLE=true, setting AUTH_IMMUTABLE).
# Once locked, the asset is *immutable at the issuer level*: there is
# no key — anywhere — that can change AUTH_REQUIRED/REVOCABLE/CLAWBACK
# or merge the issuer account.
#
# This eliminates the need for ongoing custody of the issuer key (no
# Fireblocks vault, no Ledger that has to survive personnel changes).
# In exchange, you accept that the lock is irreversible: if the deploy
# completed but later proves misconfigured, you cannot fix it from the
# issuer side — only from the wrapper, via wrapper-level migration.
#
# Lock OPT-IN, not opt-out. Default is *not* to lock, so dev/testnet
# redeploys against the same issuer keep working. Set LOCK_ISSUER=true
# for production deploys.
#
# =============================================================================
# PREREQUISITES (out-of-band, NOT done by this script)
# =============================================================================
#
#   - ISSUER account must exist on the network and be funded with XLM.
#       Testnet: curl "https://friendbot.stellar.org?addr=$ISSUER_PUBLIC_KEY"
#       Other networks: fund the account out-of-band before running.
#   - DEPLOYER account must exist on the network and be funded.
#   - Wrapper WASM must be built (`make build` from repo root).
#   - The asset (CODE, ISSUER) must NOT already have any holders, pre-set
#     issuer flags, or trustlines. This is an audit safety property
#     (STEL1-6: deploying onto a "dirty" issuer can bypass AUTH_REQUIRED).
#     This script does NOT verify the issuer is clean — verify manually
#     before running.
#
# =============================================================================
# REQUIRED ENV VARS
# =============================================================================
#
#   Signing identities (`stellar keys` identity NAMES, not pubkeys):
#     ISSUER_KEY_NAME               — identity that controls the issuer account
#     DEPLOYER_KEY_NAME             — identity for the deployer; pays fees on 2,3,4
#                                     (may equal ISSUER_KEY_NAME for testnet/dev)
#
#   Issuer account public key (G...):
#     ISSUER_PUBLIC_KEY             — must be the pubkey behind ISSUER_KEY_NAME
#
#   Wrapper role pubkeys (G...):  (STEL1-5: each role gets its own env var)
#     ADMIN_PUBLIC_KEY                       — top-level authority (M0)
#     MINTER_PUBLIC_KEY                      — bridge / minter
#     YIELD_RECIPIENT_MANAGER_PUBLIC_KEY     — rotates yield recipient
#     YIELD_RECIPIENT_PUBLIC_KEY             — receives claim_yield mints
#     FORCED_TRANSFER_MANAGER_PUBLIC_KEY     — compliance forced transfers
#     BLOCK_OPERATOR_PUBLIC_KEY              — initial block operator
#     UNBLOCK_OPERATOR_PUBLIC_KEY            — initial unblock operator
#     PAUSER_PUBLIC_KEY                      — pauser of record
#
# =============================================================================
# OPTIONAL ENV VARS
# =============================================================================
#
#   ASSET_CODE                  — defaults to TMGUSD
#   STELLAR_NETWORK             — defaults to testnet
#   WASM_PATH                   — defaults to ./target/wasm32v1-none/release/mintergateway.wasm
#   LOCK_ISSUER                 — "true" to run Step 6 (irreversible). Default: unset (skip lock).
#   LOCK_ISSUER_SET_IMMUTABLE   — "true" to also set AUTH_IMMUTABLE during the
#                                 lock op. Default: "true" when LOCK_ISSUER=true.
#                                 Defense in depth: even if the master key
#                                 somehow recovered, AUTH_IMMUTABLE prevents
#                                 the auth flags from ever being changed and
#                                 prevents the issuer from being merged.
#   HORIZON_URL                 — Horizon endpoint for the post-lock verifier.
#                                 Auto-derived for testnet/public/futurenet;
#                                 required for any other STELLAR_NETWORK value.
#
# =============================================================================

set -euo pipefail

# Auto-load .env from the repo root if present. Robust to PWD — found
# relative to the script's own location. Template lives at
# scripts/deploy.env.example.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
  echo "Loading $REPO_ROOT/.env"
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

ASSET_CODE="${ASSET_CODE:-TMGUSD}"
STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
WASM_PATH="${WASM_PATH:-./target/wasm32v1-none/release/mintergateway.wasm}"

# LOCK_ISSUER: opt-in for Step 6 (permanent issuer key retirement). Empty
# / "false" / "0" → skip the lock step. Anything else → run it.
# (`tr` is used for case folding because `${var,,}` is bash 4+ and macOS
# ships bash 3.2.)
LOCK_ISSUER_RAW="${LOCK_ISSUER:-}"
LOCK_ISSUER_LC=$(printf '%s' "$LOCK_ISSUER_RAW" | tr '[:upper:]' '[:lower:]')
case "$LOCK_ISSUER_LC" in
  ""|"false"|"0"|"no") LOCK_ISSUER=false ;;
  "true"|"1"|"yes")    LOCK_ISSUER=true ;;
  *)
    echo "ERROR: LOCK_ISSUER must be one of: true, false, 1, 0, yes, no (got: $LOCK_ISSUER_RAW)" >&2
    exit 1
    ;;
esac

# LOCK_ISSUER_SET_IMMUTABLE: when locking, also set AUTH_IMMUTABLE on the
# issuer (defense in depth — freezes auth flags and prevents merge).
# Default true when LOCK_ISSUER=true; ignored otherwise.
LOCK_ISSUER_SET_IMMUTABLE_RAW="${LOCK_ISSUER_SET_IMMUTABLE:-true}"
LOCK_ISSUER_SET_IMMUTABLE_LC=$(printf '%s' "$LOCK_ISSUER_SET_IMMUTABLE_RAW" | tr '[:upper:]' '[:lower:]')
case "$LOCK_ISSUER_SET_IMMUTABLE_LC" in
  "true"|"1"|"yes")    LOCK_ISSUER_SET_IMMUTABLE=true ;;
  "false"|"0"|"no")    LOCK_ISSUER_SET_IMMUTABLE=false ;;
  *)
    echo "ERROR: LOCK_ISSUER_SET_IMMUTABLE must be one of: true, false, 1, 0, yes, no (got: $LOCK_ISSUER_SET_IMMUTABLE_RAW)" >&2
    exit 1
    ;;
esac

# Horizon URL — only needed when LOCK_ISSUER=true (for the pre-/post-lock
# verifier). Auto-derived for the well-known networks; required for custom.
derive_horizon_url() {
  case "$STELLAR_NETWORK" in
    testnet)   echo "https://horizon-testnet.stellar.org"   ;;
    public)    echo "https://horizon.stellar.org"           ;;
    futurenet) echo "https://horizon-futurenet.stellar.org" ;;
    *)         echo "" ;;
  esac
}
HORIZON_URL="${HORIZON_URL:-$(derive_horizon_url)}"

require_pubkey() {
  local name="$1"
  local val="${!name:-}"
  if [[ -z "$val" ]]; then
    echo "ERROR: missing required env var: $name" >&2
    exit 1
  fi
  if [[ ! "$val" =~ ^G[A-Z2-7]{55}$ ]]; then
    echo "ERROR: $name is not a valid Stellar pubkey: $val" >&2
    exit 1
  fi
  echo "$val"
}

require_var() {
  local name="$1"
  local val="${!name:-}"
  if [[ -z "$val" ]]; then
    echo "ERROR: missing required env var: $name" >&2
    exit 1
  fi
  echo "$val"
}

# Issuer-side
ISSUER=$(require_pubkey ISSUER_PUBLIC_KEY)
ISSUER_KEY=$(require_var ISSUER_KEY_NAME)

# Deployer-side
DEPLOYER_KEY=$(require_var DEPLOYER_KEY_NAME)

# Wrapper roles (STEL1-5: each role read independently)
ADMIN=$(require_pubkey ADMIN_PUBLIC_KEY)
MINTER=$(require_pubkey MINTER_PUBLIC_KEY)
YRM=$(require_pubkey YIELD_RECIPIENT_MANAGER_PUBLIC_KEY)
YR=$(require_pubkey YIELD_RECIPIENT_PUBLIC_KEY)
FTM=$(require_pubkey FORCED_TRANSFER_MANAGER_PUBLIC_KEY)
BLOCK_OP=$(require_pubkey BLOCK_OPERATOR_PUBLIC_KEY)
UNBLOCK_OP=$(require_pubkey UNBLOCK_OPERATOR_PUBLIC_KEY)
PAUSER=$(require_pubkey PAUSER_PUBLIC_KEY)

if [[ ! -f "$WASM_PATH" ]]; then
  echo "ERROR: WASM not found at $WASM_PATH — run 'make build' first" >&2
  exit 1
fi

# When locking, the verifier depends on `curl` + `jq` and a Horizon URL.
# Fail fast (before any tx fires) if any of these are missing.
if [[ "$LOCK_ISSUER" == "true" ]]; then
  for tool in curl jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "ERROR: LOCK_ISSUER=true requires '$tool' on PATH (used by the post-lock verifier)" >&2
      exit 1
    fi
  done
  if [[ -z "$HORIZON_URL" ]]; then
    echo "ERROR: LOCK_ISSUER=true with custom STELLAR_NETWORK ($STELLAR_NETWORK) requires HORIZON_URL to be set explicitly." >&2
    exit 1
  fi
fi

# Consistency check: the pubkey behind ISSUER_KEY_NAME must match
# ISSUER_PUBLIC_KEY. A mismatch would deploy the SAC for one issuer
# while signing set_options/set_admin with a different key — silently
# misconfigured asset. Hard-fail before any tx fires.
ISSUER_KEY_PUBKEY=$(stellar keys public-key "$ISSUER_KEY" 2>/dev/null | tr -d '\r\n' || true)
if [[ -z "$ISSUER_KEY_PUBKEY" ]]; then
  echo "ERROR: \`stellar keys public-key $ISSUER_KEY\` returned no pubkey." >&2
  echo "       Verify the identity exists: \`stellar keys ls\`" >&2
  exit 1
fi
if [[ "$ISSUER_KEY_PUBKEY" != "$ISSUER" ]]; then
  echo "ERROR: ISSUER_PUBLIC_KEY does not match the pubkey behind ISSUER_KEY_NAME." >&2
  echo "       ISSUER_PUBLIC_KEY=$ISSUER" >&2
  echo "       \`stellar keys public-key $ISSUER_KEY\`=$ISSUER_KEY_PUBKEY" >&2
  echo "       Fix .env so the two match before re-running." >&2
  exit 1
fi

echo "=== Stellar Minter Gateway — Deploy ==="
echo "  Network:                 $STELLAR_NETWORK"
echo "  Asset:                   $ASSET_CODE"
echo "  WASM:                    $WASM_PATH ($(wc -c < "$WASM_PATH") bytes)"
echo ""
echo "  Signing identities:"
echo "    ISSUER (steps 1,5,6):  $ISSUER_KEY  (pubkey: $ISSUER)"
echo "    DEPLOYER (steps 2-4):  $DEPLOYER_KEY"
if [[ "$ISSUER_KEY" == "$DEPLOYER_KEY" ]]; then
  echo "    NOTE: deployer == issuer (single-signer mode — testnet/dev only)"
fi
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
echo "  Issuer lock (Step 6):"
if [[ "$LOCK_ISSUER" == "true" ]]; then
  echo "    LOCK_ISSUER=true       — issuer will be PERMANENTLY retired after Step 5"
  echo "    AUTH_IMMUTABLE:        $LOCK_ISSUER_SET_IMMUTABLE"
  echo "    HORIZON_URL:           $HORIZON_URL"
else
  echo "    LOCK_ISSUER=false      — Step 6 SKIPPED (issuer key remains a live signer)"
fi
echo ""

UNIQUE_ROLES=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$ADMIN" "$MINTER" "$YRM" "$YR" "$FTM" "$BLOCK_OP" "$UNBLOCK_OP" "$PAUSER" \
  | sort -u | wc -l | tr -d ' ')
if [[ "$UNIQUE_ROLES" -lt 8 ]]; then
  echo "WARNING: multiple roles share the same pubkey — role separation is reduced ($UNIQUE_ROLES distinct)"
  echo ""
fi

# -----------------------------------------------------------------------------
# Step 1 — [ISSUER signs]
# Configure issuer flags. Must run BEFORE any trustline to (CODE,ISSUER)
# exists, otherwise that trustline auto-authorizes and falls outside the
# compliance model. The asset itself doesn't need to be "created" — it
# comes into existence implicitly when first referenced.
# -----------------------------------------------------------------------------
echo "[1/5] [ISSUER] set_options on issuer account..."
stellar tx new set-options \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --set-required \
  --set-revocable \
  --set-clawback-enabled
echo "      done."
echo ""

# -----------------------------------------------------------------------------
# Step 2 — [DEPLOYER signs]
# Deploy the SAC contract for (CODE, ISSUER). The SAC contract address is
# deterministically derived from the asset, so this op is permissionless —
# any funded account can run it. The SAC's initial admin is the issuer
# (transferred to the wrapper in step 5). No tokens are minted.
# -----------------------------------------------------------------------------
echo "[2/5] [DEPLOYER] Deploying SAC for $ASSET_CODE:$ISSUER..."
SAC_CONTRACT_ID=$(stellar contract asset deploy \
  --source-account "$DEPLOYER_KEY" \
  --network "$STELLAR_NETWORK" \
  --asset "$ASSET_CODE:$ISSUER" \
  | tr -d '\r\n')
echo "      SAC contract ID: $SAC_CONTRACT_ID"
echo ""

# -----------------------------------------------------------------------------
# Step 3 — [DEPLOYER signs]
# Upload the wrapper WASM bytecode to the ledger. Permissionless; deployer
# pays fees. This only registers the WASM by hash — it does not instantiate
# a contract.
# -----------------------------------------------------------------------------
echo "[3/5] [DEPLOYER] Uploading wrapper WASM..."
WASM_HASH=$(stellar contract upload \
  --source-account "$DEPLOYER_KEY" \
  --network "$STELLAR_NETWORK" \
  --wasm "$WASM_PATH" \
  | tr -d '\r\n')
echo "      WASM hash: $WASM_HASH"
echo ""

# -----------------------------------------------------------------------------
# Step 4 — [DEPLOYER signs]
# Deploy the wrapper contract from the uploaded WASM hash and run its
# __constructor with all 9 args (sac_token + 8 role addresses). The wrapper
# contract address is derived from (deployer, salt). The deployer gains NO
# privilege over the resulting contract — roles are set explicitly here.
# -----------------------------------------------------------------------------
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

# -----------------------------------------------------------------------------
# Step 5 — [ISSUER signs]
# Hand SAC admin from issuer to wrapper. After this, the wrapper is the
# only address that can call mint / burn / clawback / set_authorized on
# the SAC. If LOCK_ISSUER=true, Step 6 below retires the issuer key
# entirely; otherwise the issuer remains the classic-Stellar account
# that can still sign SetTrustLineFlags / Clawback ops directly on
# classic trustlines (legacy hard-freeze flow — usually unused once the
# wrapper owns SAC admin).
# -----------------------------------------------------------------------------
echo "[5/5] [ISSUER] Transferring SAC admin to wrapper..."
stellar contract invoke \
  --source-account "$ISSUER_KEY" \
  --network "$STELLAR_NETWORK" \
  --id "$SAC_CONTRACT_ID" \
  -- \
  set_admin --new_admin "$WRAPPER_CONTRACT_ID"
echo "      done."
echo ""

# -----------------------------------------------------------------------------
# Smoke test — [DEPLOYER signs]
# Read wrapper.admin() back. Read-only — any signer works; deployer is
# convenient since it's already configured. Fails closed if the constructor
# didn't land or if the wrong wrapper address was returned.
# -----------------------------------------------------------------------------
echo "[smoke] [DEPLOYER] Querying wrapper.admin()..."
ADMIN_FROM_CONTRACT=$(stellar contract invoke \
  --source-account "$DEPLOYER_KEY" \
  --network "$STELLAR_NETWORK" \
  --send=no \
  --id "$WRAPPER_CONTRACT_ID" \
  -- \
  admin \
  | tr -d '\r\n"')
echo "      admin() = $ADMIN_FROM_CONTRACT"
if [[ "$ADMIN_FROM_CONTRACT" != "$ADMIN" ]]; then
  echo "ERROR: smoke test failed — wrapper.admin() ($ADMIN_FROM_CONTRACT) != configured ADMIN ($ADMIN)" >&2
  exit 1
fi
echo ""

# -----------------------------------------------------------------------------
# Step 6 (opt-in) — [ISSUER signs]
# Permanently retire the issuer signer.
#
#   set_options(master_weight=0, low/med/high_threshold=0
#               [, AUTH_IMMUTABLE if LOCK_ISSUER_SET_IMMUTABLE=true])
#
# Rationale: after Step 5 the wrapper is SAC admin and there is no
# operational path that needs the issuer key. Zeroing the master weight
# leaves the issuer account with no live signers. AUTH_IMMUTABLE further
# freezes the auth flags and blocks account_merge. The op itself is signed
# by the master key while it still has weight 1 — the lock takes effect
# once the tx lands.
#
# This step is irreversible. There is no recovery from a master_weight=0
# issuer (modulo Stellar protocol changes), so we run a Horizon pre-flight
# to assert the signer set is exactly the master @ weight 1 — defending
# against the deploy host having added rogue signers.
# -----------------------------------------------------------------------------
if [[ "$LOCK_ISSUER" == "true" ]]; then
  echo "[6/6] [ISSUER] Locking issuer (master_weight=0, thresholds=0/0/0$([[ "$LOCK_ISSUER_SET_IMMUTABLE" == "true" ]] && echo ", AUTH_IMMUTABLE"))..."

  # Pre-lock guard — fetch the issuer account state and assert the only
  # signer is the master at weight 1. If a co-signer was added (e.g.,
  # compromised deploy host), zeroing the master weight would NOT lock
  # the account; abort instead of submitting a useless lock op.
  echo "      Pre-lock check: querying $HORIZON_URL/accounts/$ISSUER..."
  PRELOCK_JSON=$(curl --fail --silent --show-error "$HORIZON_URL/accounts/$ISSUER")
  PRELOCK_SIGNER_COUNT=$(echo "$PRELOCK_JSON" | jq '.signers | length')
  PRELOCK_MASTER_WEIGHT=$(echo "$PRELOCK_JSON" | jq --arg key "$ISSUER" \
    '[.signers[] | select(.key == $key)] | .[0].weight // 0')
  if [[ "$PRELOCK_SIGNER_COUNT" != "1" ]]; then
    echo "ERROR: issuer has $PRELOCK_SIGNER_COUNT signers — expected exactly 1 (the master key)." >&2
    echo "       Locking now would leave non-master signers in control. Aborting." >&2
    echo "       Signers:" >&2
    echo "$PRELOCK_JSON" | jq '.signers' >&2
    exit 1
  fi
  if [[ "$PRELOCK_MASTER_WEIGHT" -le 0 ]]; then
    echo "ERROR: issuer master_weight is $PRELOCK_MASTER_WEIGHT — account is already locked or cannot sign. Aborting." >&2
    exit 1
  fi
  echo "      Pre-lock check OK: 1 signer, master_weight=1."

  # Build the lock op. --set-immutable is conditional; everything else is
  # constant.
  LOCK_ARGS=(
    --source-account "$ISSUER_KEY"
    --network "$STELLAR_NETWORK"
    --master-weight 0
    --low-threshold 0
    --med-threshold 0
    --high-threshold 0
  )
  if [[ "$LOCK_ISSUER_SET_IMMUTABLE" == "true" ]]; then
    LOCK_ARGS+=(--set-immutable)
  fi
  stellar tx new set-options "${LOCK_ARGS[@]}"
  echo "      Lock op submitted."

  # Post-lock verifier — re-query Horizon and assert the lock landed.
  # Stellar Horizon may take a moment to surface the new ledger entry;
  # poll up to ~15s.
  echo "      Verifying lock via Horizon..."
  VERIFIED=false
  for attempt in 1 2 3 4 5 6 7 8; do
    POSTLOCK_JSON=$(curl --fail --silent --show-error "$HORIZON_URL/accounts/$ISSUER" || echo "")
    if [[ -n "$POSTLOCK_JSON" ]]; then
      POSTLOCK_MASTER_WEIGHT=$(echo "$POSTLOCK_JSON" | jq --arg key "$ISSUER" \
        '[.signers[] | select(.key == $key)] | .[0].weight // -1')
      POSTLOCK_LOW=$(echo  "$POSTLOCK_JSON" | jq '.thresholds.low_threshold')
      POSTLOCK_MED=$(echo  "$POSTLOCK_JSON" | jq '.thresholds.med_threshold')
      POSTLOCK_HIGH=$(echo "$POSTLOCK_JSON" | jq '.thresholds.high_threshold')
      POSTLOCK_SIGNER_COUNT=$(echo "$POSTLOCK_JSON" | jq '.signers | length')
      POSTLOCK_IMMUTABLE=$(echo "$POSTLOCK_JSON" | jq '.flags.auth_immutable')
      if [[ "$POSTLOCK_MASTER_WEIGHT" == "0" \
         && "$POSTLOCK_LOW" == "0" && "$POSTLOCK_MED" == "0" && "$POSTLOCK_HIGH" == "0" \
         && "$POSTLOCK_SIGNER_COUNT" == "1" ]]; then
        VERIFIED=true
        break
      fi
    fi
    sleep 2
  done
  if [[ "$VERIFIED" != "true" ]]; then
    echo "ERROR: post-lock verification did not converge after 8 polls." >&2
    echo "       Last Horizon response:" >&2
    echo "$POSTLOCK_JSON" | jq '{thresholds, signers, flags}' >&2 || true
    exit 1
  fi
  if [[ "$LOCK_ISSUER_SET_IMMUTABLE" == "true" && "$POSTLOCK_IMMUTABLE" != "true" ]]; then
    echo "ERROR: AUTH_IMMUTABLE was requested but the on-chain flag is not set." >&2
    echo "$POSTLOCK_JSON" | jq '.flags' >&2 || true
    exit 1
  fi
  echo "      Lock verified: master_weight=0, thresholds=0/0/0, signers=1, auth_immutable=$POSTLOCK_IMMUTABLE."
  echo ""
fi

echo "=== Deploy Complete ==="
echo "  SAC Contract ID:     $SAC_CONTRACT_ID"
echo "  WASM Hash:           $WASM_HASH"
echo "  Wrapper Contract ID: $WRAPPER_CONTRACT_ID"
if [[ "$LOCK_ISSUER" == "true" ]]; then
  echo "  Issuer:              $ISSUER  (LOCKED — master_weight=0)"
  echo ""
  echo "  The issuer key (\`stellar keys\` identity \"$ISSUER_KEY\") is now"
  echo "  inert. You can safely destroy it — no future deploy step needs it."
else
  echo "  Issuer:              $ISSUER  (UNLOCKED — re-run with LOCK_ISSUER=true to retire)"
fi
echo ""
echo "  Next: bridge / minter calls wrapper.mint(...) to issue tokens."
