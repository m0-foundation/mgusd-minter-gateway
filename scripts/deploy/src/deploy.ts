/**
 * Stellar Minter Gateway — Fireblocks deploy pipeline
 *
 * Five-step pipeline, all signed by the issuer Fireblocks vault:
 *   0. (preflight)  Refuse to deploy if the issuer has any pre-flag on-chain footprint
 *   1. configure_issuer  AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED
 *   2. deploy_sac        Stellar Asset Contract for (asset_code, issuer)
 *   3. upload_wasm       wrapper bytecode (with local sha256 verify)
 *   4. deploy_contract   wrapper + 9 constructor args (SAC + 8 role addresses)
 *   5. set_admin         hand SAC admin to wrapper
 *
 * Multi-approver Fireblocks policy (e.g. 2-of-3) is configured INSIDE Fireblocks;
 * this script just submits and polls. All 8 wrapper roles are read from
 * independent env vars — no role collapse.
 *
 * Modes:
 *   --dry-run   (default) build + simulate + print XDR for every step; no Fireblocks call
 *   --execute   actually submit. On --network=public, requires interactive passphrase confirm.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { createHash } from "crypto";
import * as dotenv from "dotenv";
import {
  Address,
  Horizon,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";

import {
  createFireblocksClient,
  FireblocksConfig,
  signHash,
} from "./fireblocks";
import {
  addSignatureToTransaction,
  buildConfigureIssuerTransaction,
  buildDeployContractTransaction,
  buildDeploySacTransaction,
  buildInvokeTransaction,
  buildUploadWasmTransaction,
  createRpcServer,
  simulateAndPrepare,
  SorobanContext,
  submitAndPoll,
} from "./soroban";

// =============================================================================
// Errors
// =============================================================================

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}

export class FireblocksSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FireblocksSigningError";
  }
}

export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

export class WasmHashMismatchError extends Error {
  constructor(
    message: string,
    public readonly expectedHash: string,
    public readonly actualHash: string | undefined,
    public readonly txHash?: string,
  ) {
    super(message);
    this.name = "WasmHashMismatchError";
  }
}

export interface IssuerContaminationCounts {
  trustlines: number;
  claimableBalances: number;
  liquidityPools: number;
  contracts: number;
}

export class IssuerContaminatedError extends Error {
  constructor(
    message: string,
    public readonly assetCode: string,
    public readonly assetIssuer: string,
    public readonly counts: IssuerContaminationCounts,
  ) {
    super(message);
    this.name = "IssuerContaminatedError";
  }
}

// =============================================================================
// scval helpers
// =============================================================================

export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

export function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

// =============================================================================
// Network derivation
// =============================================================================

export type StellarNetwork = "testnet" | "public";

export interface NetworkConfig {
  network: StellarNetwork;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";
const MAINNET_RPC = "https://soroban.stellar.org";
const MAINNET_HORIZON = "https://horizon.stellar.org";

export function deriveNetworkConfig(
  network: StellarNetwork,
  overrides: { rpcUrl?: string; horizonUrl?: string } = {},
): NetworkConfig {
  if (network === "testnet") {
    return {
      network,
      rpcUrl: overrides.rpcUrl ?? TESTNET_RPC,
      horizonUrl: overrides.horizonUrl ?? TESTNET_HORIZON,
      networkPassphrase: Networks.TESTNET,
    };
  }
  if (network === "public") {
    return {
      network,
      rpcUrl: overrides.rpcUrl ?? MAINNET_RPC,
      horizonUrl: overrides.horizonUrl ?? MAINNET_HORIZON,
      networkPassphrase: Networks.PUBLIC,
    };
  }
  throw new ConfigError(
    `Unknown STELLAR_NETWORK: ${network}. Must be 'testnet' or 'public'.`,
  );
}

// =============================================================================
// Horizon contamination check
// =============================================================================

/**
 * Refuses to deploy when the (asset_code, issuer) pair already has any
 * on-chain footprint. Stellar binds clawback eligibility to a trustline at
 * trustline-creation time; any pre-flag holder is permanently unclawbackable
 * and creates an irreversible compliance hole.
 */
