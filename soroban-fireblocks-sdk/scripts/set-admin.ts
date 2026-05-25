/**
 * Rotate the wrapper contract's admin to a new address.
 *
 * Edit the VARS block below for this specific execution, then run:
 *   npm run set-admin
 *
 * Preflight asserts that the on-chain admin matches VAULT_PUBLIC_KEY, so a
 * misconfigured pubkey fails before we sign anything. Postcheck confirms
 * the rotation actually landed on-chain.
 *
 * Requires in .env: SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE, HORIZON_URL,
 * FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_PATH, FIREBLOCKS_ASSET_ID,
 * FIREBLOCKS_BASE_PATH (optional), CONTRACT_ID.
 *
 * NOTE: This rotates the WRAPPER contract's admin role. It does NOT transfer
 * SAC admin — for that, see transfer_sac_admin (irreversible).
 */

import * as dotenv from "dotenv";
import { SctokenFireblocksClient } from "../src/sctoken-client";
import { assertStellarAddress, buildSigningConfig, requireEnv } from "./lib/config";
import { confirm } from "./lib/confirm";
import { printResult } from "./lib/result";

dotenv.config();

// ─── VARS — edit before running ─────────────────────────────────────────
const NEW_ADMIN = "";
const VAULT_ACCOUNT_ID = "";
const VAULT_PUBLIC_KEY = "";
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const newAdmin = assertStellarAddress(NEW_ADMIN, "NEW_ADMIN");
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
        `You can only rotate the admin from the current admin's key. Fix the VARS block.`,
    );
  }

  console.log("=== Rotate admin ===");
  console.log(`  Contract:   ${contractId}`);
  console.log(`  From:       ${vaultPubkey} (vault ${VAULT_ACCOUNT_ID})`);
  console.log(`  To:         ${newAdmin}`);
  console.log();

  if (!(await confirm(`Rotate admin of ${contractId} from ${vaultPubkey} → ${newAdmin}?`))) {
    console.log("Aborted.");
    return;
  }

  const result = await client.setAdmin({ contractId, newAdmin });
  printResult(result);

  const updatedAdmin = await client.queryAdmin({ contractId });
  if (updatedAdmin !== newAdmin) {
    throw new Error(
      `setAdmin returned SUCCESS but on-chain admin is ${updatedAdmin} (expected ${newAdmin}) — investigate on-chain`,
    );
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
