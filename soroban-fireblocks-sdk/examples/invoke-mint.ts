import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const contractId = process.env.CONTRACT_ID;
  const mintTo = process.env.MINT_TO;
  const mintAmount = process.env.MINT_AMOUNT;

  if (!contractId) {
    throw new Error("CONTRACT_ID env var is required");
  }
  if (!mintTo) {
    throw new Error("MINT_TO env var is required");
  }
  if (!mintAmount) {
    throw new Error("MINT_AMOUNT env var is required");
  }

  console.log(`Minting ${mintAmount} tokens to ${mintTo}...`);
  console.log(`Contract: ${contractId}`);
  console.log(`Source (admin): ${config.sourcePublicKey}`);
  console.log(`RPC: ${config.sorobanRpcUrl}`);

  const result = await client.mint({
    contractId,
    to: mintTo,
    amount: BigInt(mintAmount),
  });

  console.log(`\nTransaction ${result.status}:`);
  console.log(`  Hash:   ${result.txHash}`);
  console.log(`  Ledger: ${result.ledger}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
