import { Address } from "@stellar/stellar-sdk";
import type { CommandSpec, ExecutionContext } from "./types";

/**
 * Every contract method exposed by the CLI lives here. Adding a new method
 * = one new entry. The parity test (`cli-registry.test.ts`) cross-checks
 * this list against `parity.test.ts`'s EXPECTED_CONTRACT_METHODS.
 *
 * Convention: spec.name is kebab-case; spec.contractMethod is snake_case
 * and must match the on-chain method name exactly. Views are namespaced
 * with the `query-` prefix.
 */
export const REGISTRY: CommandSpec[] = [
  // ── PAUSER ────────────────────────────────────────────────────────
  {
    name: "pause",
    contractMethod: "pause",
    role: "PAUSER",
    description: "Pause the contract (blocks mint / burn / force_transfer / claim_yield)",
    destructive: true,
    args: [contractArg()],
    preflight: assertPauserMatches,
    invoke: async (ctx: ExecutionContext) =>
      ctx.client.pause({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
      }),
    postcheck: async (ctx: ExecutionContext) => {
      const paused = await ctx.client.queryPaused({ contractId: ctx.resolvedArgs.contract as string });
      if (!paused) throw new Error("pause() returned SUCCESS but `paused()` is still false — investigate on-chain");
    },
  },
  {
    name: "unpause",
    contractMethod: "unpause",
    role: "PAUSER",
    description: "Unpause the contract",
    destructive: true,
    args: [contractArg()],
    preflight: assertPauserMatches,
    invoke: async (ctx: ExecutionContext) =>
      ctx.client.unpause({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
      }),
    postcheck: async (ctx: ExecutionContext) => {
      const paused = await ctx.client.queryPaused({ contractId: ctx.resolvedArgs.contract as string });
      if (paused) throw new Error("unpause() returned SUCCESS but `paused()` is still true — investigate on-chain");
    },
  },

  // ── ADMIN ─────────────────────────────────────────────────────────
  {
    name: "set-admin",
    contractMethod: "set_admin",
    role: "ADMIN",
    description: "Rotate the admin to a new address",
    destructive: true,
    args: [contractArg(), { name: "newAdmin", flag: "new-admin", envVar: "NEW_ADMIN", type: "address", required: true, description: "New admin address (G... or C...)" }],
    invoke: async (ctx) => ctx.client.setAdmin({ contractId: ctx.resolvedArgs.contract as string, newAdmin: ctx.resolvedArgs.newAdmin as string }),
  },
  {
    name: "set-minter",
    contractMethod: "set_minter",
    role: "ADMIN",
    description: "Set the minter address",
    destructive: true,
    args: [contractArg(), { name: "newMinter", flag: "new-minter", envVar: "NEW_MINTER", type: "address", required: true, description: "New minter address" }],
    invoke: async (ctx) => ctx.client.setMinter({ contractId: ctx.resolvedArgs.contract as string, newMinter: ctx.resolvedArgs.newMinter as string }),
  },
  {
    name: "set-yield-recipient-manager",
    contractMethod: "set_yield_recipient_manager",
    role: "ADMIN",
    description: "Set the yield recipient manager address",
    destructive: true,
    args: [contractArg(), { name: "newYieldRecipientManager", flag: "new-yield-recipient-manager", envVar: "NEW_YIELD_RECIPIENT_MANAGER", type: "address", required: true, description: "New manager address" }],
    invoke: async (ctx) => ctx.client.setYieldRecipientManager({ contractId: ctx.resolvedArgs.contract as string, newYieldRecipientManager: ctx.resolvedArgs.newYieldRecipientManager as string }),
  },
  {
    name: "set-forced-transfer-manager",
    contractMethod: "set_forced_transfer_manager",
    role: "ADMIN",
    description: "Set the forced transfer manager address",
    destructive: true,
    args: [contractArg(), { name: "newForcedTransferManager", flag: "new-forced-transfer-manager", envVar: "NEW_FORCED_TRANSFER_MANAGER", type: "address", required: true, description: "New manager address" }],
    invoke: async (ctx) => ctx.client.setForcedTransferManager({ contractId: ctx.resolvedArgs.contract as string, newForcedTransferManager: ctx.resolvedArgs.newForcedTransferManager as string }),
  },
  {
    name: "set-pauser",
    contractMethod: "set_pauser",
    role: "ADMIN",
    description: "Set the pauser address",
    destructive: true,
    args: [contractArg(), { name: "newPauser", flag: "new-pauser", envVar: "NEW_PAUSER", type: "address", required: true, description: "New pauser address" }],
    invoke: async (ctx) => ctx.client.setPauser({ contractId: ctx.resolvedArgs.contract as string, newPauser: ctx.resolvedArgs.newPauser as string }),
  },
  {
    name: "add-block-operator",
    contractMethod: "add_block_operator",
    role: "ADMIN",
    description: "Grant the block-operator role to an address (idempotent)",
    args: [contractArg(), { name: "addr", flag: "addr", envVar: "BLOCK_OPERATOR_ADDR", type: "address", required: true, description: "Address to grant block-operator role" }],
    invoke: async (ctx) => ctx.client.addBlockOperator({ contractId: ctx.resolvedArgs.contract as string, addr: ctx.resolvedArgs.addr as string }),
  },
  {
    name: "remove-block-operator",
    contractMethod: "remove_block_operator",
    role: "ADMIN",
    description: "Revoke the block-operator role from an address (idempotent)",
    args: [contractArg(), { name: "addr", flag: "addr", envVar: "BLOCK_OPERATOR_ADDR", type: "address", required: true, description: "Address to revoke block-operator role" }],
    invoke: async (ctx) => ctx.client.removeBlockOperator({ contractId: ctx.resolvedArgs.contract as string, addr: ctx.resolvedArgs.addr as string }),
  },
  {
    name: "add-unblock-operator",
    contractMethod: "add_unblock_operator",
    role: "ADMIN",
    description: "Grant the unblock-operator role to an address (idempotent)",
    args: [contractArg(), { name: "addr", flag: "addr", envVar: "UNBLOCK_OPERATOR_ADDR", type: "address", required: true, description: "Address to grant unblock-operator role" }],
    invoke: async (ctx) => ctx.client.addUnblockOperator({ contractId: ctx.resolvedArgs.contract as string, addr: ctx.resolvedArgs.addr as string }),
  },
  {
    name: "remove-unblock-operator",
    contractMethod: "remove_unblock_operator",
    role: "ADMIN",
    description: "Revoke the unblock-operator role from an address (idempotent)",
    args: [contractArg(), { name: "addr", flag: "addr", envVar: "UNBLOCK_OPERATOR_ADDR", type: "address", required: true, description: "Address to revoke unblock-operator role" }],
    invoke: async (ctx) => ctx.client.removeUnblockOperator({ contractId: ctx.resolvedArgs.contract as string, addr: ctx.resolvedArgs.addr as string }),
  },
  {
    name: "transfer-sac-admin",
    contractMethod: "transfer_sac_admin",
    role: "ADMIN",
    description: "Transfer SAC admin away from the wrapper — IRREVERSIBLE: wrapper loses mint / burn / clawback / authorize",
    destructive: true,
    args: [contractArg(), { name: "newSacAdmin", flag: "new-sac-admin", envVar: "NEW_SAC_ADMIN", type: "address", required: true, description: "New SAC admin (G... or C...)" }],
    invoke: async (ctx) => ctx.client.transferSacAdmin({ contractId: ctx.resolvedArgs.contract as string, newSacAdmin: ctx.resolvedArgs.newSacAdmin as string }),
  },
  {
    name: "upgrade",
    contractMethod: "upgrade",
    role: "ADMIN",
    description: "Upgrade the contract to a new WASM hash",
    destructive: true,
    args: [contractArg(), { name: "newWasmHash", flag: "wasm-hash", envVar: "WASM_HASH", type: "hex32", required: true, description: "SHA-256 hash of the new WASM (32 bytes, hex)" }],
    invoke: async (ctx) => ctx.client.upgrade({ contractId: ctx.resolvedArgs.contract as string, newWasmHash: ctx.resolvedArgs.newWasmHash as Buffer }),
  },
  {
    name: "reconcile-burn",
    contractMethod: "reconcile_burn",
    role: "ADMIN",
    description: "Reconcile burn supply (admin-only invariant maintenance)",
    args: [contractArg(), { name: "amount", flag: "amount", envVar: "RECONCILE_AMOUNT", type: "bigint", required: true, description: "Amount to reconcile (i128)" }],
    invoke: async (ctx) => ctx.client.reconcileBurn({ contractId: ctx.resolvedArgs.contract as string, amount: ctx.resolvedArgs.amount as bigint }),
  },

  // ── MINTER ────────────────────────────────────────────────────────
  {
    name: "mint",
    contractMethod: "mint",
    role: "MINTER",
    description: "Mint tokens to an address",
    args: [contractArg(), { name: "to", flag: "to", envVar: "MINT_TO", type: "address", required: true, description: "Destination address" }, { name: "amount", flag: "amount", envVar: "MINT_AMOUNT", type: "bigint", required: true, description: "Amount to mint (i128)" }],
    invoke: async (ctx) =>
      ctx.client.mint({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
        to: ctx.resolvedArgs.to as string,
        amount: ctx.resolvedArgs.amount as bigint,
      }),
  },
  {
    name: "burn",
    contractMethod: "burn",
    role: "MINTER",
    description: "Burn tokens from an address",
    args: [contractArg(), { name: "from", flag: "from", envVar: "BURN_FROM", type: "address", required: true, description: "Source address" }, { name: "amount", flag: "amount", envVar: "BURN_AMOUNT", type: "bigint", required: true, description: "Amount to burn (i128)" }],
    invoke: async (ctx) =>
      ctx.client.burn({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
        from: ctx.resolvedArgs.from as string,
        amount: ctx.resolvedArgs.amount as bigint,
      }),
  },
  {
    name: "set-rate",
    contractMethod: "set_rate",
    role: "MINTER",
    description: "Set the interest rate (basis points, 0–10000)",
    args: [contractArg(), { name: "rateBps", flag: "rate-bps", envVar: "RATE_BPS", type: "u32", required: true, description: "Interest rate in basis points" }],
    invoke: async (ctx) =>
      ctx.client.setRate({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
        rateBps: ctx.resolvedArgs.rateBps as number,
      }),
  },

  // ── BLOCK_OPERATOR ────────────────────────────────────────────────
  {
    name: "block-user",
    contractMethod: "block_user",
    role: "BLOCK_OPERATOR",
    description: "Block a single user (SAC set_authorized=false)",
    args: [contractArg(), { name: "user", flag: "user", envVar: "BLOCK_USER", type: "address", required: true, description: "User to block" }],
    invoke: async (ctx) =>
      ctx.client.blockUser({
        contractId: ctx.resolvedArgs.contract as string,
        user: ctx.resolvedArgs.user as string,
        operator: ctx.config.sourcePublicKey,
      }),
  },
  {
    name: "batch-block-users",
    contractMethod: "batch_block_users",
    role: "BLOCK_OPERATOR",
    description: "Block up to 40 users in one tx (comma-separated G... addresses)",
    args: [contractArg(), { name: "users", flag: "users", envVar: "BLOCK_USERS", type: "string", required: true, description: "Comma-separated user addresses (max 40)" }],
    invoke: async (ctx) =>
      ctx.client.batchBlockUsers({
        contractId: ctx.resolvedArgs.contract as string,
        users: (ctx.resolvedArgs.users as string).split(",").map((s) => s.trim()),
        operator: ctx.config.sourcePublicKey,
      }),
  },

  // ── UNBLOCK_OPERATOR ──────────────────────────────────────────────
  {
    name: "unblock-user",
    contractMethod: "unblock_user",
    role: "UNBLOCK_OPERATOR",
    description: "Unblock a single user (SAC set_authorized=true)",
    args: [contractArg(), { name: "user", flag: "user", envVar: "UNBLOCK_USER", type: "address", required: true, description: "User to unblock" }],
    invoke: async (ctx) =>
      ctx.client.unblockUser({
        contractId: ctx.resolvedArgs.contract as string,
        user: ctx.resolvedArgs.user as string,
        operator: ctx.config.sourcePublicKey,
      }),
  },
  {
    name: "batch-unblock-users",
    contractMethod: "batch_unblock_users",
    role: "UNBLOCK_OPERATOR",
    description: "Unblock up to 40 users in one tx",
    args: [contractArg(), { name: "users", flag: "users", envVar: "UNBLOCK_USERS", type: "string", required: true, description: "Comma-separated user addresses (max 40)" }],
    invoke: async (ctx) =>
      ctx.client.batchUnblockUsers({
        contractId: ctx.resolvedArgs.contract as string,
        users: (ctx.resolvedArgs.users as string).split(",").map((s) => s.trim()),
        operator: ctx.config.sourcePublicKey,
      }),
  },

  // ── FORCED_TRANSFER_MANAGER ───────────────────────────────────────
  {
    name: "force-transfer",
    contractMethod: "force_transfer",
    role: "FORCED_TRANSFER_MANAGER",
    description: "Force-transfer tokens (compliance action)",
    destructive: true,
    args: [contractArg(), { name: "from", flag: "from", envVar: "FROM", type: "address", required: true, description: "Source address" }, { name: "to", flag: "to", envVar: "TO", type: "address", required: true, description: "Destination address" }, { name: "amount", flag: "amount", envVar: "AMOUNT", type: "bigint", required: true, description: "Amount (i128)" }],
    invoke: async (ctx) =>
      ctx.client.forceTransfer({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
        from: ctx.resolvedArgs.from as string,
        to: ctx.resolvedArgs.to as string,
        amount: ctx.resolvedArgs.amount as bigint,
      }),
  },

  // ── YIELD_RECIPIENT_MANAGER ───────────────────────────────────────
  {
    name: "set-yield-recipient",
    contractMethod: "set_yield_recipient",
    role: "YIELD_RECIPIENT_MANAGER",
    description: "Rotate the yield recipient to a new address",
    destructive: true,
    args: [contractArg(), { name: "newYieldRecipient", flag: "new-yield-recipient", envVar: "NEW_YIELD_RECIPIENT", type: "address", required: true, description: "New yield recipient address" }],
    invoke: async (ctx) =>
      ctx.client.setYieldRecipient({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
        newYieldRecipient: ctx.resolvedArgs.newYieldRecipient as string,
      }),
  },
  {
    name: "claim-yield",
    contractMethod: "claim_yield",
    role: "YIELD_RECIPIENT_MANAGER",
    description: "Claim accrued yield (mints SAC tokens to the yield recipient)",
    args: [contractArg()],
    invoke: async (ctx) =>
      ctx.client.claimYield({
        contractId: ctx.resolvedArgs.contract as string,
        caller: ctx.config.sourcePublicKey,
      }),
  },

  // ── VIEW ──────────────────────────────────────────────────────────
  ...viewSpecs(),
];

