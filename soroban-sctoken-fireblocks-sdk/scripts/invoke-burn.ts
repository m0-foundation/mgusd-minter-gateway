/**
 * Burn tokens via the SCToken contract.
 *
 * Uses the MINTER Fireblocks account.
 * Burns from the minter's key (MINTER_PUBLIC_KEY),
 * since burn requires from.require_auth().
 *
 * All parameters are read from .env — review before running:
 *   CONTRACT_ID, BURN_AMOUNT
 *
 * Usage: npm run burn
 */

import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadMinterConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadMinterConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const contractId = process.env.CONTRACT_ID;
  const amountStr = process.env.BURN_AMOUNT;

  if (!contractId) throw new Error("Missing CONTRACT_ID in .env");
  if (!amountStr) throw new Error("Missing BURN_AMOUNT in .env");

  const amount = BigInt(amountStr);
  const caller = config.sourcePublicKey;
  const from = config.sourcePublicKey;

  console.log("=== Burn Parameters ===");
  console.log(`  Contract: ${contractId}`);
  console.log(`  Caller:   ${caller}`);
  console.log(`  From:     ${from}`);
  console.log(`  Amount:   ${amount}`);
  console.log(`  RPC:      ${config.sorobanRpcUrl}`);
  console.log();

  const result = await client.burn({ contractId, caller, from, amount });

  console.log(`Transaction ${result.status}:`);
  console.log(`  Hash:   ${result.txHash}`);
  console.log(`  Ledger: ${result.ledger}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