export async function assertIssuerNotContaminated(
  horizon: Horizon.Server,
  assetCode: string,
  assetIssuer: string,
): Promise<void> {
  const result = await horizon.assets().forCode(assetCode).forIssuer(assetIssuer).call();

  const record = result.records[0];
  if (!record) {
    return; // asset unknown to Horizon — nobody has touched it
  }

  const accounts = record.accounts;
  const counts: IssuerContaminationCounts = {
    trustlines:
      accounts.authorized +
      accounts.authorized_to_maintain_liabilities +
      accounts.unauthorized,
    claimableBalances: record.num_claimable_balances,
    liquidityPools: record.num_liquidity_pools,
    contracts: record.num_contracts,
  };

  const total =
    counts.trustlines + counts.claimableBalances + counts.liquidityPools + counts.contracts;

  if (total > 0) {
    throw new IssuerContaminatedError(
      `Issuer ${assetIssuer} has prior on-chain footprint for asset ${assetCode}: ` +
        `${counts.trustlines} trustline(s), ${counts.claimableBalances} claimable balance(s), ` +
        `${counts.liquidityPools} liquidity pool(s), ${counts.contracts} contract holder(s). ` +
        `Trustlines opened before AUTH_CLAWBACK_ENABLED is set are permanently ` +
        `unclawbackable. Provision a fresh issuer keypair before deploy.`,
      assetCode,
      assetIssuer,
      counts,
    );
  }
}

// =============================================================================
// Env loading
// =============================================================================

export interface DeployEnv {
  network: NetworkConfig;
  assetCode: string;
  wasmPath: string;
  issuerPublicKey: string;
  /**
   * Optional 32-byte salt (hex) for the wrapper contract deployment.
   * When set, the wrapper contract ID is deterministic and can be predicted
   * with `predict-contract-id.sh` before running deploy.
   * When unset, a random salt is generated by the SDK each time.
   */
  deployerSalt?: Buffer;
  fireblocks: FireblocksConfig;
  roles: WrapperRoles;
}

export interface WrapperRoles {
  admin: string;
  minter: string;
  yieldRecipientManager: string;
  yieldRecipient: string;
  forcedTransferManager: string;
  blockOperator: string;
  unblockOperator: string;
  pauser: string;
}

const ROLE_ENV_VARS: Array<[keyof WrapperRoles, string]> = [
  ["admin", "ADMIN_PUBLIC_KEY"],
  ["minter", "MINTER_PUBLIC_KEY"],
  ["yieldRecipientManager", "YIELD_RECIPIENT_MANAGER_PUBLIC_KEY"],
  ["yieldRecipient", "YIELD_RECIPIENT_PUBLIC_KEY"],
  ["forcedTransferManager", "FORCED_TRANSFER_MANAGER_PUBLIC_KEY"],
  ["blockOperator", "BLOCK_OPERATOR_PUBLIC_KEY"],
  ["unblockOperator", "UNBLOCK_OPERATOR_PUBLIC_KEY"],
  ["pauser", "PAUSER_PUBLIC_KEY"],
];

/**
 * Read a Stellar G-prefixed pubkey from env, throwing if missing or invalid.
 * Every privileged role must be its own env var — see ROLE_ENV_VARS.
 */
export function requireRolePubkey(
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const v = env[envName];
  if (!v) {
    throw new ConfigError(`Missing required env var: ${envName}`);
  }
  try {
    Keypair.fromPublicKey(v);
  } catch {
    throw new ConfigError(`${envName} is not a valid Stellar pubkey: ${v}`);
  }
  return v;
}

