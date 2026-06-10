/**
 * Block a single user on a wrapper contract.
 *
 * Edit the VARS block below for this specific execution, then run:
 *   npm run block-user
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
const USER_TO_BLOCK = "";
const SOURCE = ""; // block source the caller is the registered blocker for (e.g. "bridge_compliance")
const VAULT_ACCOUNT_ID = "";
const VAULT_PUBLIC_KEY = "";
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const user = assertStellarAddress(USER_TO_BLOCK, "USER_TO_BLOCK");
  const vaultPubkey = assertStellarAddress(VAULT_PUBLIC_KEY, "VAULT_PUBLIC_KEY");
  if (!SOURCE) {
    console.error("SOURCE is required — set the block source in the VARS block");
    process.exit(1);
  }
  if (!VAULT_ACCOUNT_ID) {
    console.error("VAULT_ACCOUNT_ID is required — set it in the VARS block");
    process.exit(1);
  }

  const config = buildSigningConfig(VAULT_ACCOUNT_ID, vaultPubkey);

  console.log("=== Block user ===");
  console.log(`  Contract:   ${contractId}`);
  console.log(`  Blocking:   ${user}`);
  console.log(`  Source:     ${SOURCE}`);
  console.log(`  Blocker:    ${vaultPubkey} (vault ${VAULT_ACCOUNT_ID})`);
  console.log();

  if (!(await confirm(`Proceed?`))) {
    console.log("Aborted.");
    return;
  }

  const client = new SctokenFireblocksClient(config);
  const result = await client.blockUser({ contractId, caller: vaultPubkey, user, source: SOURCE });
  printResult(result);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
