import { REGISTRY } from "../../scripts/cli/registry";

/**
 * Same canonical list as parity.test.ts. Kept duplicated by design — these
 * two tests guard different layers (parity.test scans the SDK source for
 * `method: "..."` literals; this one scans the CLI registry). If the contract
 * surface grows, both need updating, which is the intended forcing function.
 */
const EXPECTED_CONTRACT_METHODS = [
  "set_admin",
  "set_minter",
  "set_yield_recipient_manager",
  "set_forced_transfer_manager",
  "set_pauser",
  "add_block_operator",
  "remove_block_operator",
  "add_unblock_operator",
  "remove_unblock_operator",
  "block_user",
  "unblock_user",
  "batch_block_users",
  "batch_unblock_users",
  "transfer_sac_admin",
  "upgrade",
  "mint",
  "burn",
  "reconcile_burn",
  "set_rate",
  "force_transfer",
  "set_yield_recipient",
  "claim_yield",
  "pause",
  "unpause",
  "paused",
  "blocked",
  "balance",
  "sac_token",
  "interest_rate",
  "current_index",
  "latest_index",
  "accrued_yield",
  "total_principal",
  "total_supply",
  "admin",
  "minter",
  "yield_recipient_manager",
  "yield_recipient",
  "forced_transfer_manager",
  "is_block_operator",
  "is_unblock_operator",
  "pauser",
] as const;

describe("CLI registry parity", () => {
  it("every expected contract method has at least one CommandSpec entry", () => {
    const targetedMethods = new Set(REGISTRY.map((s) => s.contractMethod));
    const missing = EXPECTED_CONTRACT_METHODS.filter((m) => !targetedMethods.has(m));
    expect(missing).toEqual([]);
  });

  it("every CommandSpec targets a known contract method (no orphans)", () => {
    const expected = new Set<string>(EXPECTED_CONTRACT_METHODS);
    const orphans = REGISTRY.map((s) => ({ name: s.name, target: s.contractMethod }))
      .filter((s) => !expected.has(s.target));
    expect(orphans).toEqual([]);
  });

  it("CommandSpec names are unique kebab-case", () => {
    const names = REGISTRY.map((s) => s.name);
    const uniq = new Set(names);
    expect(uniq.size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("every state-changing role has at least one entry", () => {
    const roles = new Set(REGISTRY.map((s) => s.role));
    for (const role of [
      "ADMIN",
      "MINTER",
      "PAUSER",
      "BLOCK_OPERATOR",
      "UNBLOCK_OPERATOR",
      "FORCED_TRANSFER_MANAGER",
      "YIELD_RECIPIENT_MANAGER",
      "VIEW",
    ] as const) {
      expect(roles.has(role)).toBe(true);
    }
  });
});