export function loadDeployEnv(
  env: NodeJS.ProcessEnv = process.env,
  cliNetwork?: StellarNetwork,
): DeployEnv {
  const networkName = (cliNetwork ?? env.STELLAR_NETWORK ?? "").toLowerCase();
  if (networkName !== "testnet" && networkName !== "public") {
    throw new ConfigError(
      `STELLAR_NETWORK must be 'testnet' or 'public' (got: '${networkName || "unset"}'). ` +
        `Pass --network=testnet|public or set STELLAR_NETWORK in .env.`,
    );
  }

  const network = deriveNetworkConfig(networkName as StellarNetwork, {
    rpcUrl: env.SOROBAN_RPC_URL,
    horizonUrl: env.HORIZON_URL,
  });

  const issuerPublicKey = requireRolePubkey("ISSUER_PUBLIC_KEY", env);
  const assetCode = env.ASSET_CODE ?? "TMGUSD";
  const wasmPath =
    env.WASM_PATH ?? "./target/wasm32v1-none/release/mintergateway.wasm";

  const deployerSalt = parseSalt(env.DEPLOYER_SALT);

  // Each role read from its own env var. Failing to set any one of them
  // aborts the deploy — there is no role-collapsing default.
  const roles: WrapperRoles = {
    admin: requireRolePubkey("ADMIN_PUBLIC_KEY", env),
    minter: requireRolePubkey("MINTER_PUBLIC_KEY", env),
    yieldRecipientManager: requireRolePubkey("YIELD_RECIPIENT_MANAGER_PUBLIC_KEY", env),
    yieldRecipient: requireRolePubkey("YIELD_RECIPIENT_PUBLIC_KEY", env),
    forcedTransferManager: requireRolePubkey("FORCED_TRANSFER_MANAGER_PUBLIC_KEY", env),
    blockOperator: requireRolePubkey("BLOCK_OPERATOR_PUBLIC_KEY", env),
    unblockOperator: requireRolePubkey("UNBLOCK_OPERATOR_PUBLIC_KEY", env),
    pauser: requireRolePubkey("PAUSER_PUBLIC_KEY", env),
  };

  const fireblocks = loadFireblocksConfig(env);

  return { network, assetCode, wasmPath, issuerPublicKey, deployerSalt, fireblocks, roles };
}

export function parseSalt(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ConfigError(
      `DEPLOYER_SALT must be a 64-character hex string (32 bytes), got: '${raw}'`,
    );
  }
  return Buffer.from(raw, "hex");
}

/**
 * Reads Fireblocks env vars and returns a config. Does NOT read the
 * secret PEM file — `createFireblocksClient` reads it lazily at sign
 * time, so dry-run mode never touches the file.
 */
export function loadFireblocksConfig(env: NodeJS.ProcessEnv): FireblocksConfig {
  const apiKey = env.FIREBLOCKS_API_KEY;
  const secretPath = env.FIREBLOCKS_SECRET_PATH;
  const vaultAccountId = env.FIREBLOCKS_VAULT_ACCOUNT_ID;
  const assetId = env.FIREBLOCKS_ASSET_ID;

  if (!apiKey) throw new ConfigError("Missing required env var: FIREBLOCKS_API_KEY");
  if (!secretPath) throw new ConfigError("Missing required env var: FIREBLOCKS_SECRET_PATH");
  if (!vaultAccountId)
    throw new ConfigError("Missing required env var: FIREBLOCKS_VAULT_ACCOUNT_ID");
  if (!assetId) throw new ConfigError("Missing required env var: FIREBLOCKS_ASSET_ID");

  const pollTimeoutSeconds = parseInt(env.FIREBLOCKS_POLL_TIMEOUT_SECONDS ?? "600", 10);
  if (Number.isNaN(pollTimeoutSeconds) || pollTimeoutSeconds < 1) {
    throw new ConfigError(
      `FIREBLOCKS_POLL_TIMEOUT_SECONDS must be a positive integer (got: ${env.FIREBLOCKS_POLL_TIMEOUT_SECONDS})`,
    );
  }

  return {
    apiKey,
    secretPath,
    basePath: env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    vaultAccountId,
    assetId,
    pollTimeoutSeconds,
  };
}

