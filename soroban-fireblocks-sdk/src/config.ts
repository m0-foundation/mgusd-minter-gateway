import * as fs from "fs";
import { ConfigError } from "./errors";
import { SorobanFireblocksConfig } from "./types";

export function readFireblocksSecret(secretPath: string): string {
  try {
    return fs.readFileSync(secretPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to read Fireblocks secret at ${secretPath}: ${message}`);
  }
}

export function validateConfig(config: SorobanFireblocksConfig): void {
  const required: Array<[keyof SorobanFireblocksConfig, string]> = [
    ["sorobanRpcUrl", "SOROBAN_RPC_URL"],
    ["networkPassphrase", "SOROBAN_NETWORK_PASSPHRASE"],
    ["fireblocksApiKey", "FIREBLOCKS_API_KEY"],
    ["fireblocksSecretKey", "Fireblocks secret key"],
    ["fireblocksVaultAccountId", "FIREBLOCKS_VAULT_ACCOUNT_ID"],
    ["fireblocksAssetId", "FIREBLOCKS_ASSET_ID"],
    ["sourcePublicKey", "SOURCE_PUBLIC_KEY"],
  ];

  for (const [key, label] of required) {
    if (!config[key]) {
      throw new ConfigError(`Missing required config: ${label}`);
    }
  }

  if (!config.sourcePublicKey.startsWith("G")) {
    throw new ConfigError("SOURCE_PUBLIC_KEY must be a valid Stellar public key starting with G");
  }
}

export function loadConfigFromEnv(): SorobanFireblocksConfig {
  const secretPath = process.env.FIREBLOCKS_SECRET_PATH;
  if (!secretPath) {
    throw new ConfigError("Missing required env var: FIREBLOCKS_SECRET_PATH");
  }

  const fireblocksSecretKey = readFireblocksSecret(secretPath);

  const config: SorobanFireblocksConfig = {
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "",
    networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE ?? "",
    fireblocksApiKey: process.env.FIREBLOCKS_API_KEY ?? "",
    fireblocksSecretKey,
    fireblocksVaultAccountId: process.env.FIREBLOCKS_VAULT_ACCOUNT_ID ?? "",
    fireblocksAssetId: process.env.FIREBLOCKS_ASSET_ID ?? "",
    fireblocksBasePath: process.env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    sourcePublicKey: process.env.SOURCE_PUBLIC_KEY ?? "",
  };

  validateConfig(config);
  return config;
}

function loadRoleConfigFromEnv(role: "ISSUER" | "MINTER"): SorobanFireblocksConfig {
  const secretPath = process.env.FIREBLOCKS_SECRET_PATH;
  if (!secretPath) {
    throw new ConfigError("Missing required env var: FIREBLOCKS_SECRET_PATH");
  }

  const fireblocksSecretKey = readFireblocksSecret(secretPath);

  const vaultKey = `${role}_FIREBLOCKS_VAULT_ACCOUNT_ID`;
  const publicKeyKey = `${role}_PUBLIC_KEY`;

  const config: SorobanFireblocksConfig = {
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "",
    networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE ?? "",
    fireblocksApiKey: process.env.FIREBLOCKS_API_KEY ?? "",
    fireblocksSecretKey,
    fireblocksVaultAccountId: process.env[vaultKey] ?? "",
    fireblocksAssetId: process.env.FIREBLOCKS_ASSET_ID ?? "",
    fireblocksBasePath: process.env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    sourcePublicKey: process.env[publicKeyKey] ?? "",
  };

  validateConfig(config);
  return config;
}

export function loadIssuerConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("ISSUER");
}

export function loadMinterConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("MINTER");
}
