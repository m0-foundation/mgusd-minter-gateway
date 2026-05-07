import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

export interface Config {
  horizonUrl: string;
  assetCode: string;
  assetIssuer: string;
  /** Ledger sequence to start scanning from */
  startLedger: number;
  /** Path to the JSON file used to persist burns and the cursor. */
  storageFile: string;
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

  const fireblocksSecretPath = requireEnv("FIREBLOCKS_SECRET_PATH");
  if (!fs.existsSync(fireblocksSecretPath)) {
    throw new Error(`FIREBLOCKS_SECRET_PATH file not found: ${fireblocksSecretPath}`);
  }

  return {
    horizonUrl: process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    assetCode: requireEnv("ASSET_CODE"),
    assetIssuer: requireEnv("ASSET_ISSUER"),
    startLedger,
    storageFile: process.env.STORAGE_FILE ?? "./burns.json",
    contractId: requireEnv("CONTRACT_ID"),
    sorobanRpcUrl: requireEnv("SOROBAN_RPC_URL"),
    networkPassphrase: requireEnv("SOROBAN_NETWORK_PASSPHRASE"),
    fireblocksApiKey: requireEnv("FIREBLOCKS_API_KEY"),
    fireblocksSecretPath,
    fireblocksVaultAccountId: requireEnv("FIREBLOCKS_VAULT_ACCOUNT_ID"),
    fireblocksAssetId: requireEnv("FIREBLOCKS_ASSET_ID"),
    fireblocksBasePath: process.env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    adminPublicKey: requireEnv("ADMIN_PUBLIC_KEY"),
  };
}
