import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const contractId = process.env.CONTRACT_ID;
  const burnAmount = process.env.BURN_AMOUNT;

  if (!contractId) {
    throw new Error("CONTRACT_ID env var is required");
  }
  if (!burnAmount) {
    throw new Error("BURN_AMOUNT env var is required");
  }

  // burn requires from.require_auth() — from must be the Fireblocks key
  const from = config.sourcePublicKey;

  console.log(`Burning ${burnAmount} tokens from ${from}...`);
  console.log(`Contract: ${contractId}`);
  console.log(`RPC: ${config.sorobanRpcUrl}`);

  const result = await client.burn({
    contractId,
    from,
    amount: BigInt(burnAmount),
  });

  console.log(`\nTransaction ${result.status}:`);
  console.log(`  Hash:   ${result.txHash}`);
  console.log(`  Ledger: ${result.ledger}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
