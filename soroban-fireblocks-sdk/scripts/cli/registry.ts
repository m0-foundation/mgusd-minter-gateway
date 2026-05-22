import type { InvokeContractResult } from "../../src/types";
import type { ArgSpec, ArgType, CommandSpec, ExecutionContext } from "./types";

/**
 * Every contract method exposed by the CLI lives here. Adding a new method
 * = one new `cmd(...)` / `view(...)` line. The parity test
 * (`cli-registry.test.ts`) cross-checks this list against
 * `parity.test.ts`'s EXPECTED_CONTRACT_METHODS.
 *
 * Naming convention: `method` is the snake_case on-chain method name.
 * The kebab CLI name is derived (`set_admin` → `set-admin`), and the
 * default `invoke` calls the camelCase client method
 * (`set_admin` → `client.setAdmin(...)`).
 */

// ─── arg helpers ────────────────────────────────────────────────────
const CONTRACT_ARG: ArgSpec = {
  name: "contract",
  flag: "contract",
  envVar: "CONTRACT_ID",
  type: "address",
  required: true,
  description: "Wrapper contract ID (C...)",
};

const arg =
  (type: ArgType) =>
  (name: string, envVar: string, description: string): ArgSpec => ({
    name,
    flag: camelToKebab(name),
    envVar,
    type,
    required: true,
    description,
  });

const addr = arg("address");
const big = arg("bigint");
const u32 = arg("u32");
const hex32 = arg("hex32");
const str = arg("string");

// ─── command builder ─────────────────────────────────────────────────
type Inject = "caller" | "operator" | "none";

interface CommandDef {
  /** snake_case on-chain method name. Drives CLI name + client method name. */
  method: string;
  role: CommandSpec["role"];
  desc: string;
  destructive?: boolean;
  /** Args beyond the implicit `--contract`. */
  args?: ArgSpec[];
  /** Inject `sourcePublicKey` as `caller` or `operator` in the client call. */
  inject?: Inject;
  preflight?: CommandSpec["preflight"];
  postcheck?: CommandSpec["postcheck"];
  /** Escape hatch for methods whose args need transforming before the call. */
  invoke?: CommandSpec["invoke"];
}

function cmd(def: CommandDef): CommandSpec {
  return {
    name: snakeToKebab(def.method),
    contractMethod: def.method,
    role: def.role,
    description: def.desc,
    destructive: def.destructive,
    args: [CONTRACT_ARG, ...(def.args ?? [])],
    preflight: def.preflight,
    postcheck: def.postcheck,
    invoke: def.invoke ?? defaultInvoke(def.method, def.inject ?? "none"),
  };
}

/**
 * Calls `ctx.client[camelCase(method)]({ contractId, ...resolvedArgs, ...injected })`.
 * The dynamic dispatch is intentional — the parity test guarantees every
 * `method` in the registry exists as both a contract method and a client
 * method, so a typo would fail at test time, not at runtime.
 *
 * The call must be `client[method](args)` — not `const fn = client[method]; fn(args)`
 * — because extracting the method into a local strips the `this` binding, and
 * the SDK methods rely on `this.simulateView` / `this.invokeContract`.
 */
function defaultInvoke(method: string, inject: Inject): CommandSpec["invoke"] {
  const clientMethod = snakeToCamel(method);
  return async (ctx) => {
    const { contract: contractId, ...rest } = ctx.resolvedArgs;
    const injected =
      inject === "caller"
        ? { caller: ctx.config.sourcePublicKey }
        : inject === "operator"
        ? { operator: ctx.config.sourcePublicKey }
        : {};
    const dynClient = ctx.client as unknown as Record<
      string,
      (params: Record<string, unknown>) => Promise<InvokeContractResult>
    >;
    return dynClient[clientMethod]({ contractId, ...injected, ...rest });
  };
}

// ─── view builders ───────────────────────────────────────────────────
type ViewFmt = (v: unknown) => string;
const asString: ViewFmt = (v) => String(v);
const asBigInt: ViewFmt = (v) => (v as bigint).toString();

