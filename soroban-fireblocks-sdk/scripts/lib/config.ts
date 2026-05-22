/**
 * Role-scoped config loading for operator scripts.
 *
 * Each script declares which role it needs (e.g., "BLOCK_OPERATOR") and only
 * that role's env vars are inspected. A missing `MINTER_PUBLIC_KEY` won't
 * block a `block-user` script from running.
 */

import {
  loadAdminConfigFromEnv,
  loadBlockOperatorConfigFromEnv,
  loadForcedTransferManagerConfigFromEnv,
  loadIssuerConfigFromEnv,
  loadMinterConfigFromEnv,
  loadPauserConfigFromEnv,
  loadUnblockOperatorConfigFromEnv,
  loadYieldRecipientManagerConfigFromEnv,
} from "../../src";
import type { SorobanFireblocksConfig } from "../../src/types";

export type Role =
  | "ADMIN"
  | "MINTER"
  | "PAUSER"
  | "BLOCK_OPERATOR"
  | "UNBLOCK_OPERATOR"
  | "FORCED_TRANSFER_MANAGER"
  | "YIELD_RECIPIENT_MANAGER"
  | "ISSUER";

export function loadConfigForRole(role: Role): SorobanFireblocksConfig {
  switch (role) {
    case "ADMIN": return loadAdminConfigFromEnv();
    case "MINTER": return loadMinterConfigFromEnv();
    case "PAUSER": return loadPauserConfigFromEnv();
    case "BLOCK_OPERATOR": return loadBlockOperatorConfigFromEnv();
    case "UNBLOCK_OPERATOR": return loadUnblockOperatorConfigFromEnv();
    case "FORCED_TRANSFER_MANAGER": return loadForcedTransferManagerConfigFromEnv();
    case "YIELD_RECIPIENT_MANAGER": return loadYieldRecipientManagerConfigFromEnv();
    case "ISSUER": return loadIssuerConfigFromEnv();
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * Resolves a value from `--<flag> <value>` on argv, then `process.env[envVar]`,
 * else exits with a clear error. Used by scripts that accept either form.
 */
export function requireArg(flag: string, envVar: string, argv: string[]): string {
  const idx = argv.indexOf(`--${flag}`);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  console.error(`Missing --${flag} <value> (or env ${envVar})`);
  process.exit(1);
}

export function assertStellarAddress(value: string, label: string): string {
  if (!value.startsWith("G") && !value.startsWith("C")) {
    console.error(`${label}: expected Stellar address (G... or C...), got "${value}"`);
    process.exit(1);
  }
  return value;
}
