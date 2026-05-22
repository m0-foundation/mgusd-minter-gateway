/**
 * Unified CLI entrypoint for the soroban-fireblocks-sdk.
 *
 * Run via:   npm run cli -- <command> [flags]
 * Help:      npm run cli -- --help
 * Roles:     npm run cli -- roles
 *
 * Behavior is declared in scripts/cli/registry.ts. The executor only loads
 * env vars for the role required by the invoked command, so missing vars
 * for unrelated roles never block.
 */

import * as dotenv from "dotenv";
import { CliArgError, parseArgv } from "./cli/args";
import { executeCommand } from "./cli/executor";
import { printCommandHelp, printHelp } from "./cli/help";
import { runRolesCommand } from "./cli/roles";
import { runVerifyEnvelopeCommand } from "./cli/verify-envelope";
import { REGISTRY } from "./cli/registry";
import type { CliOptions } from "./cli/types";

dotenv.config();

async function main(): Promise<void> {
  const { positionals, flags } = parseArgv(process.argv.slice(2));

  const options: CliOptions = {
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    json: flags.json === true,
    help: flags.help === true,
  };

  if (positionals.length === 0 || options.help && positionals.length === 0) {
    printHelp(REGISTRY);
    return;
  }

  const commandName = positionals[0];

  // Special command: roles inventory (no spec entry; doesn't need any role config)
  if (commandName === "roles") {
    runRolesCommand();
    return;
  }

  // Special command: offline envelope decoder (no role config, no network)
  if (commandName === "verify-envelope") {
    runVerifyEnvelopeCommand(flags);
    return;
  }

  const spec = REGISTRY.find((s) => s.name === commandName);
  if (!spec) {
    console.error(`Unknown command: ${commandName}`);
    console.error("Run \`npm run cli -- --help\` for the command list.");
    process.exit(1);
  }

  if (options.help) {
    printCommandHelp(spec);
    return;
  }

  await executeCommand(spec, flags, options);
}

main().catch((err) => {
  if (err instanceof CliArgError) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error("Error:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
