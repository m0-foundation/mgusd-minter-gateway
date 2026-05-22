import { SctokenFireblocksClient } from "../../src/sctoken-client";
import type { InvokeContractResult } from "../../src/types";
import { ConfigError } from "../../src/errors";
import { CliArgError, resolveArgs } from "./args";
import { confirm } from "./prompt";
import { loadConfigForRole } from "./role-config";
import type { CliOptions, CommandSpec, ExecutionContext } from "./types";

/**
 * Runs one CommandSpec end-to-end. Caller is responsible for handling the
 * returned promise's rejection — the executor only throws; it doesn't call
 * process.exit. This keeps it testable.
 *
 * Execution order:
 *   1. resolve args (flags → env → typed)
 *   2. load config for spec.role (only this role's env vars are inspected)
 *   3. instantiate client
 *   4. spec.preflight (if any) — runs even on dry-run; catches misconfiguration
 *      before signing
 *   5. if --dry-run: print preview and return
 *   6. if destructive && !--yes: interactive y/N (aborts if not confirmed)
 *   7. spec.invoke
 *   8. spec.postcheck (if any)
 *   9. log result (text or JSON depending on options)
 */
export async function executeCommand(
  spec: CommandSpec,
  flags: Record<string, string | boolean>,
  options: CliOptions,
): Promise<void> {
  // 1. Resolve args
  const resolvedArgs = resolveArgs(spec.args, flags);

  // 2. Load config — reformat ConfigError to name only this command's role vars
  let config;
  try {
    config = loadConfigForRole(spec.role);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new CliArgError(
        `\`npm run cli -- ${spec.name}\` requires role ${spec.role} env vars: ${err.message}\n` +
          `See .env.example for the full role env layout.`,
      );
    }
    throw err;
  }

  // 3. Client
  const client = new SctokenFireblocksClient(config);

  const ctx: ExecutionContext = { client, config, resolvedArgs };

  // 4. Preflight (runs even on dry-run — catches misconfig before signing)
  if (spec.preflight) {
    await spec.preflight(ctx);
  }

  // 5. Dry-run preview — no signing, no submission, no confirmation
  if (options.dryRun) {
    printDryRunPreview(spec, resolvedArgs, config);
    return;
  }

  // 6. Confirm if destructive
  if (spec.destructive && !options.yes) {
    const proceed = await confirm(
      `About to execute \`${spec.name}\` (role: ${spec.role}, source: ${config.sourcePublicKey}). Proceed?`,
    );
    if (!proceed) {
      console.log("Aborted.");
      return;
    }
  }

  // 7. Invoke
  const result = await spec.invoke(ctx);

  // 8. Postcheck
  if (spec.postcheck) {
    await spec.postcheck(ctx);
  }

  // 9. Log
  if (options.json) {
    console.log(JSON.stringify(formatJsonResult(spec, result), null, 2));
  } else {
    printTextResult(spec, result);
  }
}

function printDryRunPreview(
  spec: CommandSpec,
  resolvedArgs: Record<string, unknown>,
  config: { sourcePublicKey: string; fireblocksVaultAccountId: string },
): void {
  console.log("=== Dry-run preview ===");
  console.log(`  Command:        ${spec.name}`);
  console.log(`  Contract method: ${spec.contractMethod}`);
  console.log(`  Role:           ${spec.role}`);
  if (spec.role !== "VIEW") {
    console.log(`  Source pubkey:  ${config.sourcePublicKey}`);
    console.log(`  Source vault:   ${config.fireblocksVaultAccountId}`);
  }
  console.log(`  Args:`);
  for (const [k, v] of Object.entries(resolvedArgs)) {
    if (v === undefined) continue;
    let display: string;
    if (Buffer.isBuffer(v)) display = `0x${v.toString("hex")}`;
    else if (typeof v === "bigint") display = v.toString();
    else display = String(v);
    console.log(`    ${k}: ${display}`);
  }
  console.log(`  (No transaction was built or signed.)`);
}

function printTextResult(spec: CommandSpec, result: InvokeContractResult | string): void {
  if (typeof result === "string") {
    console.log(`${spec.contractMethod} => ${result}`);
    return;
  }
  console.log(`Transaction ${result.status}:`);
  console.log(`  Hash:   ${result.txHash}`);
  console.log(`  Ledger: ${result.ledger}`);
}

function formatJsonResult(
  spec: CommandSpec,
  result: InvokeContractResult | string,
): Record<string, unknown> {
  if (typeof result === "string") {
    return { command: spec.name, contractMethod: spec.contractMethod, result };
  }
  return {
    command: spec.name,
    contractMethod: spec.contractMethod,
    status: result.status,
    txHash: result.txHash,
    ledger: result.ledger,
  };
}
