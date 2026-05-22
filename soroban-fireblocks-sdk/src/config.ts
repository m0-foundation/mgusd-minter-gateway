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
    ["horizonUrl", "HORIZON_URL"],
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
    horizonUrl: process.env.HORIZON_URL ?? "",
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

function loadRoleConfigFromEnv(
  role:
    | "ISSUER"
    | "MINTER"
    | "PAUSER"
    | "ADMIN"
    | "BLOCK_OPERATOR"
    | "UNBLOCK_OPERATOR"
    | "FORCED_TRANSFER_MANAGER"
    | "YIELD_RECIPIENT_MANAGER",
): SorobanFireblocksConfig {
  const secretPath = process.env.FIREBLOCKS_SECRET_PATH;
  if (!secretPath) {
    throw new ConfigError("Missing required env var: FIREBLOCKS_SECRET_PATH");
  }

  const fireblocksSecretKey = readFireblocksSecret(secretPath);

  const vaultKey = `${role}_FIREBLOCKS_VAULT_ACCOUNT_ID`;
  const publicKeyKey = `${role}_PUBLIC_KEY`;

  const config: SorobanFireblocksConfig = {
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "",
    horizonUrl: process.env.HORIZON_URL ?? "",
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

export function loadPauserConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("PAUSER");
}

export function loadAdminConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("ADMIN");
}

export function loadBlockOperatorConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("BLOCK_OPERATOR");
}

export function loadUnblockOperatorConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("UNBLOCK_OPERATOR");
}

export function loadForcedTransferManagerConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("FORCED_TRANSFER_MANAGER");
}

export function loadYieldRecipientManagerConfigFromEnv(): SorobanFireblocksConfig {
  return loadRoleConfigFromEnv("YIELD_RECIPIENT_MANAGER");
}

/**
 * Validates only the read-side fields (RPC, passphrase, Horizon). Used by
 * `loadReadOnlyConfigFromEnv` so view commands don't require Fireblocks creds.
 */
export function validateReadOnlyConfig(config: SorobanFireblocksConfig): void {
  const required: Array<[keyof SorobanFireblocksConfig, string]> = [
    ["sorobanRpcUrl", "SOROBAN_RPC_URL"],
    ["horizonUrl", "HORIZON_URL"],
    ["networkPassphrase", "SOROBAN_NETWORK_PASSPHRASE"],
  ];

  for (const [key, label] of required) {
    if (!config[key]) {
      throw new ConfigError(`Missing required config: ${label}`);
    }
  }
}

/**
 * Loads a minimal config sufficient for view (read-only) operations.
 * Skips Fireblocks credentials; `sourcePublicKey` falls back to any
 * configured role pubkey because Soroban simulation still requires a
 * funded source account on the network for sequence/fee bookkeeping
 * (no value is moved). The returned config can be passed to
 * `SctokenFireblocksClient` for query methods, which never sign.
 */
export function loadReadOnlyConfigFromEnv(): SorobanFireblocksConfig {
  const config: SorobanFireblocksConfig = {
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "",
    horizonUrl: process.env.HORIZON_URL ?? "",
    networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE ?? "",
    fireblocksApiKey: "",
    fireblocksSecretKey: "",
    fireblocksVaultAccountId: "",
    fireblocksAssetId: "",
    fireblocksBasePath: process.env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    sourcePublicKey: resolveViewSourcePublicKey(),
  };

  validateReadOnlyConfig(config);
  return config;
}

/**
 * Picks any configured role pubkey to use as the simulation source for view
 * commands. Soroban view simulation needs a real funded source account for
 * sequence/fee bookkeeping; nothing is signed or paid. Preference is just
 * "first that looks valid". Caller can override with VIEW_SOURCE_PUBLIC_KEY.
 */
function resolveViewSourcePublicKey(): string {
  const explicit = process.env.VIEW_SOURCE_PUBLIC_KEY;
  if (explicit && explicit.startsWith("G")) return explicit;

  const candidates = [
    "BLOCK_OPERATOR_PUBLIC_KEY",
    "UNBLOCK_OPERATOR_PUBLIC_KEY",
    "ADMIN_PUBLIC_KEY",
    "MINTER_PUBLIC_KEY",
    "PAUSER_PUBLIC_KEY",
    "FORCED_TRANSFER_MANAGER_PUBLIC_KEY",
    "YIELD_RECIPIENT_MANAGER_PUBLIC_KEY",
    "ISSUER_PUBLIC_KEY",
  ];
  for (const name of candidates) {
    const value = process.env[name];
    if (value && value.startsWith("G") && value.length > 10) return value;
  }
  throw new ConfigError(
    "View commands need a Stellar source account for simulation. Set VIEW_SOURCE_PUBLIC_KEY or any *_PUBLIC_KEY env var.",
  );
}
