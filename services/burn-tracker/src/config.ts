import * as fs from "fs";
import * as dotenv from "dotenv";
import { fetchSecretsFromSsm } from "./secrets";

dotenv.config();

export interface Config {
  horizonUrl: string;
  assetCode: string;
  assetIssuer: string;
  /** Ledger sequence to start scanning from */
  startLedger: number;
  /** AWS region for DynamoDB and SSM */
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
  /** Fireblocks API secret PEM content */
  fireblocksSecretKey: string;
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

export async function loadConfig(): Promise<Config> {
  const startLedger = parseInt(process.env.START_LEDGER ?? "", 10);
  if (!Number.isInteger(startLedger) || startLedger < 1) {
    throw new Error("START_LEDGER must be a positive integer");
  }

  const dryRun = process.env.DRY_RUN === "true";
  const awsRegion = process.env.AWS_REGION ?? "us-east-1";

  let fireblocksSecretKey = "";
  let fireblocksApiKey = "";
  let networkPassphrase = "";
  let fireblocksVaultAccountId = "";
  let adminPublicKey = "";

  if (!dryRun) {
    if (process.env.SSM_FIREBLOCKS_SECRET_PATH) {
      const secrets = await fetchSecretsFromSsm(awsRegion);
      fireblocksSecretKey = secrets.fireblocksSecretKey;
      fireblocksApiKey = secrets.fireblocksApiKey;
      networkPassphrase = secrets.networkPassphrase;
      fireblocksVaultAccountId = secrets.fireblocksVaultAccountId;
      adminPublicKey = secrets.adminPublicKey;
    } else {
      const secretPath = requireEnv("FIREBLOCKS_SECRET_PATH");
      if (!fs.existsSync(secretPath)) {
        throw new Error(`FIREBLOCKS_SECRET_PATH file not found: ${secretPath}`);
      }
      fireblocksSecretKey = fs.readFileSync(secretPath, "utf8");
      fireblocksApiKey = requireEnv("FIREBLOCKS_API_KEY");
      networkPassphrase = requireEnv("SOROBAN_NETWORK_PASSPHRASE");
      fireblocksVaultAccountId = requireEnv("FIREBLOCKS_VAULT_ACCOUNT_ID");
      adminPublicKey = requireEnv("ADMIN_PUBLIC_KEY");
    }
  }

  return {
    horizonUrl: process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    assetCode: requireEnv("ASSET_CODE"),
    assetIssuer: requireEnv("ASSET_ISSUER"),
    startLedger,
    awsRegion,
    burnsTableName: requireEnv("DYNAMODB_BURNS_TABLE"),
    stateTableName: requireEnv("DYNAMODB_STATE_TABLE"),
    sacContractId: requireEnv("SAC_CONTRACT_ID"),
    contractId: requireEnv("CONTRACT_ID"),
    sorobanRpcUrl: requireEnv("SOROBAN_RPC_URL"),
    networkPassphrase,
    fireblocksApiKey,
    fireblocksSecretKey,
    fireblocksVaultAccountId,
    fireblocksAssetId: dryRun ? "" : requireEnv("FIREBLOCKS_ASSET_ID"),
    fireblocksBasePath: process.env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    adminPublicKey,
    dryRun,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,
  };
}
