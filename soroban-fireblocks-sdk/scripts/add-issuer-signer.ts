/**
 * One-off operator script: grant a second ed25519 signer privileges on an
 * already-deployed issuer account, via a single Fireblocks-signed setOptions op.
 *
 * This adds a signer and NOTHING else — it does not change the master key's
 * weight, the account thresholds, or the auth flags. With thresholds at their
 * default 0, the result is a 2-key classic multisig with MUTUAL INDEPENDENT
 * ACCESS: either the existing issuer master key OR the new signer can authorize
 * any issuer op on its own.
 *
 * This is the OPPOSITE of renounce — it keeps the issuer fully signable and adds
 * a second party. The new signer gains full classic-layer authority over the
 * asset (mint / freeze / clawback), so grant it only to a key as trusted as the
 * issuer itself. Reversible: a later setOptions can drop the signer (weight 0).
 *
 *   npm run add-issuer-signer
 *
 * Edit the VARS block below, then run. Requires the standard ISSUER_* +
 * Fireblocks env vars consumed by loadIssuerConfigFromEnv (see .env.example):
 * ISSUER_PUBLIC_KEY, ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID, SOROBAN_RPC_URL,
 * SOROBAN_NETWORK_PASSPHRASE, HORIZON_URL, FIREBLOCKS_API_KEY,
 * FIREBLOCKS_SECRET_PATH, FIREBLOCKS_ASSET_ID, FIREBLOCKS_BASE_PATH (optional).
 */

import * as dotenv from "dotenv";
import { Horizon } from "@stellar/stellar-sdk";
import { SctokenFireblocksClient, loadIssuerConfigFromEnv } from "../src";
import { assertVaultMatchesPubkey } from "../src/deploy-checks";
import { confirm } from "./lib/confirm";

dotenv.config();