// =============================================================================
// Deploy result
// =============================================================================

export interface DeployFullResult {
  sacContractId: string;
  wasmHash: string;
  wrapperContractId: string;
}

// =============================================================================
// DeployClient — five-step pipeline
// =============================================================================

export interface DeployClientDeps {
  /** Inject for tests; defaults are constructed from `env`. */
  rpc?: rpc.Server;
  horizon?: Horizon.Server;
  fireblocksSign?: (hashHex: string) => Promise<string>;
  /** Override `simulateAndPrepare` (lets dry-run skip simulation in tests). */
  simulate?: (tx: Transaction) => Promise<Transaction>;
  /** Override `submitAndPoll`. */
  submit?: (tx: Transaction) => Promise<rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse>;
  /** Where to write per-step status (defaults to console.log). */
  log?: (msg: string) => void;
}

export class DeployClient {
  private readonly env: DeployEnv;
  private readonly server: rpc.Server;
  private readonly horizon: Horizon.Server;
  private readonly sorobanCtx: SorobanContext;
  private readonly fireblocksSign: (hashHex: string) => Promise<string>;
  private readonly simulate: (tx: Transaction) => Promise<Transaction>;
  private readonly submit: (
    tx: Transaction,
  ) => Promise<rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse>;
  private readonly log: (msg: string) => void;

  constructor(env: DeployEnv, deps: DeployClientDeps = {}) {
    this.env = env;
    this.server = deps.rpc ?? createRpcServer(env.network.rpcUrl);
    this.horizon = deps.horizon ?? new Horizon.Server(env.network.horizonUrl);
    this.sorobanCtx = {
      rpcUrl: env.network.rpcUrl,
      networkPassphrase: env.network.networkPassphrase,
      sourcePublicKey: env.issuerPublicKey,
    };

    if (deps.fireblocksSign) {
      this.fireblocksSign = deps.fireblocksSign;
    } else {
      // Lazy: read the PEM file only on the first actual sign call so that
      // dry-run mode never requires the secret file to exist on disk.
      let fb: ReturnType<typeof createFireblocksClient> | null = null;
      this.fireblocksSign = async (hashHex: string) => {
        if (!fb) fb = createFireblocksClient(env.fireblocks);
        const result = await signHash(fb, env.fireblocks, hashHex);
        return result.signatureHex;
      };
    }

    this.simulate = deps.simulate ?? ((tx) => simulateAndPrepare(this.server, tx));
    this.submit = deps.submit ?? ((tx) => submitAndPoll(this.server, tx));
    this.log = deps.log ?? ((msg) => console.log(msg));
  }

