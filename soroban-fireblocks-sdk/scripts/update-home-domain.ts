// One-off operator script: update an already-deployed issuer's home_domain
// via a single Fireblocks-signed setOptions op. See .env.example for required vars.

import * as dotenv from "dotenv";
import { Horizon } from "@stellar/stellar-sdk";
import { SctokenFireblocksClient, loadIssuerConfigFromEnv } from "../src";
import { assertVaultMatchesPubkey } from "../src/deploy-checks";
import { confirm } from "./lib/confirm";

dotenv.config();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const config = loadIssuerConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const newHomeDomain = requireEnv("HOME_DOMAIN").trim();
  if (/^https?:\/\//i.test(newHomeDomain)) {
    throw new Error(`HOME_DOMAIN must NOT include a scheme — got "${newHomeDomain}". Use just the domain.`);
  }
  const bytes = Buffer.byteLength(newHomeDomain, "utf8");
  if (bytes > 32) {
    throw new Error(`HOME_DOMAIN too long: ${bytes} UTF-8 bytes (${newHomeDomain.length} chars). Stellar protocol max is 32 bytes.`);
  }

  await assertVaultMatchesPubkey(
    (client as unknown as { fireblocks: import("@fireblocks/ts-sdk").Fireblocks }).fireblocks,
    config.fireblocksVaultAccountId,
    config.fireblocksAssetId,
    config.sourcePublicKey,
  );

  const horizon = new Horizon.Server(config.horizonUrl);
  const account = await horizon.loadAccount(config.sourcePublicKey);
  const currentHomeDomain = (account as unknown as { home_domain?: string }).home_domain ?? "(unset)";

  console.log("=== Update Issuer home_domain ===");
  console.log(`  Issuer:        ${config.sourcePublicKey} (Fireblocks vault ${config.fireblocksVaultAccountId})`);
  console.log(`  Network:       ${config.networkPassphrase}`);
  console.log(`  Current:       ${currentHomeDomain}`);
  console.log(`  New:           ${newHomeDomain}`);
  console.log();

  if (currentHomeDomain === newHomeDomain) {
    console.log("No change — current and new home_domain are identical. Exiting.");
    return;
  }

  if (!(await confirm(`Update issuer home_domain to "${newHomeDomain}"? Issuer Fireblocks vault will sign 1 set_options tx.`))) {
    console.log("Aborted.");
    return;
  }

  // configureIssuer re-asserts auth flags; Stellar's setFlags is additive, so safe on already-configured issuers.
  const result = await client.configureIssuer({ homeDomain: newHomeDomain });
  if (result.status !== "SUCCESS") {
    throw new Error(`configureIssuer failed (tx: ${result.txHash})`);
  }
  console.log(`  Set in ledger ${result.ledger}.`);

  const updated = await horizon.loadAccount(config.sourcePublicKey);
  const verifiedHomeDomain = (updated as unknown as { home_domain?: string }).home_domain;
  if (verifiedHomeDomain !== newHomeDomain) {
    throw new Error(
      `Post-update verification failed: on-chain home_domain = ${verifiedHomeDomain}, expected ${newHomeDomain}`,
    );
  }
  console.log(`  Verified on-chain: home_domain = ${verifiedHomeDomain} ✓`);
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
