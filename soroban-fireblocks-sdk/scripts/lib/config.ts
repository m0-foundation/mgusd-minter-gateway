/**
 * Helpers for action scripts.
 *
 * Each script declares its vault + pubkey + per-action args at the top of
 * the file (the VARS block). `buildSigningConfig` reads the environment-level
 * basics (RPC, Fireblocks API, etc.) from `.env` and combines them with the
 * script-supplied vault + pubkey into a complete SorobanFireblocksConfig.
 */

import * as fs from "fs";
import type { SorobanFireblocksConfig } from "../../src/types";

/**
 * Builds a SorobanFireblocksConfig from script-supplied vault + pubkey plus
 * `.env`-supplied environment basics. Exits with a clear error if any required
 * env var is missing.
 */
export function buildSigningConfig(
  fireblocksVaultAccountId: string,
  sourcePublicKey: string,
): SorobanFireblocksConfig {
  const secretPath = requireEnv("FIREBLOCKS_SECRET_PATH");
  return {
    sorobanRpcUrl: requireEnv("SOROBAN_RPC_URL"),
    networkPassphrase: requireEnv("SOROBAN_NETWORK_PASSPHRASE"),
    horizonUrl: requireEnv("HORIZON_URL"),
    fireblocksApiKey: requireEnv("FIREBLOCKS_API_KEY"),
    fireblocksSecretKey: fs.readFileSync(secretPath, "utf8"),
    fireblocksAssetId: requireEnv("FIREBLOCKS_ASSET_ID"),
    fireblocksBasePath: process.env.FIREBLOCKS_BASE_PATH ?? "sandbox",
    fireblocksVaultAccountId,
    sourcePublicKey,
  };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

export function assertStellarAddress(value: string, label: string): string {
  if (!value.startsWith("G") && !value.startsWith("C")) {
    console.error(`${label}: expected Stellar address (G... or C...), got "${value}"`);
    process.exit(1);
  }
  return value;
}
