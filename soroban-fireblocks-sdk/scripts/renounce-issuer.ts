/**
 * One-off operator script: permanently renounce an already-deployed issuer via a
 * single Fireblocks-signed setOptions op (master_weight 0 + AUTH_IMMUTABLE).
 *
 * The TypeScript / Fireblocks equivalent of
 *   ./scripts/deploy-renounce.sh --skip-deploy --renounce-issuer --execute
 * Same on-chain semantics; signs with the issuer Fireblocks vault instead of a
 * local seed. Run AFTER the issuer is fully deployed (npm run deploy).
 *
 *   npm run renounce-issuer -- --dry-run   # build + print XDR, do NOT sign/submit
 *   npm run renounce-issuer -- --execute   # IRREVERSIBLE: sign + submit
 *
 * Exactly one of --dry-run or --execute is required; bare `npm run renounce-issuer`
 * (no flag) exits with an error. This mirrors scripts/deploy-renounce.sh, which
 * also requires --execute to actually submit.
 *
 * Requires in .env (all consumed by loadIssuerConfigFromEnv): ISSUER_PUBLIC_KEY,
 * ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID, SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE,
 * HORIZON_URL, FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_PATH, FIREBLOCKS_ASSET_ID,
 * FIREBLOCKS_BASE_PATH (optional).
 *
 * WARNING: After this lands the issuer is cryptographically unsignable forever
 * and its flags are locked. The minimum-reserve XLM is permanently unrecoverable.
 * Read docs/issuer-renunciation.md before running without --dry-run.
 */

import * as readline from "readline";
import * as dotenv from "dotenv";
import { Horizon } from "@stellar/stellar-sdk";
import {
  SctokenFireblocksClient,
  loadIssuerConfigFromEnv,
  buildRenounceIssuerTransaction,
  createRpcServer,
} from "../src";
import { assertVaultMatchesPubkey } from "../src/deploy-checks";
import { confirm } from "./lib/confirm";

dotenv.config();

// Step 1 of deploy sets AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED (= 11);
// renounce ORs in AUTH_IMMUTABLE (4) → 15.
const EXPECTED_FLAGS_PRE_RENOUNCE = 11;
const EXPECTED_FLAGS_POST_RENOUNCE = 15;

interface HorizonFlags {
  auth_required?: boolean;
  auth_revocable?: boolean;
  auth_immutable?: boolean;
  auth_clawback_enabled?: boolean;
}

// Numeric flag value, matching deploy-renounce.sh's jq computation.
function flagsNumeric(flags: HorizonFlags): number {
  return (
    (flags.auth_required ? 1 : 0) +
    (flags.auth_revocable ? 2 : 0) +
    (flags.auth_immutable ? 4 : 0) +
    (flags.auth_clawback_enabled ? 8 : 0)
  );
}

// Minimal structural type covering the fields we actually read. Assignable from
// both `Horizon.Server.loadAccount()`'s AccountResponse (used here) and the
// richer ServerApi.AccountRecord — avoids coupling these helpers to whichever
// Horizon return-type a given @stellar/stellar-sdk version exposes.
interface AccountSummary {
  account_id: string;
  signers: ReadonlyArray<{ key: string; weight: number }>;
  balances: ReadonlyArray<{ asset_type: string; balance: string }>;
}

// Weight of the master signer (the signer whose key equals the account id).
function masterWeight(account: AccountSummary): number {
  const master = account.signers.find((s) => s.key === account.account_id);
  return master?.weight ?? 0;
}

function nativeBalance(account: AccountSummary): string {
  return account.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
}