  /**
   * Builds a tx for each of the 5 steps + simulates Soroban steps. Returns
   * each step's name + envelope XDR + tx hash. Used by --dry-run mode.
   *
   * Step 4 (deploy_contract) and step 5 (set_admin) cannot be planned in
   * dry-run because they depend on Step 2 (sacContractId) and Step 4
   * (wrapperContractId) actually completing. We surface that by returning
   * placeholder entries that explain why.
   */
  async planXdr(wasm: Buffer): Promise<Array<{ step: string; xdr: string; txHash: string }>> {
    const plan: Array<{ step: string; xdr: string; txHash: string }> = [];

    // Step 1
    const step1 = await buildConfigureIssuerTransaction(this.server, this.sorobanCtx);
    plan.push({
      step: "1/5 configure_issuer (set_options AUTH_REQUIRED|REVOCABLE|CLAWBACK_ENABLED)",
      xdr: step1.toEnvelope().toXDR("base64"),
      txHash: step1.hash().toString("hex"),
    });

    // Step 2 — needs simulation
    const step2Raw = await buildDeploySacTransaction(this.server, this.sorobanCtx, {
      assetCode: this.env.assetCode,
      assetIssuer: this.env.issuerPublicKey,
    });
    const step2 = await this.simulate(step2Raw);
    plan.push({
      step: `2/5 deploy_sac (${this.env.assetCode}:${this.env.issuerPublicKey})`,
      xdr: step2.toEnvelope().toXDR("base64"),
      txHash: step2.hash().toString("hex"),
    });

    // Step 3 — needs simulation
    const step3Raw = await buildUploadWasmTransaction(this.server, this.sorobanCtx, { wasm });
    const step3 = await this.simulate(step3Raw);
    const expectedWasmHash = createHash("sha256").update(wasm).digest("hex");
    plan.push({
      step: `3/5 upload_wasm (sha256=${expectedWasmHash})`,
      xdr: step3.toEnvelope().toXDR("base64"),
      txHash: step3.hash().toString("hex"),
    });

    // Steps 4 and 5 require runtime values from steps 2-4. Document why.
    plan.push({
      step: "4/5 deploy_contract (depends on Step 2 SAC contract id — only buildable at execute time)",
      xdr: "(deferred)",
      txHash: "(deferred)",
    });
    plan.push({
      step: "5/5 set_admin (depends on Step 4 wrapper contract id — only buildable at execute time)",
      xdr: "(deferred)",
      txHash: "(deferred)",
    });

    return plan;
  }

  async deployFull(wasm: Buffer): Promise<DeployFullResult> {
    // Step 0 — issuer contamination preflight
    this.log("Step 0/5: Checking issuer for pre-flag trustline contamination...");
    await assertIssuerNotContaminated(this.horizon, this.env.assetCode, this.env.issuerPublicKey);
    this.log("  Issuer is clean — no pre-existing trustlines or claimable balances");

    // Step 1 — configure issuer (classic op, no simulation)
    this.log("Step 1/5: Configuring issuer flags...");
    const issuerTx = await buildConfigureIssuerTransaction(this.server, this.sorobanCtx);
    await this.signAndSubmit(issuerTx, "configureIssuer");
    this.log("  Issuer configured");

    // Step 2 — deploy SAC
    this.log("Step 2/5: Deploying SAC...");
    const sacRaw = await buildDeploySacTransaction(this.server, this.sorobanCtx, {
      assetCode: this.env.assetCode,
      assetIssuer: this.env.issuerPublicKey,
    });
    const sacResult = await this.signSimulateSubmitSoroban(sacRaw, "deploySac");
    const sacContractId = sacResult.returnValue
      ? Address.fromScVal(sacResult.returnValue).toString()
      : undefined;
    if (!sacContractId) {
      throw new Error("deploySac did not return a contract id");
    }
    this.log(`  SAC deployed: ${sacContractId}`);

    // Step 3 — upload WASM, then verify the RPC's returned hash matches
    // sha256(wasm) computed locally. A compromised RPC could otherwise
    // return the hash of attacker-controlled bytecode already on-chain,
    // which downstream deployContract / set_admin would deploy and grant
    // SAC admin to.
    this.log("Step 3/5: Uploading WASM...");
    const expectedWasmHash = createHash("sha256").update(wasm).digest("hex");
    const wasmRaw = await buildUploadWasmTransaction(this.server, this.sorobanCtx, { wasm });
    const wasmResult = await this.signSimulateSubmitSoroban(wasmRaw, "uploadWasm");
    const actualWasmHash = wasmResult.returnValue
      ? wasmResult.returnValue.bytes().toString("hex")
      : undefined;
    if (actualWasmHash !== expectedWasmHash) {
      throw new WasmHashMismatchError(
        `uploadWasm hash mismatch: expected sha256(wasm)=${expectedWasmHash}, ` +
          `RPC returned ${actualWasmHash ?? "no returnValue"}`,
        expectedWasmHash,
        actualWasmHash,
      );
    }
    const wasmHashBuf = Buffer.from(expectedWasmHash, "hex");
    this.log(`  WASM uploaded: ${expectedWasmHash}`);

    // Step 4 — deploy wrapper
    this.log("Step 4/5: Deploying wrapper contract...");
    const r = this.env.roles;
    const constructorArgs: xdr.ScVal[] = [
      addressToScVal(sacContractId),
      addressToScVal(r.admin),
      addressToScVal(r.minter),
      addressToScVal(r.yieldRecipientManager),
      addressToScVal(r.yieldRecipient),
      addressToScVal(r.forcedTransferManager),
      addressToScVal(r.blockOperator),
      addressToScVal(r.unblockOperator),
      addressToScVal(r.pauser),
    ];
    const wrapperRaw = await buildDeployContractTransaction(this.server, this.sorobanCtx, {
      wasmHash: wasmHashBuf,
      constructorArgs,
      salt: this.env.deployerSalt,
    });
    const wrapperResult = await this.signSimulateSubmitSoroban(wrapperRaw, "deployContract");
    const wrapperContractId = wrapperResult.returnValue
      ? Address.fromScVal(wrapperResult.returnValue).toString()
      : undefined;
    if (!wrapperContractId) {
      throw new Error("deployContract did not return a contract id");
    }
    this.log(`  Wrapper deployed: ${wrapperContractId}`);

    // Step 5 — transfer SAC admin
    this.log("Step 5/5: Transferring SAC admin to wrapper...");
    const setAdminRaw = await buildInvokeTransaction(this.server, this.sorobanCtx, {
      contractId: sacContractId,
      method: "set_admin",
      args: [addressToScVal(wrapperContractId)],
    });
    await this.signSimulateSubmitSoroban(setAdminRaw, "set_admin");
    this.log("  SAC admin transferred to wrapper");

    return {
      sacContractId,
      wasmHash: expectedWasmHash,
      wrapperContractId,
    };
  }

