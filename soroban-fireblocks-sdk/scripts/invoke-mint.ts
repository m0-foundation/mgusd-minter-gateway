/**
 * Mint tokens via the SCToken contract.
 *
 * Edit the VARS block below for this specific execution, then run:
 *   npm run mint
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
const MINT_TO = "";
const MINT_AMOUNT = 0n;
const VAULT_ACCOUNT_ID = "";
const VAULT_PUBLIC_KEY = "";
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const to = assertStellarAddress(MINT_TO, "MINT_TO");
  const vaultPubkey = assertStellarAddress(VAULT_PUBLIC_KEY, "VAULT_PUBLIC_KEY");
  if (!VAULT_ACCOUNT_ID) {
    console.error("VAULT_ACCOUNT_ID is required — set it in the VARS block");
    process.exit(1);
  }
  if (MINT_AMOUNT <= 0n) {
    console.error("MINT_AMOUNT must be a positive bigint — set it in the VARS block (e.g., 1000000000n)");
    process.exit(1);
  }

  const config = buildSigningConfig(VAULT_ACCOUNT_ID, vaultPubkey);

  console.log("=== Mint ===");
  console.log(`  Contract:  ${contractId}`);
  console.log(`  To:        ${to}`);
  console.log(`  Amount:    ${MINT_AMOUNT}`);
  console.log(`  Minter:    ${vaultPubkey} (vault ${VAULT_ACCOUNT_ID})`);
  console.log();

  if (!(await confirm(`Proceed?`))) {
    console.log("Aborted.");
    return;
  }

  const client = new SctokenFireblocksClient(config);
  const result = await client.mint({ contractId, caller: vaultPubkey, to, amount: MINT_AMOUNT });
  printResult(result);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