function view(name: string, method: string, desc: string, fmt: ViewFmt = asString): CommandSpec {
  const clientMethod = "query" + capitalize(snakeToCamel(method));
  return {
    name,
    contractMethod: method,
    role: "VIEW",
    description: desc,
    args: [CONTRACT_ARG],
    invoke: async (ctx) => {
      const dynClient = ctx.client as unknown as Record<
        string,
        (params: { contractId: string }) => Promise<unknown>
      >;
      const v = await dynClient[clientMethod]({ contractId: ctx.resolvedArgs.contract as string });
      return fmt(v);
    },
  };
}

function viewWithAddr(
  name: string,
  method: string,
  addrField: "id" | "account",
  envVar: string,
  desc: string,
  fmt: ViewFmt = asString,
): CommandSpec {
  const clientMethod = "query" + capitalize(snakeToCamel(method));
  return {
    name,
    contractMethod: method,
    role: "VIEW",
    description: desc,
    args: [
      CONTRACT_ARG,
      { name: addrField, flag: addrField, envVar, type: "address", required: true, description: "Account address" },
    ],
    invoke: async (ctx) => {
      const dynClient = ctx.client as unknown as Record<
        string,
        (params: Record<string, string>) => Promise<unknown>
      >;
      const v = await dynClient[clientMethod]({
        contractId: ctx.resolvedArgs.contract as string,
        [addrField]: ctx.resolvedArgs[addrField] as string,
      });
      return fmt(v);
    },
  };
}

// ─── name conversions ────────────────────────────────────────────────
const snakeToKebab = (s: string): string => s.replace(/_/g, "-");
const snakeToCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const camelToKebab = (s: string): string => s.replace(/([A-Z])/g, "-$1").toLowerCase();
const capitalize = (s: string): string => s[0].toUpperCase() + s.slice(1);

// ─── role-specific preflights ────────────────────────────────────────
async function assertPauserMatches(ctx: ExecutionContext): Promise<void> {
  const onChain = await ctx.client.queryPauser({ contractId: ctx.resolvedArgs.contract as string });
  if (onChain !== ctx.config.sourcePublicKey) {
    throw new Error(
      `Pauser mismatch: on-chain pauser is ${onChain}, but PAUSER_PUBLIC_KEY is ${ctx.config.sourcePublicKey}. ` +
        `Rotate the contract pauser (admin: set-pauser) or update PAUSER_PUBLIC_KEY / PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID.`,
    );
  }
}

