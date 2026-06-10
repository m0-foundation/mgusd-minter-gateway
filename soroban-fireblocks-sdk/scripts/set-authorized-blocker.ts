/**
 * Register (or update) the authorized blocker for a block source on a wrapper
 * contract. Admin only.
 *
 * Each source maps to one authorized blocker address. That blocker can then independently block/unblock
 * users under its source.
 *
 * Edit the VARS block below for this specific execution, then run:
 *   npm run set-authorized-blocker
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
const SOURCE = "";
const BLOCKER = "";
const VAULT_ACCOUNT_ID = "";
const VAULT_PUBLIC_KEY = ""; 
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const blocker = assertStellarAddress(BLOCKER, "BLOCKER");
  const vaultPubkey = assertStellarAddress(VAULT_PUBLIC_KEY, "VAULT_PUBLIC_KEY");
  if (!SOURCE) {
    console.error("SOURCE is required — set the block source name in the VARS block");
    process.exit(1);
  }
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
        `Only the admin can register authorized blockers. Fix the VARS block.`,
    );
  }

  console.log("=== Register authorized blocker ===");
  console.log(`  Contract:   ${contractId}`);
  console.log(`  Source:     ${SOURCE}`);
  console.log(`  Blocker:    ${blocker}`);
  console.log(`  Admin:      ${vaultPubkey} (vault ${VAULT_ACCOUNT_ID})`);
  console.log();

  if (!(await confirm(`Register blocker ${blocker} for source "${SOURCE}"?`))) {
    console.log("Aborted.");
    return;
  }

  const result = await client.setAuthorizedBlocker({ contractId, source: SOURCE, blocker });
  printResult(result);

  const registered = await client.queryGetAuthorizedBlocker({ contractId, source: SOURCE });
  if (registered !== blocker) {
    throw new Error(
      `setAuthorizedBlocker returned SUCCESS but on-chain blocker for "${SOURCE}" is ${registered} ` +
        `(expected ${blocker}) — investigate on-chain`,
    );
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
