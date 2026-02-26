/**
 * Mint tokens via the SCToken contract.
 *
 * Uses the MINTER Fireblocks account (who is the contract admin).
 *
 * All parameters are read from .env — review before running:
 *   CONTRACT_ID, MINT_TO, MINT_AMOUNT
 *
 * Usage: npm run mint
 */

import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadMinterConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadMinterConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const contractId = process.env.CONTRACT_ID;
  const to = process.env.MINT_TO;
  const amountStr = process.env.MINT_AMOUNT;

  if (!contractId) throw new Error("Missing CONTRACT_ID in .env");
  if (!to) throw new Error("Missing MINT_TO in .env");
  if (!amountStr) throw new Error("Missing MINT_AMOUNT in .env");

  const amount = BigInt(amountStr);

  console.log("=== Mint Parameters ===");
  console.log(`  Contract: ${contractId}`);
  console.log(`  To:       ${to}`);
  console.log(`  Amount:   ${amount}`);
  console.log(`  Admin:    ${config.sourcePublicKey}`);
  console.log(`  RPC:      ${config.sorobanRpcUrl}`);
  console.log();

  const result = await client.mint({ contractId, to, amount });

  console.log(`Transaction ${result.status}:`);
  console.log(`  Hash:   ${result.txHash}`);
  console.log(`  Ledger: ${result.ledger}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
