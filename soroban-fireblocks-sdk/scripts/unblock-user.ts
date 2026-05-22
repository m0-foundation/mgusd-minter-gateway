/**
 * Unblock a single user on a wrapper contract.
 *
 * Required env (UNBLOCK_OPERATOR role):
 *   UNBLOCK_OPERATOR_PUBLIC_KEY, UNBLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID,
 *   FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_KEY_PATH,
 *   SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE
 *
 * Usage:
 *   npm run unblock-user -- --contract C... --user G...
 *   # or via env:
 *   CONTRACT_ID=C... UNBLOCK_USER=G... npm run unblock-user
 */

import * as dotenv from "dotenv";
import { SctokenFireblocksClient } from "../src/sctoken-client";
import { assertStellarAddress, loadConfigForRole, requireArg } from "./lib/config";
import { confirm } from "./lib/confirm";
import { printResult } from "./lib/result";

dotenv.config();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const contractId = assertStellarAddress(requireArg("contract", "CONTRACT_ID", argv), "contract");
  const user = assertStellarAddress(requireArg("user", "UNBLOCK_USER", argv), "user");

  const config = loadConfigForRole("UNBLOCK_OPERATOR");

  if (!(await confirm(`Unblock ${user} on ${contractId} (operator: ${config.sourcePublicKey})?`))) {
    console.log("Aborted.");
    return;
  }

  const client = new SctokenFireblocksClient(config);
  const result = await client.unblockUser({ contractId, user, operator: config.sourcePublicKey });
  printResult(result);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
