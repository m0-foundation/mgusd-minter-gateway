import {
  loadAdminConfigFromEnv,
  loadBlockOperatorConfigFromEnv,
  loadForcedTransferManagerConfigFromEnv,
  loadIssuerConfigFromEnv,
  loadMinterConfigFromEnv,
  loadPauserConfigFromEnv,
  loadReadOnlyConfigFromEnv,
  loadUnblockOperatorConfigFromEnv,
  loadYieldRecipientManagerConfigFromEnv,
} from "../../src";
import type { SorobanFireblocksConfig } from "../../src/types";
import type { CommandRole } from "./types";

/**
 * Loads the SorobanFireblocksConfig for exactly one role. Unrelated role env
 * vars are never inspected, so a command for a role you don't own runs against
 * its own clean error message and nothing else.
 */
export function loadConfigForRole(role: CommandRole): SorobanFireblocksConfig {
  switch (role) {
    case "ADMIN":
      return loadAdminConfigFromEnv();
    case "MINTER":
      return loadMinterConfigFromEnv();
    case "PAUSER":
      return loadPauserConfigFromEnv();
    case "BLOCK_OPERATOR":
      return loadBlockOperatorConfigFromEnv();
    case "UNBLOCK_OPERATOR":
      return loadUnblockOperatorConfigFromEnv();
    case "FORCED_TRANSFER_MANAGER":
      return loadForcedTransferManagerConfigFromEnv();
    case "YIELD_RECIPIENT_MANAGER":
      return loadYieldRecipientManagerConfigFromEnv();
    case "ISSUER":
      return loadIssuerConfigFromEnv();
    case "VIEW":
      return loadReadOnlyConfigFromEnv();
  }
}
