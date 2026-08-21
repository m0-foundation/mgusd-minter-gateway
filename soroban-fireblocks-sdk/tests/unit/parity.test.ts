import { readFileSync } from "fs";
import { join } from "path";

// Hand-curated list of contract methods exported by YieldToken + Pausable
// trait on the sdk-integration branch. Source: contracts/mintergateway/src/contract.rs.
// Excludes __constructor (covered by deployFull's orchestration).
//
// When the contract surface changes, update this list and the matching SDK
// wrapper in the same PR — that's the entire point of this test.
const EXPECTED_CONTRACT_METHODS = [
  // Admin role setters
  "set_admin",
  "set_minter",
  "set_yield_recipient_manager",
  "set_forced_transfer_manager",
  "set_pauser",
  // Block / unblock operator role management
  "add_block_operator",
  "remove_block_operator",
  "add_unblock_operator",
  "remove_unblock_operator",
  // Onboarder role management
  "add_onboarder",
  "remove_onboarder",
  // Block / unblock / onboard user actions
  "block_user",
  "unblock_user",
  "onboard_user",
  "batch_onboard_users",
  "batch_block_users",
  "batch_unblock_users",
  // SAC + upgrade
  "transfer_sac_admin",
  "upgrade",
  // Mint / burn / rate
  "mint",
  "burn",
  "reconcile_burn",
  "set_rate",
  "force_transfer",
  // Yield
  "set_yield_recipient",
  "claim_yield",
  // Pausable trait
  "pause",
  "unpause",
  "paused",
  // Views
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
  "is_onboarder",
  "is_on_block_list",
  "is_onboarded",
  "pauser",
] as const;

const SCTOKEN_CLIENT_PATH = join(__dirname, "..", "..", "src", "sctoken-client.ts");

function loadSource(): string {
  return readFileSync(SCTOKEN_CLIENT_PATH, "utf8");
}

// Captures every `method: "<name>"` literal in sctoken-client.ts. The wrapper
// template (and the deployFull pipeline) always uses this exact shape.
function extractMethodLiterals(source: string): string[] {
  const re = /method:\s*"([a-z_][a-z0-9_]*)"/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    found.push(m[1]);
  }
  return found;
}

describe("contract ↔ SDK parity", () => {
  it("every expected contract method is wrapped by an SDK method", () => {
    const source = loadSource();
    const found = new Set(extractMethodLiterals(source));

    const missing = EXPECTED_CONTRACT_METHODS.filter((name) => !found.has(name));

    expect(missing).toEqual([]);
  });

  it("every `method: \"...\"` literal in sctoken-client.ts targets a known contract method (no orphans)", () => {
    const source = loadSource();
    const expected = new Set<string>(EXPECTED_CONTRACT_METHODS);

    const orphans = extractMethodLiterals(source).filter((name) => !expected.has(name));

    // Dedupe so the diagnostic isn't noisy if the same orphan appears more than once.
    expect(Array.from(new Set(orphans))).toEqual([]);
  });
});