function contractArg() {
  return {
    name: "contract",
    flag: "contract",
    envVar: "CONTRACT_ID",
    type: "address" as const,
    required: true,
    description: "Wrapper contract ID (C...)",
  };
}

async function assertPauserMatches(ctx: ExecutionContext): Promise<void> {
  const onChain = await ctx.client.queryPauser({ contractId: ctx.resolvedArgs.contract as string });
  if (onChain !== ctx.config.sourcePublicKey) {
    throw new Error(
      `Pauser mismatch: on-chain pauser is ${onChain}, but PAUSER_PUBLIC_KEY is ${ctx.config.sourcePublicKey}. ` +
        `Rotate the contract pauser (admin: set-pauser) or update PAUSER_PUBLIC_KEY / PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID.`,
    );
  }
}

/**
 * Every view method on SctokenFireblocksClient becomes a `query-<name>` CLI
 * command. The address-arg views (`query-blocked`, `query-balance`, etc.) take
 * an extra `--account` / `--id` flag.
 */
function viewSpecs(): CommandSpec[] {
  return [
    // simple no-arg view methods
    viewSpec("query-paused", "paused", "Returns whether the contract is paused (bool)", async (ctx) => {
      const v = await ctx.client.queryPaused({ contractId: ctx.resolvedArgs.contract as string });
      return String(v);
    }),
    viewSpec("query-pauser", "pauser", "Returns the on-chain pauser address", async (ctx) =>
      ctx.client.queryPauser({ contractId: ctx.resolvedArgs.contract as string }),
    ),
    viewSpec("query-admin", "admin", "Returns the on-chain admin address", async (ctx) =>
      ctx.client.queryAdmin({ contractId: ctx.resolvedArgs.contract as string }),
    ),
    viewSpec("query-minter", "minter", "Returns the on-chain minter address", async (ctx) =>
      ctx.client.queryMinter({ contractId: ctx.resolvedArgs.contract as string }),
    ),
    viewSpec("query-sac-token", "sac_token", "Returns the wrapped SAC contract ID", async (ctx) =>
      ctx.client.querySacToken({ contractId: ctx.resolvedArgs.contract as string }),
    ),
    viewSpec("query-yield-recipient", "yield_recipient", "Returns the yield recipient address", async (ctx) =>
      ctx.client.queryYieldRecipient({ contractId: ctx.resolvedArgs.contract as string }),
    ),
    viewSpec("query-yield-recipient-manager", "yield_recipient_manager", "Returns the yield recipient manager address", async (ctx) =>
      ctx.client.queryYieldRecipientManager({ contractId: ctx.resolvedArgs.contract as string }),
    ),
    viewSpec("query-forced-transfer-manager", "forced_transfer_manager", "Returns the forced transfer manager address", async (ctx) =>
      ctx.client.queryForcedTransferManager({ contractId: ctx.resolvedArgs.contract as string }),
    ),
    viewSpec("query-total-supply", "total_supply", "Returns total supply (i128)", async (ctx) => {
      const v = await ctx.client.queryTotalSupply({ contractId: ctx.resolvedArgs.contract as string });
      return v.toString();
    }),
    viewSpec("query-total-principal", "total_principal", "Returns total principal (i128)", async (ctx) => {
      const v = await ctx.client.queryTotalPrincipal({ contractId: ctx.resolvedArgs.contract as string });
      return v.toString();
    }),
    viewSpec("query-accrued-yield", "accrued_yield", "Returns accrued (unclaimed) yield (i128)", async (ctx) => {
      const v = await ctx.client.queryAccruedYield({ contractId: ctx.resolvedArgs.contract as string });
      return v.toString();
    }),
    viewSpec("query-current-index", "current_index", "Returns current yield index (i128)", async (ctx) => {
      const v = await ctx.client.queryCurrentIndex({ contractId: ctx.resolvedArgs.contract as string });
      return v.toString();
    }),
    viewSpec("query-latest-index", "latest_index", "Returns latest yield index (i128)", async (ctx) => {
      const v = await ctx.client.queryLatestIndex({ contractId: ctx.resolvedArgs.contract as string });
      return v.toString();
    }),
    viewSpec("query-interest-rate", "interest_rate", "Returns the current interest rate in bps (u32)", async (ctx) => {
      const v = await ctx.client.queryInterestRate({ contractId: ctx.resolvedArgs.contract as string });
      return String(v);
    }),
    // address-arg view methods
    {
      name: "query-balance",
      contractMethod: "balance",
      role: "VIEW",
      description: "Returns the principal balance of an account (i128)",
      args: [contractArg(), { name: "id", flag: "id", envVar: "BALANCE_ID", type: "address", required: true, description: "Account address" }],
      invoke: async (ctx) => {
        const v = await ctx.client.queryBalance({ contractId: ctx.resolvedArgs.contract as string, id: ctx.resolvedArgs.id as string });
        return v.toString();
      },
    },
    {
      name: "query-blocked",
      contractMethod: "blocked",
      role: "VIEW",
      description: "Returns whether an account is blocked (bool)",
      args: [contractArg(), { name: "account", flag: "account", envVar: "BLOCKED_ACCOUNT", type: "address", required: true, description: "Account to check" }],
      invoke: async (ctx) => {
        const v = await ctx.client.queryBlocked({ contractId: ctx.resolvedArgs.contract as string, account: ctx.resolvedArgs.account as string });
        return String(v);
      },
    },
    {
      name: "query-is-block-operator",
      contractMethod: "is_block_operator",
      role: "VIEW",
      description: "Returns whether an address holds the block-operator role (bool)",
      args: [contractArg(), { name: "account", flag: "account", envVar: "BLOCK_OPERATOR_QUERY_ADDR", type: "address", required: true, description: "Address to check" }],
      invoke: async (ctx) => {
        const v = await ctx.client.queryIsBlockOperator({ contractId: ctx.resolvedArgs.contract as string, account: ctx.resolvedArgs.account as string });
        return String(v);
      },
    },
    {
      name: "query-is-unblock-operator",
      contractMethod: "is_unblock_operator",
      role: "VIEW",
      description: "Returns whether an address holds the unblock-operator role (bool)",
      args: [contractArg(), { name: "account", flag: "account", envVar: "UNBLOCK_OPERATOR_QUERY_ADDR", type: "address", required: true, description: "Address to check" }],
      invoke: async (ctx) => {
        const v = await ctx.client.queryIsUnblockOperator({ contractId: ctx.resolvedArgs.contract as string, account: ctx.resolvedArgs.account as string });
        return String(v);
      },
    },
  ];
}

function viewSpec(
  name: string,
  contractMethod: string,
  description: string,
  invoke: (ctx: ExecutionContext) => Promise<string>,
): CommandSpec {
  return {
    name,
    contractMethod,
    role: "VIEW",
    description,
    args: [contractArg()],
    invoke,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _silenceUnusedAddressImport(): void {
  void Address;
}
