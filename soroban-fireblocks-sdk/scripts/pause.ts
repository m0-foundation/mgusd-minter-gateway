/**
 * Pause a wrapper contract. Blocks mint / burn / force_transfer / claim_yield
 * until `unpause` is called.
 *
 * Required env (PAUSER role):
 *   PAUSER_PUBLIC_KEY, PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID,
 *   FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_KEY_PATH,
 *   SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE
 *
 * Preflight asserts that the on-chain pauser matches PAUSER_PUBLIC_KEY, so a
 * misconfigured PAUSER_PUBLIC_KEY fails before we sign anything.
 *
 * Usage:
 *   npm run pause -- --contract C...
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

  const config = loadConfigForRole("PAUSER");
  const client = new SctokenFireblocksClient(config);

  const onChainPauser = await client.queryPauser({ contractId });
  if (onChainPauser !== config.sourcePublicKey) {
    throw new Error(
      `Pauser mismatch: on-chain pauser is ${onChainPauser}, but PAUSER_PUBLIC_KEY is ${config.sourcePublicKey}. ` +
        `Rotate the contract pauser or update PAUSER_PUBLIC_KEY / PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID.`,
    );
  }

  if (!(await confirm(`PAUSE ${contractId}? Mint / burn / force_transfer / claim_yield will be blocked.`))) {
    console.log("Aborted.");
    return;
  }

  const result = await client.pause({ contractId, caller: config.sourcePublicKey });
  printResult(result);

  const paused = await client.queryPaused({ contractId });
  if (!paused) {
    throw new Error("pause() returned SUCCESS but `paused()` is still false — investigate on-chain");
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
