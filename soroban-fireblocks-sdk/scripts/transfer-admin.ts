/**
 * Rotate the wrapper contract's admin from the configured Fireblocks ADMIN
 * vault to a new address.
 *
 * Production-grade: source vault is read from .env via the standard ADMIN_*
 * convention (same as scripts/roles.ts). Only the destination — NEW_ADMIN —
 * is set at the top of this file. Edit it, then run:
 *
 *   npm run transfer-admin
 *
 * Preflight asserts the on-chain admin matches ADMIN_PUBLIC_KEY, so a stale
 * .env or wrong-vault config fails before any Fireblocks TAP. Postcheck
 * confirms the rotation actually landed.
 *
 * Requires in .env: SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE, HORIZON_URL,
 * FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_PATH, FIREBLOCKS_ASSET_ID,
 * FIREBLOCKS_BASE_PATH (optional), CONTRACT_ID,
 * ADMIN_PUBLIC_KEY, ADMIN_FIREBLOCKS_VAULT_ACCOUNT_ID.
 *
 * NOTE: This rotates the WRAPPER contract's admin role. It does NOT transfer
 * SAC admin — for that, see transfer_sac_admin (irreversible).
 */

import * as dotenv from "dotenv";
import { SctokenFireblocksClient } from "../src/sctoken-client";
import { assertVaultMatchesPubkey } from "../src/deploy-checks";
import { assertStellarAddress, buildSigningConfig, requireEnv } from "./lib/config";
import { confirm } from "./lib/confirm";
import { printResult } from "./lib/result";

dotenv.config();

// ─── VARS — edit before running ─────────────────────────────────────────
const NEW_ADMIN = "GBT2YM25S3TSORSVV3TTMGNSFK6ZELMLTRFFSRNGKTBAXQFUUSJN5XBX";
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const contractId = assertStellarAddress(requireEnv("CONTRACT_ID"), "CONTRACT_ID");
  const newAdmin = assertStellarAddress(NEW_ADMIN, "NEW_ADMIN");
  const adminPubkey = assertStellarAddress(requireEnv("ADMIN_PUBLIC_KEY"), "ADMIN_PUBLIC_KEY");
  const adminVaultId = requireEnv("ADMIN_FIREBLOCKS_VAULT_ACCOUNT_ID");

  if (newAdmin === adminPubkey) {
    throw new Error(`NEW_ADMIN equals current admin (${adminPubkey}) — nothing to rotate.`);
  }

  const config = buildSigningConfig(adminVaultId, adminPubkey);
  const client = new SctokenFireblocksClient(config);

  await assertVaultMatchesPubkey(
    (client as unknown as { fireblocks: import("@fireblocks/ts-sdk").Fireblocks }).fireblocks,
    adminVaultId,
    config.fireblocksAssetId,
    adminPubkey,
  );

  const onChainAdmin = await client.queryAdmin({ contractId });
  if (onChainAdmin !== adminPubkey) {
    throw new Error(
      `Admin mismatch: on-chain admin is ${onChainAdmin}, but ADMIN_PUBLIC_KEY is ${adminPubkey}. ` +
        `You can only rotate the admin from the current admin's key. Check .env and the contract.`,
    );
  }

  console.log("=== Transfer admin ===");
  console.log(`  Contract:   ${contractId}`);
  console.log(`  From:       ${adminPubkey} (Fireblocks vault ${adminVaultId})`);
  console.log(`  To:         ${newAdmin}`);
  console.log();

  if (!(await confirm(`Rotate admin of ${contractId} from ${adminPubkey} → ${newAdmin}?`))) {
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
  console.log(`\nOK — admin is now ${updatedAdmin}.`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
