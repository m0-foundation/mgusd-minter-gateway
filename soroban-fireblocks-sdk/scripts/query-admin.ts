/**
 * Query admin and SAC token addresses from the SCToken contract.
 *
 * Uses the MINTER Fireblocks account (read-only, but minter is the operator).
 *
 * All parameters are read from .env — review before running:
 *   CONTRACT_ID
 *
 * Usage: npm run query
 */

import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadMinterConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadMinterConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const contractId = process.env.CONTRACT_ID;
  if (!contractId) throw new Error("Missing CONTRACT_ID in .env");

  console.log("=== Query Parameters ===");
  console.log(`  Contract: ${contractId}`);
  console.log(`  RPC:      ${config.sorobanRpcUrl}`);
  console.log();

  const adminResult = await client.queryAdmin({ contractId });
  console.log(`Admin:     ${adminResult.address}`);
  console.log(`  Hash:    ${adminResult.txHash}`);
  console.log(`  Ledger:  ${adminResult.ledger}`);

  console.log();

  const sacResult = await client.querySacToken({ contractId });
  console.log(`SAC Token: ${sacResult.address}`);
  console.log(`  Hash:    ${sacResult.txHash}`);
  console.log(`  Ledger:  ${sacResult.ledger}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