  private async signAndSubmit(tx: Transaction, label: string): Promise<void> {
    const hashHex = tx.hash().toString("hex");
    const sigHex = await this.fireblocksSign(hashHex);
    const signed = addSignatureToTransaction(tx, this.env.issuerPublicKey, sigHex);
    const result = await this.submit(signed);
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SubmissionError(`${label} failed`, hashHex);
    }
  }

  private async signSimulateSubmitSoroban(
    rawTx: Transaction,
    label: string,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const prepared = await this.simulate(rawTx);
    const hashHex = prepared.hash().toString("hex");
    const sigHex = await this.fireblocksSign(hashHex);
    const signed = addSignatureToTransaction(prepared, this.env.issuerPublicKey, sigHex);
    const result = await this.submit(signed);
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SubmissionError(`${label} failed`, hashHex);
    }
    return result as rpc.Api.GetSuccessfulTransactionResponse;
  }
}

// =============================================================================
// CLI entry
// =============================================================================

export interface CliArgs {
  mode: "dry-run" | "execute";
  networkOverride?: StellarNetwork;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let mode: "dry-run" | "execute" = "dry-run";
  let networkOverride: StellarNetwork | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--execute") mode = "execute";
    else if (arg.startsWith("--network=")) {
      const value = arg.slice("--network=".length).toLowerCase();
      if (value === "testnet" || value === "public") {
        networkOverride = value;
      } else {
        throw new ConfigError(
          `Invalid --network value: '${value}' (must be 'testnet' or 'public')`,
        );
      }
    }
  }

  return { mode, networkOverride };
}

/**
 * Echo the network passphrase and demand it back from stdin before submitting.
 * Mainnet-only guard for `--execute`.
 */
export async function confirmMainnetPassphrase(
  expectedPassphrase: string,
  rl: readline.Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  }),
  closeRl: boolean = true,
): Promise<void> {
  const prompt = `\nMAINNET DEPLOY — type the network passphrase to confirm:\n  > `;
  const answer: string = await new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
  if (closeRl) rl.close();
  if (answer.trim() !== expectedPassphrase) {
    throw new ConfigError(
      `Passphrase mismatch — aborting. Expected '${expectedPassphrase}', got '${answer.trim()}'.`,
    );
  }
}