// ─── registry ────────────────────────────────────────────────────────
export const REGISTRY: CommandSpec[] = [
  // PAUSER
  cmd({
    method: "pause", role: "PAUSER", inject: "caller", destructive: true,
    desc: "Pause the contract (blocks mint / burn / force_transfer / claim_yield)",
    preflight: assertPauserMatches,
    postcheck: async (ctx) => {
      const paused = await ctx.client.queryPaused({ contractId: ctx.resolvedArgs.contract as string });
      if (!paused) throw new Error("pause() returned SUCCESS but `paused()` is still false — investigate on-chain");
    },
  }),
  cmd({
    method: "unpause", role: "PAUSER", inject: "caller", destructive: true,
    desc: "Unpause the contract",
    preflight: assertPauserMatches,
    postcheck: async (ctx) => {
      const paused = await ctx.client.queryPaused({ contractId: ctx.resolvedArgs.contract as string });
      if (paused) throw new Error("unpause() returned SUCCESS but `paused()` is still true — investigate on-chain");
    },
  }),

  // ADMIN
  cmd({ method: "set_admin", role: "ADMIN", destructive: true,
    desc: "Rotate the admin to a new address",
    args: [addr("newAdmin", "NEW_ADMIN", "New admin address (G... or C...)")] }),
  cmd({ method: "set_minter", role: "ADMIN", destructive: true,
    desc: "Set the minter address",
    args: [addr("newMinter", "NEW_MINTER", "New minter address")] }),
  cmd({ method: "set_yield_recipient_manager", role: "ADMIN", destructive: true,
    desc: "Set the yield recipient manager address",
    args: [addr("newYieldRecipientManager", "NEW_YIELD_RECIPIENT_MANAGER", "New manager address")] }),
  cmd({ method: "set_forced_transfer_manager", role: "ADMIN", destructive: true,
    desc: "Set the forced transfer manager address",
    args: [addr("newForcedTransferManager", "NEW_FORCED_TRANSFER_MANAGER", "New manager address")] }),
  cmd({ method: "set_pauser", role: "ADMIN", destructive: true,
    desc: "Set the pauser address",
    args: [addr("newPauser", "NEW_PAUSER", "New pauser address")] }),
  cmd({ method: "add_block_operator", role: "ADMIN",
    desc: "Grant the block-operator role to an address (idempotent)",
    args: [addr("addr", "BLOCK_OPERATOR_ADDR", "Address to grant block-operator role")] }),
  cmd({ method: "remove_block_operator", role: "ADMIN",
    desc: "Revoke the block-operator role from an address (idempotent)",
    args: [addr("addr", "BLOCK_OPERATOR_ADDR", "Address to revoke block-operator role")] }),
  cmd({ method: "add_unblock_operator", role: "ADMIN",
    desc: "Grant the unblock-operator role to an address (idempotent)",
    args: [addr("addr", "UNBLOCK_OPERATOR_ADDR", "Address to grant unblock-operator role")] }),
  cmd({ method: "remove_unblock_operator", role: "ADMIN",
    desc: "Revoke the unblock-operator role from an address (idempotent)",
    args: [addr("addr", "UNBLOCK_OPERATOR_ADDR", "Address to revoke unblock-operator role")] }),
  cmd({ method: "transfer_sac_admin", role: "ADMIN", destructive: true,
    desc: "Transfer SAC admin away from the wrapper — IRREVERSIBLE: wrapper loses mint / burn / clawback / authorize",
    args: [addr("newSacAdmin", "NEW_SAC_ADMIN", "New SAC admin (G... or C...)")] }),
  cmd({ method: "upgrade", role: "ADMIN", destructive: true,
    desc: "Upgrade the contract to a new WASM hash",
    args: [hex32("newWasmHash", "WASM_HASH", "SHA-256 hash of the new WASM (32 bytes, hex)")] }),
  cmd({ method: "reconcile_burn", role: "ADMIN",
    desc: "Reconcile burn supply (admin-only invariant maintenance)",
    args: [big("amount", "RECONCILE_AMOUNT", "Amount to reconcile (i128)")] }),

  // MINTER
  cmd({ method: "mint", role: "MINTER", inject: "caller",
    desc: "Mint tokens to an address",
    args: [addr("to", "MINT_TO", "Destination address"), big("amount", "MINT_AMOUNT", "Amount to mint (i128)")] }),
  cmd({ method: "burn", role: "MINTER", inject: "caller",
    desc: "Burn tokens from an address",
    args: [addr("from", "BURN_FROM", "Source address"), big("amount", "BURN_AMOUNT", "Amount to burn (i128)")] }),
  cmd({ method: "set_rate", role: "MINTER", inject: "caller",
    desc: "Set the interest rate (basis points, 0–10000)",
    args: [u32("rateBps", "RATE_BPS", "Interest rate in basis points")] }),

  // BLOCK_OPERATOR
  cmd({ method: "block_user", role: "BLOCK_OPERATOR", inject: "operator",
    desc: "Block a single user (SAC set_authorized=false)",
    args: [addr("user", "BLOCK_USER", "User to block")] }),
  cmd({ method: "batch_block_users", role: "BLOCK_OPERATOR",
    desc: "Block up to 40 users in one tx (comma-separated G... addresses)",
    args: [str("users", "BLOCK_USERS", "Comma-separated user addresses (max 40)")],
    invoke: (ctx) =>
      ctx.client.batchBlockUsers({
        contractId: ctx.resolvedArgs.contract as string,
        users: (ctx.resolvedArgs.users as string).split(",").map((s) => s.trim()),
        operator: ctx.config.sourcePublicKey,
      }),
  }),

  // UNBLOCK_OPERATOR
  cmd({ method: "unblock_user", role: "UNBLOCK_OPERATOR", inject: "operator",
    desc: "Unblock a single user (SAC set_authorized=true)",
    args: [addr("user", "UNBLOCK_USER", "User to unblock")] }),
  cmd({ method: "batch_unblock_users", role: "UNBLOCK_OPERATOR",
    desc: "Unblock up to 40 users in one tx",
    args: [str("users", "UNBLOCK_USERS", "Comma-separated user addresses (max 40)")],
    invoke: (ctx) =>
      ctx.client.batchUnblockUsers({
        contractId: ctx.resolvedArgs.contract as string,
        users: (ctx.resolvedArgs.users as string).split(",").map((s) => s.trim()),
        operator: ctx.config.sourcePublicKey,
      }),
  }),

  // FORCED_TRANSFER_MANAGER
  cmd({ method: "force_transfer", role: "FORCED_TRANSFER_MANAGER", inject: "caller", destructive: true,
    desc: "Force-transfer tokens (compliance action)",
    args: [
      addr("from", "FROM", "Source address"),
      addr("to", "TO", "Destination address"),
      big("amount", "AMOUNT", "Amount (i128)"),
    ] }),

  // YIELD_RECIPIENT_MANAGER
  cmd({ method: "set_yield_recipient", role: "YIELD_RECIPIENT_MANAGER", inject: "caller", destructive: true,
    desc: "Rotate the yield recipient to a new address",
    args: [addr("newYieldRecipient", "NEW_YIELD_RECIPIENT", "New yield recipient address")] }),
  cmd({ method: "claim_yield", role: "YIELD_RECIPIENT_MANAGER", inject: "caller",
    desc: "Claim accrued yield (mints SAC tokens to the yield recipient)" }),

  // VIEWS — no-arg
  view("query-paused", "paused", "Returns whether the contract is paused (bool)"),
  view("query-pauser", "pauser", "Returns the on-chain pauser address"),
  view("query-admin", "admin", "Returns the on-chain admin address"),
  view("query-minter", "minter", "Returns the on-chain minter address"),
  view("query-sac-token", "sac_token", "Returns the wrapped SAC contract ID"),
  view("query-yield-recipient", "yield_recipient", "Returns the yield recipient address"),
  view("query-yield-recipient-manager", "yield_recipient_manager", "Returns the yield recipient manager address"),
  view("query-forced-transfer-manager", "forced_transfer_manager", "Returns the forced transfer manager address"),
  view("query-total-supply", "total_supply", "Returns total supply (i128)", asBigInt),
  view("query-total-principal", "total_principal", "Returns total principal (i128)", asBigInt),
  view("query-accrued-yield", "accrued_yield", "Returns accrued (unclaimed) yield (i128)", asBigInt),
  view("query-current-index", "current_index", "Returns current yield index (i128)", asBigInt),
  view("query-latest-index", "latest_index", "Returns latest yield index (i128)", asBigInt),
  view("query-interest-rate", "interest_rate", "Returns the current interest rate in bps (u32)"),

  // VIEWS — address-arg
  viewWithAddr("query-balance", "balance", "id", "BALANCE_ID", "Returns the principal balance of an account (i128)", asBigInt),
  viewWithAddr("query-blocked", "blocked", "account", "BLOCKED_ACCOUNT", "Returns whether an account is blocked (bool)"),
  viewWithAddr("query-is-block-operator", "is_block_operator", "account", "BLOCK_OPERATOR_QUERY_ADDR",
    "Returns whether an address holds the block-operator role (bool)"),
  viewWithAddr("query-is-unblock-operator", "is_unblock_operator", "account", "UNBLOCK_OPERATOR_QUERY_ADDR",
    "Returns whether an address holds the unblock-operator role (bool)"),
];
