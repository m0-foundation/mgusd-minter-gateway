/**
 * Onboard (first-time activate) a single user on a wrapper contract.
 *
 * The caller must hold the onboarder role. This is a one-way first-time
 * activation — it cannot lift a compliance block. Use `unblock-user` for that.
 *
 * Edit the VARS block below for this specific execution, then run:
 *   npm run onboard-user
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
const USER_TO_ONBOARD = "";
const VAULT_ACCOUNT_ID = "";
const VAULT_PUBLIC_KEY = "";
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const user = assertStellarAddress(USER_TO_ONBOARD, "USER_TO_ONBOARD");
  const vaultPubkey = assertStellarAddress(VAULT_PUBLIC_KEY, "VAULT_PUBLIC_KEY");
  if (!VAULT_ACCOUNT_ID) {
    console.error("VAULT_ACCOUNT_ID is required — set it in the VARS block");
    process.exit(1);
  }

  const config = buildSigningConfig(VAULT_ACCOUNT_ID, vaultPubkey);

  console.log("=== Onboard user ===");
  console.log(`  Contract:   ${contractId}`);
  console.log(`  Onboarding: ${user}`);
  console.log(`  Operator:   ${vaultPubkey} (vault ${VAULT_ACCOUNT_ID})`);
  console.log();

  if (!(await confirm(`Proceed?`))) {
    console.log("Aborted.");
    return;
  }

  const client = new SctokenFireblocksClient(config);
  const result = await client.onboardUser({ contractId, user, operator: vaultPubkey });
  printResult(result);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
