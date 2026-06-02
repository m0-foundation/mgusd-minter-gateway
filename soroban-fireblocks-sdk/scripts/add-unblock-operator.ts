/**
 * Add an unblock operator to the wrapper contract.
 *
 * Edit the VARS block below for this specific execution, then run:
 *   npm run add-unblock-operator
 *
 * Signed by the contract Admin (Fireblocks vault 18). Preflight asserts that
 * the on-chain admin matches VAULT_PUBLIC_KEY so a misconfigured signer fails
 * before we sign anything. Idempotent: if OPERATOR_TO_ADD is already an
 * unblock operator, the contract no-ops (no event emitted).
 *
 * Requires in .env: SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE, HORIZON_URL,
 * FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_PATH, FIREBLOCKS_ASSET_ID,
 * FIREBLOCKS_BASE_PATH (optional), CONTRACT_ID.
 */

import * as dotenv from "dotenv";
import { SctokenFireblocksClient } from "../src/sctoken-client";
import { assertStellarAddress, buildSigningConfig, requireEnv } from "./lib/config";
import { confirm } from "./lib/confirm";
import { printResult } from "./lib/result";

dotenv.config();

// ─── VARS — edit before running ─────────────────────────────────────────
// New unblock operator to grant unblock permission to (Predicate).
const OPERATOR_TO_ADD = "GCDJXKIZODN7SISUQYLIP2PDIRAGASCGV7P62ABEJE7M7ISAZVHD6SFL";

// Admin signer — Fireblocks "Stellar Admin" vault 18.
const VAULT_ACCOUNT_ID = "18";
const VAULT_PUBLIC_KEY = "GBXLWT4SZ3GMM4K5UYGQWAQ5VF4O5RLBUOHZY6AGGL4WN7MO3ZIZTVHY";
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const newOperator = assertStellarAddress(OPERATOR_TO_ADD, "OPERATOR_TO_ADD");
  const vaultPubkey = assertStellarAddress(VAULT_PUBLIC_KEY, "VAULT_PUBLIC_KEY");
  if (!VAULT_ACCOUNT_ID) {
    console.error("VAULT_ACCOUNT_ID is required — set it in the VARS block");
    process.exit(1);
  }

  const config = buildSigningConfig(VAULT_ACCOUNT_ID, vaultPubkey);
  const client = new SctokenFireblocksClient(config);

  const onChainAdmin = await client.queryAdmin({ contractId });
  if (onChainAdmin !== vaultPubkey) {
    throw new Error(
      `Admin mismatch: on-chain admin is ${onChainAdmin}, but VAULT_PUBLIC_KEY is ${vaultPubkey}. ` +
        `Only the admin can add an unblock operator. Fix the VARS block or rotate the admin first.`,
    );
  }

  const alreadyOperator = await client.queryIsUnblockOperator({ contractId, account: newOperator });

  console.log("=== Add unblock operator ===");
  console.log(`  Contract:     ${contractId}`);
  console.log(`  Admin:        ${vaultPubkey} (vault ${VAULT_ACCOUNT_ID})`);
  console.log(`  New operator: ${newOperator}`);
  console.log(`  Currently an unblock operator? ${alreadyOperator ? "YES (call will be a no-op)" : "no"}`);
  console.log();

  if (alreadyOperator) {
    console.log("Already an unblock operator — nothing to do. Exiting.");
    return;
  }

  if (!(await confirm(`Grant unblock permission on ${contractId} to ${newOperator}?`))) {
    console.log("Aborted.");
    return;
  }

  const result = await client.addUnblockOperator({ contractId, addr: newOperator });
  printResult(result);

  const nowOperator = await client.queryIsUnblockOperator({ contractId, account: newOperator });
  if (!nowOperator) {
    throw new Error(
      "add_unblock_operator returned SUCCESS but is_unblock_operator() still returns false — investigate on-chain",
    );
  }
  console.log(`✓ Verified: ${newOperator} is now an unblock operator.`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
