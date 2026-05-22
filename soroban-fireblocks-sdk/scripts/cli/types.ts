import type { SctokenFireblocksClient } from "../../src/sctoken-client";
import type { InvokeContractResult, SorobanFireblocksConfig } from "../../src/types";

export type Role =
  | "ADMIN"
  | "MINTER"
  | "PAUSER"
  | "BLOCK_OPERATOR"
  | "UNBLOCK_OPERATOR"
  | "FORCED_TRANSFER_MANAGER"
  | "YIELD_RECIPIENT_MANAGER"
  | "ISSUER";

export type CommandRole = Role | "VIEW";

export type ArgType = "string" | "address" | "bigint" | "u32" | "hex32";

export type ArgSpec = {
  /** Camel-cased name visible to the invoke function (e.g., "newAdmin") */
  name: string;
  /** Kebab-cased CLI flag (e.g., "new-admin") */
  flag: string;
  /** Optional env-var fallback (e.g., "NEW_ADMIN") */
  envVar?: string;
  /** Type the executor coerces the raw string into */
  type: ArgType;
  /** Required = true means missing arg fails before invoke */
  required: boolean;
  /** One-line description for --help */
  description: string;
};

/** Context passed into preflight / invoke / postcheck. */
export type ExecutionContext = {
  client: SctokenFireblocksClient;
  config: SorobanFireblocksConfig;
  /** Same map as `args` — separate field for readability in spec bodies */
  resolvedArgs: Record<string, string | bigint | Buffer | number | undefined>;
};

export type CommandSpec = {
  /** Kebab-cased command name (e.g., "transfer-sac-admin"). */
  name: string;
  /** Snake-cased contract method (e.g., "transfer_sac_admin"). Used by the registry guard test. */
  contractMethod: string;
  /** Role whose env vars the command requires. "VIEW" = read-only, no signing. */
  role: CommandRole;
  /** Required and optional arguments. `contract` (the contract ID) is implicit and added by the executor. */
  args: ArgSpec[];
  /** One-line summary for --help. */
  description: string;
  /** If true, require explicit `--yes` or interactive confirmation. */
  destructive?: boolean;
  /** Optional check run before signing. Throw to abort. */
  preflight?: (ctx: ExecutionContext) => Promise<void>;
  /** Main action — returns InvokeContractResult for writes, or a string description for views. */
  invoke: (ctx: ExecutionContext) => Promise<InvokeContractResult | string>;
  /** Optional invariant check run after a successful write. Throw to surface inconsistency. */
  postcheck?: (ctx: ExecutionContext) => Promise<void>;
};

export type CliOptions = {
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
};

export type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};