// ─── VARS — edit before running ─────────────────────────────────────────
// G... ed25519 address to grant signer privileges on the issuer account.
const NEW_SIGNER_PUBLIC_KEY = "";
// Weight for the new signer. With thresholds at 0 any weight ≥ 1 can sign
// alone, so the exact value is cosmetic; 1 is the clean default.
const NEW_SIGNER_WEIGHT = 1;
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadIssuerConfigFromEnv();
  const client = new SctokenFireblocksClient(config);
  const issuer = config.sourcePublicKey;

  // NB: deliberately NOT assertStellarAddress() — that helper also accepts C...
  // (Soroban) addresses, but a classic-account signer must be a G... ed25519 key.
  if (!NEW_SIGNER_PUBLIC_KEY.startsWith("G")) {
    throw new Error(
      `NEW_SIGNER_PUBLIC_KEY must be a G... ed25519 address (a Soroban C-address cannot ` +
        `be a classic-account signer), got "${NEW_SIGNER_PUBLIC_KEY}"`,
    );
  }
  if (NEW_SIGNER_PUBLIC_KEY === issuer) {
    throw new Error(`NEW_SIGNER_PUBLIC_KEY equals the issuer master key (${issuer}) — nothing to add.`);
  }
  if (!Number.isInteger(NEW_SIGNER_WEIGHT) || NEW_SIGNER_WEIGHT < 1 || NEW_SIGNER_WEIGHT > 255) {
    throw new Error(`NEW_SIGNER_WEIGHT must be an integer 1–255, got ${NEW_SIGNER_WEIGHT}`);
  }

  await assertVaultMatchesPubkey(
    (client as unknown as { fireblocks: import("@fireblocks/ts-sdk").Fireblocks }).fireblocks,
    config.fireblocksVaultAccountId,
    config.fireblocksAssetId,
    issuer,
  );

  const horizon = new Horizon.Server(config.horizonUrl);
  const account = await horizon.loadAccount(issuer);
  const masterWeightBefore = account.signers.find((s) => s.key === issuer)?.weight ?? 0;
  const existing = account.signers.find((s) => s.key === NEW_SIGNER_PUBLIC_KEY);
  const thresholdsBefore = account.thresholds;

  // Preflight: a renounced issuer is locked — setOptions would fail on-chain.
  if (account.flags.auth_immutable) {
    throw new Error(`Issuer ${issuer} has AUTH_IMMUTABLE set — the account is locked and setOptions will fail.`);
  }
  // Idempotent: signer already present at the requested weight.
  if (existing && existing.weight === NEW_SIGNER_WEIGHT) {
    console.log(`Signer ${NEW_SIGNER_PUBLIC_KEY} already present at weight ${NEW_SIGNER_WEIGHT}. Nothing to do.`);
    return;
  }

  console.log("=== Add Issuer Signer ===");
  console.log(`  Issuer:        ${issuer} (Fireblocks vault ${config.fireblocksVaultAccountId})`);
  console.log(`  Network:       ${config.networkPassphrase}`);
  console.log(`  New signer:    ${NEW_SIGNER_PUBLIC_KEY}`);
  console.log(`  Weight:        ${existing ? `${existing.weight} → ${NEW_SIGNER_WEIGHT}` : NEW_SIGNER_WEIGHT}`);
  console.log(`  Master weight: ${masterWeightBefore} (unchanged)`);
  console.log(
    `  Thresholds:    low=${thresholdsBefore.low_threshold} ` +
      `med=${thresholdsBefore.med_threshold} high=${thresholdsBefore.high_threshold} (unchanged)`,
  );
  console.log(`  Signers now:   ${account.signers.length}`);
  console.log();
  console.log("  Effect: mutual independent access — the issuer master key AND this new");
  console.log("  signer can each authorize any issuer op alone (thresholds stay at 0).");
  console.log();

  if (
    !(await confirm(
      `Grant ${NEW_SIGNER_PUBLIC_KEY} signer rights (weight ${NEW_SIGNER_WEIGHT}) on issuer ${issuer}? ` +
        `Issuer Fireblocks vault will sign 1 set_options tx.`,
    ))
  ) {
    console.log("Aborted.");
    return;
  }

  const result = await client.addIssuerSigner({
    signerPublicKey: NEW_SIGNER_PUBLIC_KEY,
    weight: NEW_SIGNER_WEIGHT,
  });
  if (result.status !== "SUCCESS") {
    throw new Error(`addIssuerSigner failed (tx: ${result.txHash})`);
  }
  console.log(`  Added in ledger ${result.ledger}.`);

  // Post-verify: re-read Horizon and assert the signer landed at the expected
  // weight, the master key is unchanged, and thresholds were not touched.
  const after = await horizon.loadAccount(issuer);
  const addedSigner = after.signers.find((s) => s.key === NEW_SIGNER_PUBLIC_KEY);
  if (!addedSigner || addedSigner.weight !== NEW_SIGNER_WEIGHT) {
    throw new Error(
      `Post-add signer = ${addedSigner ? `weight ${addedSigner.weight}` : "absent"}, ` +
        `expected weight ${NEW_SIGNER_WEIGHT}`,
    );
  }
  const masterWeightAfter = after.signers.find((s) => s.key === issuer)?.weight ?? 0;
  if (masterWeightAfter !== masterWeightBefore) {
    throw new Error(`Master weight changed: ${masterWeightBefore} → ${masterWeightAfter} (should be unchanged)`);
  }
  const t = after.thresholds;
  if (
    t.low_threshold !== thresholdsBefore.low_threshold ||
    t.med_threshold !== thresholdsBefore.med_threshold ||
    t.high_threshold !== thresholdsBefore.high_threshold
  ) {
    throw new Error(
      `Thresholds changed: ${JSON.stringify(thresholdsBefore)} → ${JSON.stringify(t)} (should be unchanged)`,
    );
  }

  console.log("\n=== Issuer Signer Added ===");
  console.log(`  New signer:    ${NEW_SIGNER_PUBLIC_KEY} weight ${addedSigner.weight} ✓`);
  console.log(`  Master weight: ${masterWeightAfter} (unchanged) ✓`);
  console.log(
    `  Thresholds:    low=${t.low_threshold} med=${t.med_threshold} high=${t.high_threshold} (unchanged) ✓`,
  );
  console.log(`  Signers now:   ${after.signers.length}`);
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
