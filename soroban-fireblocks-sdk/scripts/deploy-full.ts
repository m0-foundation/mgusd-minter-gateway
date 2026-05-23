// Full Fireblocks-signed deploy pipeline (5 steps + smoke test).
//
// Signing split mirrors scripts/deploy-pipeline.sh:
//   ISSUER   (Fireblocks vault) — signs steps 1 + 5 (set_options, SAC set_admin).
//   DEPLOYER (local Keypair)    — signs steps 2-4 (SAC deploy, WASM upload, wrapper deploy).
//
// Preflights (all run before any signing): vault↔ISSUER_PUBLIC_KEY reconciliation,
// issuer flags clean, issuer + deployer XLM balance, WASM sha256 matches
// EXPECTED_WASM_SHA256, interactive y/N confirm. Post-deploy: wrapper.admin()
// readback verifies the constructor wired the configured admin correctly.
//
// Emits a tamper-evident receipt JSON to ./deploys/ with source commit,
// WASM hash, role pubkeys, and resulting contract IDs.
//
// Required .env vars are in .env.example. Run: `npm run deploy`.

import * as fs from "fs";
import { createHash } from "crypto";
import * as dotenv from "dotenv";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { SctokenFireblocksClient, loadIssuerConfigFromEnv } from "../src";
import {
  assertDeployerSufficientlyFunded,
  assertIssuerFlagsClean,
  assertIssuerSufficientlyFunded,
  assertVaultMatchesPubkey,
} from "../src/deploy-checks";
import { confirm } from "./lib/confirm";
import {
  DeployReceipt,
  gitInfo,
  writeDeployReceipt,
} from "./lib/deploy-receipt";

dotenv.config();

function requireRolePubkey(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  try {
    Keypair.fromPublicKey(v);
  } catch {
    throw new Error(`${name} is not a valid Stellar pubkey: ${v}`);
  }
  return v;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadDeployerKeypair(): Keypair {
  const secret = requireEnv("DEPLOYER_SECRET_KEY");
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new Error("DEPLOYER_SECRET_KEY is not a valid Stellar secret seed (must start with S)");
  }
}

