/**
 * Add a pauser to the wrapper contract's multi-pauser membership set.
 *
 * Edit the VARS block below for this specific execution, then run:
 *   npm run add-pauser
 *
 * Signed by the contract Admin (Fireblocks vault 18). Preflight asserts that
 * the on-chain admin matches VAULT_PUBLIC_KEY so a misconfigured signer fails
 * before we sign anything. Idempotent: if PAUSER_TO_ADD is already a pauser,
 * the contract no-ops (no event emitted).
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
// New pauser to grant pause permission to (Bridge pauser).
const PAUSER_TO_ADD = "GBT2YM25S3TSORSVV3TTMGNSFK6ZELMLTRFFSRNGKTBAXQFUUSJN5XBX";

// Admin signer — Fireblocks "Stellar Admin" vault 18.
const VAULT_ACCOUNT_ID = "18";
const VAULT_PUBLIC_KEY = "GBXLWT4SZ3GMM4K5UYGQWAQ5VF4O5RLBUOHZY6AGGL4WN7MO3ZIZTVHY";
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const newPauser = assertStellarAddress(PAUSER_TO_ADD, "PAUSER_TO_ADD");
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
        `Only the admin can add a pauser. Fix the VARS block or rotate the admin first.`,
    );
  }

  const alreadyPauser = await client.queryIsPauser({ contractId, account: newPauser });

  console.log("=== Add pauser ===");
  console.log(`  Contract:   ${contractId}`);
  console.log(`  Admin:      ${vaultPubkey} (vault ${VAULT_ACCOUNT_ID})`);
  console.log(`  New pauser: ${newPauser}`);
  console.log(`  Currently a pauser? ${alreadyPauser ? "YES (call will be a no-op)" : "no"}`);
  console.log();

  if (alreadyPauser) {
    console.log("Already a pauser — nothing to do. Exiting.");
    return;
  }

  if (!(await confirm(`Grant pause permission on ${contractId} to ${newPauser}?`))) {
    console.log("Aborted.");
    return;
  }

  const result = await client.addPauser({ contractId, addr: newPauser });
  printResult(result);

  const nowPauser = await client.queryIsPauser({ contractId, account: newPauser });
  if (!nowPauser) {
    throw new Error("add_pauser returned SUCCESS but is_pauser() still returns false — investigate on-chain");
  }
  console.log(`✓ Verified: ${newPauser} is now a pauser.`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
