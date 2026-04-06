/**
 * Full Fireblocks deployment pipeline:
 *   1. Configure issuer (AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED)
 *   2. Deploy SAC (Stellar Asset Contract)
 *   3. Upload WASM
 *   4. Deploy wrapper contract with 6 constructor args
 *   5. Transfer SAC admin to wrapper
 *
 * Uses the ISSUER Fireblocks account to sign all deploy transactions.
 * Sets MINTER_PUBLIC_KEY as admin and all role addresses.
 *
 * Required .env variables:
 *   ISSUER_PUBLIC_KEY, ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID
 *   MINTER_PUBLIC_KEY (set as admin + all roles)
 *   ASSET_CODE          — Asset code (default: TMGUSD)
 *   COLLATERAL_TOKEN    — Collateral SAC contract ID (C...)
 *   WASM_PATH           — Path to compiled WASM
 *
 * Usage: npm run deploy
 */

import * as fs from "fs";
import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadIssuerConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadIssuerConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const assetCode = process.env.ASSET_CODE || "TMGUSD";
  const assetIssuer = config.sourcePublicKey;
  const wasmPath =
    process.env.WASM_PATH ||
    "./target/wasm32v1-none/release/mintergateway.wasm";

  const minterPublicKey = process.env.MINTER_PUBLIC_KEY;
  if (!minterPublicKey) throw new Error("Missing MINTER_PUBLIC_KEY in .env");

  const collateralToken = process.env.COLLATERAL_TOKEN;
  if (!collateralToken) throw new Error("Missing COLLATERAL_TOKEN in .env");

  const wasm = fs.readFileSync(wasmPath);
  const admin = minterPublicKey;

  console.log("=== Full Fireblocks Deploy ===");
  console.log(`  Asset:            ${assetCode}`);
  console.log(`  Issuer:           ${assetIssuer}`);
  console.log(`  Collateral token: ${collateralToken}`);
  console.log(`  Admin:            ${admin} (minter)`);
  console.log(`  WASM:             ${wasmPath} (${wasm.length} bytes)`);
  console.log(`  RPC:              ${config.sorobanRpcUrl}`);
  console.log();

  const result = await client.deployFull({
    assetCode,
    assetIssuer,
    wasm,
    collateralToken,
    admin,
    minter: minterPublicKey,
    yieldRecipientManager: minterPublicKey,
    yieldRecipient: minterPublicKey,
    forcedTransferManager: minterPublicKey,
    distributor: minterPublicKey,
  });

  console.log();
  console.log("=== Deploy Complete ===");
  console.log(`  SAC Contract ID:     ${result.sacContractId}`);
  console.log(`  WASM Hash:           ${result.wasmHash}`);
  console.log(`  Wrapper Contract ID: ${result.wrapperContractId}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
