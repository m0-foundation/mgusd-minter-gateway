import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

export interface Config {
  horizonUrl: string;
  assetCode: string;
  assetIssuer: string;
  /** Ledger sequence to start scanning from */
  startLedger: number;
  /** AWS region for DynamoDB */
  awsRegion: string;
  /** DynamoDB table name for burn records */
  burnsTableName: string;
  /** DynamoDB table name for tracker state (sac_ledger cursor) */
  stateTableName: string;
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
  /** If true, detect and store burns but do not submit reconcile_burn transactions */
  dryRun: boolean;
  /** Slack incoming webhook URL for burn notifications (optional) */
  slackWebhookUrl?: string;
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
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    burnsTableName: process.env.BURNS_TABLE_NAME ?? "Burns",
    stateTableName: process.env.STATE_TABLE_NAME ?? "BurnTrackerState",
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
    dryRun,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,
  };
}
