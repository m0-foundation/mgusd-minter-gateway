import * as dotenv from "dotenv";
import { SctokenFireblocksClient, loadConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const contractId = process.env.CONTRACT_ID;
  if (!contractId) {
    throw new Error("CONTRACT_ID env var is required");
  }

  console.log(`Querying admin for contract ${contractId}...`);
  console.log(`RPC: ${config.sorobanRpcUrl}`);

  const adminResult = await client.queryAdmin({ contractId });
  console.log(`\nAdmin address: ${adminResult.address}`);
  console.log(`  Hash:   ${adminResult.txHash}`);
  console.log(`  Ledger: ${adminResult.ledger}`);

  console.log(`\nQuerying SAC token for contract ${contractId}...`);

  const sacResult = await client.querySacToken({ contractId });
  console.log(`\nSAC token address: ${sacResult.address}`);
  console.log(`  Hash:   ${sacResult.txHash}`);
  console.log(`  Ledger: ${sacResult.ledger}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