async function main(): Promise<void> {
  const config = loadIssuerConfigFromEnv();
  const client = new SctokenFireblocksClient(config);

  const assetCode = process.env.ASSET_CODE || "TMGUSD";
  const assetIssuer = config.sourcePublicKey;
  const wasmPath =
    process.env.WASM_PATH ||
    "./target/wasm32v1-none/release/mintergateway.wasm";

  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);

  // home_domain is OPTIONAL on-chain (Stellar accepts setOptions with or
  // without it), but we make the HOME_DOMAIN env var REQUIRED so the operator
  // must make an explicit choice — a forgotten/typo'd var shouldn't silently
  // skip SEP-1 wiring. To deploy without a home_domain, set HOME_DOMAIN=
  // (empty); the script will print `(none — SEP-1 metadata won't be resolvable)`
  // in the plan summary so the operator sees it before confirming.
  const homeDomainRaw = requireEnv("HOME_DOMAIN").trim();
  const homeDomain = homeDomainRaw.length > 0 ? homeDomainRaw : undefined;
  if (homeDomain) {
    if (/^https?:\/\//i.test(homeDomain)) {
      throw new Error(`HOME_DOMAIN must NOT include a scheme — got "${homeDomain}". Use just the domain (e.g. "m0.foundation").`);
    }
    // Stellar caps home_domain at 32 UTF-8 bytes — IDNs encode to more bytes than JS chars.
    const homeDomainBytes = Buffer.byteLength(homeDomain, "utf8");
    if (homeDomainBytes > 32) {
      throw new Error(
        `HOME_DOMAIN too long: ${homeDomainBytes} UTF-8 bytes (${homeDomain.length} chars). Stellar protocol max is 32 bytes.`,
      );
    }
  } else {
    console.warn(
      "NOTE: HOME_DOMAIN is empty — deploying without SEP-1 metadata. " +
        "Wallets and explorers won't be able to resolve token info for this asset. " +
        "This is reversible later via `npm run update-home-domain`.",
    );
  }

  // STEL1-5: no role collapse — each role from its own env var.
  const roles = {
    admin: requireRolePubkey("ADMIN_PUBLIC_KEY"),
    minter: requireRolePubkey("MINTER_PUBLIC_KEY"),
    yieldRecipientManager: requireRolePubkey("YIELD_RECIPIENT_MANAGER_PUBLIC_KEY"),
    yieldRecipient: requireRolePubkey("YIELD_RECIPIENT_PUBLIC_KEY"),
    forcedTransferManager: requireRolePubkey("FORCED_TRANSFER_MANAGER_PUBLIC_KEY"),
    blockOperator: requireRolePubkey("BLOCK_OPERATOR_PUBLIC_KEY"),
    unblockOperator: requireRolePubkey("UNBLOCK_OPERATOR_PUBLIC_KEY"),
    pauser: requireRolePubkey("PAUSER_PUBLIC_KEY"),
  };

  const uniqueRoles = new Set(Object.values(roles));
  if (uniqueRoles.size < Object.keys(roles).length) {
    console.warn("WARNING: multiple roles share the same pubkey — role separation is reduced");
  }

  const wasm = fs.readFileSync(wasmPath);
  const actualSha = createHash("sha256").update(wasm).digest("hex");

  // Operator-attested WASM hash; catches stale/wrong-branch build artifacts.
  const expectedSha = requireEnv("EXPECTED_WASM_SHA256").toLowerCase();
  if (actualSha !== expectedSha) {
    throw new Error(
      `WASM hash mismatch: ${wasmPath} hashes to ${actualSha}, but ` +
        `EXPECTED_WASM_SHA256=${expectedSha}. Rebuild from the expected ` +
        `source commit, or update EXPECTED_WASM_SHA256 if this artifact is intentional.`,
    );
  }

  const source = gitInfo();
  if (source.dirty) {
    console.warn(
      `WARNING: source working tree at ${source.commit} is dirty — ` +
        `the receipt will record this commit, but uncommitted local edits are NOT captured.`,
    );
  }

  const deployerKeypair = loadDeployerKeypair();
  const deployerPubkey = deployerKeypair.publicKey();
  if (deployerPubkey === assetIssuer) {
    console.warn(
      "WARNING: deployer pubkey == issuer pubkey (single-signer mode). " +
        "Production deploys should keep these distinct so the issuer Fireblocks vault " +
        "only signs the two issuer-authority ops.",
    );
  }

  const horizon = new Horizon.Server(config.horizonUrl);

  // Cast through unknown — the `fireblocks` field is protected on the base client.
  await assertVaultMatchesPubkey(
    (client as unknown as { fireblocks: import("@fireblocks/ts-sdk").Fireblocks }).fireblocks,
    config.fireblocksVaultAccountId,
    config.fireblocksAssetId,
    assetIssuer,
  );

  await assertIssuerFlagsClean(horizon, assetIssuer);

  const issuerMinXlm = parseFloat(process.env.ISSUER_MIN_XLM ?? "5");
  await assertIssuerSufficientlyFunded(horizon, assetIssuer, issuerMinXlm);

  const deployerMinXlm = parseFloat(process.env.DEPLOYER_MIN_XLM ?? "3");
  await assertDeployerSufficientlyFunded(horizon, deployerPubkey, deployerMinXlm);

  console.log("=== Full Fireblocks Deploy (split signing) ===");
  console.log(`  Asset:        ${assetCode}`);
  console.log(`  Issuer:       ${assetIssuer} (Fireblocks vault ${config.fireblocksVaultAccountId}) — signs steps 1, 5`);
  console.log(`  home_domain:  ${homeDomain ?? "(none — SEP-1 metadata won't be resolvable)"}`);
  console.log(`  Deployer:     ${deployerPubkey} (local key) — signs steps 2, 3, 4`);
  console.log(`  WASM:         ${wasmPath} (${wasm.length} bytes)`);
  console.log(`  WASM sha256:  ${actualSha}`);
  console.log(`  Source:       ${source.commit}${source.dirty ? " (DIRTY)" : ""} on ${source.branch}`);
  console.log(`  Network:      ${config.networkPassphrase}`);
  console.log(`  RPC:          ${config.sorobanRpcUrl}`);
  console.log();
  console.log("  Roles (passed to __constructor in step 4):");
  console.log(`    admin:                 ${roles.admin}`);
  console.log(`    minter:                ${roles.minter}`);
  console.log(`    yieldRecipientManager: ${roles.yieldRecipientManager}`);
  console.log(`    yieldRecipient:        ${roles.yieldRecipient}`);
  console.log(`    forcedTransferManager: ${roles.forcedTransferManager}`);
  console.log(`    blockOperator:         ${roles.blockOperator}`);
  console.log(`    unblockOperator:       ${roles.unblockOperator}`);
  console.log(`    pauser:                ${roles.pauser}`);
  console.log();

  if (!(await confirm("Proceed with deploy? Issuer will sign 2 Fireblocks txs (steps 1, 5); deployer will sign 3 local txs (steps 2-4)."))) {
    console.log("Aborted.");
    return;
  }

  const result = await client.deployFull({
    assetCode,
    assetIssuer,
    wasm,
    deployerKeypair,
    homeDomain,
    ...roles,
  });

  console.log();
  console.log("=== Deploy Complete ===");
  console.log(`  SAC Contract ID:     ${result.sacContractId}`);
  console.log(`  WASM Hash:           ${result.wasmHash}`);
  console.log(`  Wrapper Contract ID: ${result.wrapperContractId}`);

  // Written post-success so a half-failed deploy leaves no misleading artifact.
  const receipt: DeployReceipt = {
    timestamp: new Date().toISOString(),
    network: {
      networkPassphrase: config.networkPassphrase,
      sorobanRpcUrl: config.sorobanRpcUrl,
      horizonUrl: config.horizonUrl,
    },
    source,
    wasm: { path: wasmPath, sha256: actualSha, sizeBytes: wasm.length },
    issuer: {
      publicKey: assetIssuer,
      vaultAccountId: String(config.fireblocksVaultAccountId),
    },
    deployer: { publicKey: deployerPubkey },
    asset: { code: assetCode, issuer: assetIssuer, homeDomain },
    roles,
    result: {
      sacContractId: result.sacContractId,
      wasmHashOnChain: result.wasmHash,
      wrapperContractId: result.wrapperContractId,
    },
  };
  const receiptDir = process.env.DEPLOY_RECEIPT_DIR || "./deploys";
  const receiptPath = writeDeployReceipt(receipt, receiptDir);
  console.log(`  Receipt:             ${receiptPath}`);
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
