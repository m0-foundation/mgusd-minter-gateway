/**
 * One-off: set a ChangeTrust line on a Stellar account using a LOCALLY-held
 * Ed25519 secret (NOT Fireblocks). Used for mainnet smoke-testing the
 * wrapper's block/unblock flow against a known test holder we control
 * outside of Fireblocks.
 *
 * Asset (code + issuer) is discovered automatically by simulating the SAC's
 * `name()` view, which returns "CODE:ISSUER" for classic-asset-backed SACs.
 * Cross-checked against `Asset(code, issuer).contractId(passphrase)` to make
 * sure the SAC we're about to trust matches the wrapper's SAC.
 *
 * Required .env:
 *   SOROBAN_RPC_URL, SOROBAN_NETWORK_PASSPHRASE, HORIZON_URL
 *   CONTRACT_ID                — the wrapper contract (C...)
 *   HOLDER_TEST_SECRET         — Ed25519 secret of the trustor (S...).
 *                                Keep this out of source control.
 *
 * Usage:
 *   npm run trustline-self -- --dry-run   # build tx, print XDR, exit
 *   npm run trustline-self                # submit
 */

import * as dotenv from "dotenv";
import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

dotenv.config();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function discoverAssetFromSac(
  server: rpc.Server,
  passphrase: string,
  simSourcePubkey: string,
  sacContractId: string,
): Promise<Asset> {
  const sourceAccount = await server.getAccount(simSourcePubkey);
  const sac = new Contract(sacContractId);
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(sac.call("name"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    throw new Error(`SAC name() simulation failed: ${JSON.stringify(sim).slice(0, 300)}`);
  }
  const nameStr = scValToNative(sim.result.retval) as string;
  const parts = nameStr.split(":");
  if (parts.length !== 2 || !parts[1]?.startsWith("G")) {
    throw new Error(`SAC name() did not return CODE:ISSUER format (got "${nameStr}")`);
  }
  const [code, issuer] = parts;
  const asset = new Asset(code, issuer);

  // Belt-and-braces: verify the SAC we just read from really is the
  // SAC for (code, issuer) on this network. Catches a typo / wrong-network
  // mismatch before we sign anything.
  const derivedSacId = asset.contractId(passphrase);
  if (derivedSacId !== sacContractId) {
    throw new Error(
      `SAC ID mismatch: name() said ${code}:${issuer} but Asset(...).contractId(${passphrase}) = ${derivedSacId}, ` +
        `expected ${sacContractId}`,
    );
  }
  return asset;
}

async function readWrapperSacId(
  server: rpc.Server,
  passphrase: string,
  simSourcePubkey: string,
  wrapperContractId: string,
): Promise<string> {
  const sourceAccount = await server.getAccount(simSourcePubkey);
  const wrapper = new Contract(wrapperContractId);
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(wrapper.call("sac_token"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    throw new Error(`wrapper sac_token() simulation failed: ${JSON.stringify(sim).slice(0, 300)}`);
  }
  return scValToNative(sim.result.retval) as string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const rpcUrl = requireEnv("SOROBAN_RPC_URL");
  const passphrase = requireEnv("SOROBAN_NETWORK_PASSPHRASE");
  const horizonUrl = requireEnv("HORIZON_URL");
  const wrapperContractId = requireEnv("CONTRACT_ID");
  const secret = requireEnv("HOLDER_TEST_SECRET");

  if (!secret.startsWith("S")) {
    throw new Error("HOLDER_TEST_SECRET must be a valid Stellar Ed25519 secret (starts with S)");
  }

  const keypair = Keypair.fromSecret(secret);
  // Defang the env immediately so a later crash/dump doesn't leak it.
  delete process.env.HOLDER_TEST_SECRET;

  const source = keypair.publicKey();

  console.log("=== Local trustline (Keypair-signed) ===");
  console.log(`  Network:      ${passphrase === Networks.PUBLIC ? "PUBLIC (mainnet)" : passphrase}`);
  console.log(`  Wrapper:      ${wrapperContractId}`);
  console.log(`  Trustor:      ${source}`);
  console.log();

  const server = new rpc.Server(rpcUrl, { allowHttp: false });

  console.log("Discovering SAC + asset...");
  const sacId = await readWrapperSacId(server, passphrase, source, wrapperContractId);
  const asset = await discoverAssetFromSac(server, passphrase, source, sacId);
  console.log(`  SAC:          ${sacId}`);
  console.log(`  Asset:        ${asset.getCode()}:${asset.getIssuer()}`);
  console.log();

  const trustor = await server.getAccount(source);
  const tx = new TransactionBuilder(trustor, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(30)
    .build();

  if (dryRun) {
    console.log("=== Dry-run — not submitting ===");
    console.log(`  Op:           changeTrust (default unlimited limit)`);
    console.log(`  Fee:          ${BASE_FEE} stroops`);
    console.log(`  Source seq:   ${trustor.sequenceNumber()}`);
    console.log();
    console.log("Transaction envelope XDR:");
    console.log(tx.toEnvelope().toXDR("base64"));
    return;
  }

  tx.sign(keypair);

  console.log("Submitting via Horizon...");
  const horizon = new Horizon.Server(horizonUrl);
  const result = await horizon.submitTransaction(tx);
  console.log();
  console.log(`Transaction successful:`);
  console.log(`  Hash:         ${result.hash}`);
  console.log(`  Ledger:       ${result.ledger}`);
}

main().catch((err) => {
  if (err?.response?.data) {
    console.error("Horizon error:", JSON.stringify(err.response.data, null, 2));
  } else {
    console.error("Error:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