function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const execute = args.includes("--execute");

  if (dryRun && execute) {
    console.error("ERROR: --dry-run and --execute are mutually exclusive");
    process.exit(1);
  }
  if (!dryRun && !execute) {
    console.error("ERROR: must pass --dry-run (build + print XDR, no submit) or --execute (IRREVERSIBLE: sign + submit)");
    console.error("       Default behavior does NOT submit. Read docs/issuer-renunciation.md before --execute.");
    process.exit(1);
  }

  const config = loadIssuerConfigFromEnv();
  const client = new SctokenFireblocksClient(config);
  const issuer = config.sourcePublicKey;

  // Vault still holds the issuer key — catches "right pubkey, wrong vault".
  await assertVaultMatchesPubkey(
    (client as unknown as { fireblocks: import("@fireblocks/ts-sdk").Fireblocks }).fireblocks,
    config.fireblocksVaultAccountId,
    config.fireblocksAssetId,
    issuer,
  );

  const horizon = new Horizon.Server(config.horizonUrl);
  const account = await horizon.loadAccount(issuer);
  const flags = account.flags as HorizonFlags;
  const flagsNum = flagsNumeric(flags);
  const weight = masterWeight(account);

  // Preflight: don't sign a no-op or an unexpected-state renounce.
  if (flags.auth_immutable) {
    console.log(`Issuer ${issuer} already has AUTH_IMMUTABLE set — already renounced. Nothing to do.`);
    return;
  }
  if (weight === 0) {
    console.log(`Issuer ${issuer} master weight is already 0 — already neutered. Nothing to do.`);
    return;
  }
  if (flagsNum !== EXPECTED_FLAGS_PRE_RENOUNCE) {
    console.warn(
      `WARNING: issuer flags = ${flagsNum}, expected ${EXPECTED_FLAGS_PRE_RENOUNCE} ` +
        `(AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED). The issuer may not be in the ` +
        `standard post-deploy state. After renounce, flags will be ${flagsNum | 4} (current | AUTH_IMMUTABLE).`,
    );
  }

  console.log("=== Renounce Issuer (IRREVERSIBLE) ===");
  console.log(`  Issuer:        ${issuer} (Fireblocks vault ${config.fireblocksVaultAccountId})`);
  console.log(`  Network:       ${config.networkPassphrase}`);
  console.log(`  master_weight: ${weight} → 0`);
  console.log(`  flags:         ${flagsNum} → ${EXPECTED_FLAGS_POST_RENOUNCE} (adds AUTH_IMMUTABLE)`);
  console.log(`  Locked XLM:    ${nativeBalance(account)} (PERMANENTLY UNRECOVERABLE after renounce)`);
  console.log();

  if (dryRun) {
    const server = createRpcServer(config.sorobanRpcUrl);
    const tx = await buildRenounceIssuerTransaction(server, config, {});
    const envelopeB64 = tx.toEnvelope().toXDR("base64");
    console.log("DRY-RUN — built renounce tx, NOT signing or submitting:");
    console.log(`  hash:     ${tx.hash().toString("hex")}`);
    console.log(`  envelope: ${envelopeB64}`);
    console.log(`  decode:   npm run verify-envelope -- --xdr "${envelopeB64}"`);
    console.log("\nRe-run without --dry-run to sign via Fireblocks and submit.");
    return;
  }

  console.log("WARNING: This is IRREVERSIBLE. After the tx lands, the issuer key can");
  console.log("         never sign again and its flags are locked forever.\n");

  if (!(await confirm(`Renounce issuer ${issuer}? The issuer Fireblocks vault will sign 1 set_options tx.`))) {
    console.log("Aborted.");
    return;
  }
  // Second gate: re-type the issuer address in full to confirm intent.
  const typed = await prompt(`Type the issuer address to confirm: `);
  if (typed !== issuer) {
    console.log(`Address mismatch (got "${typed}") — aborted.`);
    return;
  }

  const result = await client.renounceIssuer({});
  if (result.status !== "SUCCESS") {
    throw new Error(`renounceIssuer failed (tx: ${result.txHash})`);
  }
  console.log(`  Renounced in ledger ${result.ledger}.`);

  // Post-verify (issuer account state only): re-read from Horizon and assert the
  // renounce landed. Mirrors deploy-renounce.sh verify_renounced minus the
  // SAC/wrapper admin-invariant checks.
  const after = await horizon.loadAccount(issuer);
  const nSigners = after.signers.length;
  if (nSigners === 1) {
    const s = after.signers[0];
    if (s.key !== issuer || s.weight !== 0) {
      throw new Error(`Post-renounce signer = ${s.key} weight=${s.weight}, expected master with weight 0`);
    }
  } else if (nSigners !== 0) {
    throw new Error(`Post-renounce signer count = ${nSigners}, expected 0 or 1`);
  }

  const afterFlagsNum = flagsNumeric(after.flags as HorizonFlags);
  if (afterFlagsNum !== EXPECTED_FLAGS_POST_RENOUNCE) {
    throw new Error(
      `Post-renounce flags = ${afterFlagsNum}, expected ${EXPECTED_FLAGS_POST_RENOUNCE} (pre-renounce + AUTH_IMMUTABLE)`,
    );
  }

  console.log("\n=== Issuer Renounced ===");
  console.log(`  Issuer:        ${issuer} (PERMANENTLY UNSIGNABLE per chain state)`);
  console.log(`  master_weight: 0`);
  console.log(`  flags:         ${afterFlagsNum} (incl. AUTH_IMMUTABLE) ✓`);
  console.log(`  Locked XLM:    ${nativeBalance(after)} (unrecoverable)`);
  console.log("\n  (State verified via Horizon. No behavioral TxBadAuth probe — that would");
  console.log("   require a second, wasted Fireblocks approval; the state read above suffices.)");
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
