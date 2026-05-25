/**
 * Set up a trustline for the minter's Fireblocks vault account to hold a classic Stellar asset.
 *
 * Required .env variables:
 *   TRUSTLINE_ASSET_CODE   — Asset code (e.g., TMGUSD)
 *   ISSUER_PUBLIC_KEY      — Asset issuer address (G...)
 *
 * The trustline is created for MINTER_PUBLIC_KEY (the minter needs it to receive tokens).
 *
 * Usage: npm run trustline
 */

import * as dotenv from "dotenv";
import { SorobanFireblocksClient, loadMinterConfigFromEnv } from "../src";

dotenv.config();

async function main(): Promise<void> {
  const config = loadMinterConfigFromEnv();
  const client = new SorobanFireblocksClient(config);

  const assetCode = process.env.TRUSTLINE_ASSET_CODE;
  const assetIssuer = process.env.ISSUER_PUBLIC_KEY;

  if (!assetCode) throw new Error("Missing TRUSTLINE_ASSET_CODE in .env");
  if (!assetIssuer) throw new Error("Missing ISSUER_PUBLIC_KEY in .env");

  console.log("=== Setup Trustline ===");
  console.log(`  Asset:   ${assetCode}:${assetIssuer}`);
  console.log(`  Account: ${config.sourcePublicKey}`);
  console.log(`  RPC:     ${config.sorobanRpcUrl}`);
  console.log();

  const result = await client.setupTrustline({ assetCode, assetIssuer });

  console.log(`Transaction ${result.status}:`);
  console.log(`  Hash:   ${result.txHash}`);
  console.log(`  Ledger: ${result.ledger}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