/**
 * Repo root. `__dirname` resolves to `scripts/deploy/src/`, so three
 * levels up is the repo root regardless of the cwd `npm run` is invoked
 * from.
 */
export const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Path to the repo-root `.env` shared by both deploy paths. */
export const ROOT_ENV_PATH = path.resolve(REPO_ROOT, ".env");

/**
 * Resolve `WASM_PATH` against the repo root if it's relative. Lets users
 * keep the same default value the bash script uses (`./target/...`)
 * regardless of where they run `npm` from.
 */
export function resolveWasmPath(wasmPath: string): string {
  return path.isAbsolute(wasmPath) ? wasmPath : path.resolve(REPO_ROOT, wasmPath);
}

async function main(): Promise<void> {
  dotenv.config({ path: ROOT_ENV_PATH });
  const args = parseCliArgs(process.argv.slice(2));
  const env = loadDeployEnv(process.env, args.networkOverride);

  const resolvedWasmPath = resolveWasmPath(env.wasmPath);
  if (!fs.existsSync(resolvedWasmPath)) {
    throw new ConfigError(`WASM not found: ${resolvedWasmPath}. Run 'make build' first.`);
  }
  const wasm = fs.readFileSync(resolvedWasmPath);

  console.log("=== Stellar Minter Gateway — Fireblocks Deploy ===");
  console.log(`  Mode:       ${args.mode}`);
  console.log(`  Network:    ${env.network.network} (${env.network.networkPassphrase})`);
  console.log(`  RPC:        ${env.network.rpcUrl}`);
  console.log(`  Horizon:    ${env.network.horizonUrl}`);
  console.log(`  Asset:      ${env.assetCode}:${env.issuerPublicKey}`);
  console.log(`  WASM:       ${resolvedWasmPath} (${wasm.length} bytes)`);
  console.log(`  Salt:       ${env.deployerSalt ? env.deployerSalt.toString("hex") : "(random — set DEPLOYER_SALT for deterministic contract ID)"}`);
  console.log(`  FB vault:   ${env.fireblocks.vaultAccountId}  (asset ${env.fireblocks.assetId}, base ${env.fireblocks.basePath})`);
  console.log();
  console.log("  Roles:");
  for (const [role, envName] of ROLE_ENV_VARS) {
    console.log(`    ${envName.padEnd(40)} = ${env.roles[role]}`);
  }
  const uniqueRoles = new Set(Object.values(env.roles));
  if (uniqueRoles.size < ROLE_ENV_VARS.length) {
    console.warn(`\n  WARNING: only ${uniqueRoles.size} distinct role pubkeys — role separation reduced.`);
  }
  console.log();

  if (args.mode === "dry-run") {
    console.log("=== Dry-run — building XDR for each step (no Fireblocks calls) ===");
    const client = new DeployClient(env);
    const plan = await client.planXdr(wasm);
    for (const step of plan) {
      console.log();
      console.log(`Step ${step.step}`);
      console.log(`  tx hash: ${step.txHash}`);
      console.log(`  xdr:     ${step.xdr}`);
    }
    console.log();
    console.log("Dry-run complete. Re-run with --execute to actually submit.");
    return;
  }

  // execute mode
  if (env.network.network === "public") {
    await confirmMainnetPassphrase(env.network.networkPassphrase);
  }

  const client = new DeployClient(env);
  const result = await client.deployFull(wasm);

  console.log();
  console.log("=== Deploy Complete ===");
  console.log(`  SAC Contract ID:     ${result.sacContractId}`);
  console.log(`  WASM Hash:           ${result.wasmHash}`);
  console.log(`  Wrapper Contract ID: ${result.wrapperContractId}`);
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
