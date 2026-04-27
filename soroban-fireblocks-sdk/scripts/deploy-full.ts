/**
 * Full Fireblocks deployment pipeline:
 *   0. Refuse to deploy if the issuer has any pre-flag on-chain footprint
 *   1. Configure issuer (AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED)
 *   2. Deploy SAC (Stellar Asset Contract)
 *   3. Upload WASM
 *   4. Deploy wrapper contract with 7 distinct constructor role args
 *   5. Transfer SAC admin to wrapper
 *
 * Uses the ISSUER Fireblocks account to sign all deploy transactions. Each
 * privileged contract role is read from its own env var and passed
 * independently into `deployFull`. The script fails closed if any role var
 * is missing or malformed — see audit STEL1-5 for the rationale (collapsing
 * every role into a single signer turns one operational vault into the
 * full protocol control plane).
 *
 * Required .env variables:
 *   ISSUER_PUBLIC_KEY, ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID
 *
 *   ADMIN_PUBLIC_KEY                       — top-level authority (M0)
 *   MINTER_PUBLIC_KEY                      — bridge / Fireblocks minter
 *   YIELD_RECIPIENT_MANAGER_PUBLIC_KEY     — rotates yield recipient (M0)
 *   YIELD_RECIPIENT_PUBLIC_KEY             — claims yield (e.g. MoneyGram)
 *   FORCED_TRANSFER_MANAGER_PUBLIC_KEY     — compliance forced transfers (Crossmint)
 *   BLOCKER_PUBLIC_KEY                     — compliance blocker
 *   PAUSER_PUBLIC_KEY                      — pauser of record
 *
 *   ASSET_CODE                             — defaults to TMGUSD
 *   WASM_PATH                              — path to compiled WASM
 *
 * For single-signer local testing, set every role var above to the same
 * value explicitly. There is intentionally no "dev-mode" script that
 * collapses roles — see PR / STEL1-5 fix discussion.
 *
 * Usage: npm run deploy
 */

import * as fs from "fs";
import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadIssuerConfigFromEnv } from "../src";
import { Keypair } from "@stellar/stellar-sdk";

dotenv.config();

/**
 * Read a Stellar G-prefixed pubkey from env, throwing a descriptive
 * error if the var is missing or doesn't start with `G`. Used to keep
 * each privileged role independently configured.
 */
function requireRolePubkey(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  try {
    Keypair.fromPublicKey(v);
  } catch {
    throw new Error(`${name} is not a valid Stellar pubkey: ${v}`);
  }
  return v;
}

async function main(): Promise<void> {
  const config = loadIssuerConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const assetCode = process.env.ASSET_CODE || "TMGUSD";
  const assetIssuer = config.sourcePublicKey;
  const wasmPath =
    process.env.WASM_PATH ||
    "./target/wasm32v1-none/release/mintergateway.wasm";
  
  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);

  // STEL1-5: each privileged role is read from its own env var. Failing
  // to set any one of them aborts the deploy — collapsing roles into a
  // single signer is not allowed by this script.
  const roles = {
    admin: requireRolePubkey("ADMIN_PUBLIC_KEY"),
    minter: requireRolePubkey("MINTER_PUBLIC_KEY"),
    yieldRecipientManager: requireRolePubkey("YIELD_RECIPIENT_MANAGER_PUBLIC_KEY"),
    yieldRecipient: requireRolePubkey("YIELD_RECIPIENT_PUBLIC_KEY"),
    forcedTransferManager: requireRolePubkey("FORCED_TRANSFER_MANAGER_PUBLIC_KEY"),
    blocker: requireRolePubkey("BLOCKER_PUBLIC_KEY"),
    pauser: requireRolePubkey("PAUSER_PUBLIC_KEY"),
  };
  
  const uniqueRoles = new Set(Object.values(roles));
  if (uniqueRoles.size < Object.keys(roles).length) {
    console.warn("WARNING: multiple roles share the same pubkey — role separation is reduced");
  }

  const wasm = fs.readFileSync(wasmPath);

  console.log("=== Full Fireblocks Deploy ===");
  console.log(`  Asset:  ${assetCode}`);
  console.log(`  Issuer: ${assetIssuer}`);
  console.log(`  WASM:   ${wasmPath} (${wasm.length} bytes)`);
  console.log(`  RPC:    ${config.sorobanRpcUrl}`);
  console.log();
  console.log("  Roles:");
  console.log(`    admin:                 ${roles.admin}`);
  console.log(`    minter:                ${roles.minter}`);
  console.log(`    yieldRecipientManager: ${roles.yieldRecipientManager}`);
  console.log(`    yieldRecipient:        ${roles.yieldRecipient}`);
  console.log(`    forcedTransferManager: ${roles.forcedTransferManager}`);
  console.log(`    blocker:               ${roles.blocker}`);
  console.log(`    pauser:                ${roles.pauser}`);
  console.log();

  const result = await client.deployFull({
    assetCode,
    assetIssuer,
    wasm,
    ...roles,
  });

  console.log();
  console.log("=== Deploy Complete ===");
  console.log(`  SAC Contract ID:     ${result.sacContractId}`);
  console.log(`  WASM Hash:           ${result.wasmHash}`);
  console.log(`  Wrapper Contract ID: ${result.wrapperContractId}`);
}

export { main };

// Only auto-run when executed directly (`npm run deploy`), not when
// imported by tests. Without this guard every `require()` in tests
// would kick off a live deploy attempt.
if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
