import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

export interface Config {
  horizonUrl: string;
  assetCode: string;
  assetIssuer: string;
  /** Ledger sequence to start scanning from */
  startLedger: number;
  /** Path to the SQLite database file used to persist burns and the cursor. */
  dbPath: string;
  /** SAC contract address (C...) — used to detect burns via Soroban events */
  sacContractId: string;
  /** Wrapper contract ID (C...) */
  contractId: string;
  /** Soroban RPC URL used by the Fireblocks SDK to submit reconcile_burn */
  sorobanRpcUrl: string;
  /** Stellar network passphrase */
  networkPassphrase: string;
  /** Fireblocks API key */
  fireblocksApiKey: string;
  /** Path to Fireblocks API secret PEM file */
  fireblocksSecretPath: string;
  /** Fireblocks vault account ID for the admin signer */
  fireblocksVaultAccountId: string;
  /** Fireblocks asset ID (e.g. XLM_TEST, XLM) */
  fireblocksAssetId: string;
  /** Fireblocks base path (default: sandbox) */
  fireblocksBasePath: string;
  /** Admin public key (G...) */
  adminPublicKey: string;
  /** How often to retry unreconciled burns, in milliseconds */
  retryPendingIntervalMs: number;
  /** If true, detect and store burns but do not submit reconcile_burn transactions */
  dryRun: boolean;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  const startLedger = parseInt(process.env.START_LEDGER ?? "", 10);
  if (!Number.isInteger(startLedger) || startLedger < 1) {
    throw new Error("START_LEDGER must be a positive integer");
  }

  const dryRun = process.env.DRY_RUN === "true";

  let fireblocksSecretPath = "";
  if (!dryRun) {
    fireblocksSecretPath = requireEnv("FIREBLOCKS_SECRET_PATH");
    if (!fs.existsSync(fireblocksSecretPath)) {
      throw new Error(`FIREBLOCKS_SECRET_PATH file not found: ${fireblocksSecretPath}`);
    }
  }

  return {
    horizonUrl: process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    assetCode: requireEnv("ASSET_CODE"),
    assetIssuer: requireEnv("ASSET_ISSUER"),
    startLedger,
    dbPath: process.env.DB_PATH ?? "./burns.db",
    sacContractId: requireEnv("SAC_CONTRACT_ID"),
    contractId: requireEnv("CONTRACT_ID"),
    sorobanRpcUrl: requireEnv("SOROBAN_RPC_URL"),
    networkPassphrase: dryRun ? "" : requireEnv("SOROBAN_NETWORK_PASSPHRASE"),
    fireblocksApiKey: dryRun ? "" : requireEnv("FIREBLOCKS_API_KEY"),
    fireblocksSecretPath,
    fireblocksVaultAccountId: dryRun ? "" : requireEnv("FIREBLOCKS_VAULT_ACCOUNT_ID"),
    fireblocksAssetId: dryRun ? "" : requireEnv("FIREBLOCKS_ASSET_ID"),
    fireblocksBasePath: process.env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    adminPublicKey: dryRun ? "" : requireEnv("ADMIN_PUBLIC_KEY"),
    retryPendingIntervalMs: parseInt(process.env.RETRY_PENDING_INTERVAL_MS ?? "60000", 10),
    dryRun,
  };
}
