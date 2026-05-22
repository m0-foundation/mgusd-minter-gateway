import type { CommandSpec } from "./types";

export function printHelp(specs: CommandSpec[]): void {
  console.log("Usage: npm run cli -- <command> [flags]");
  console.log("");
  console.log("Global flags:");
  console.log("  --dry-run        Preview the call without signing or submitting");
  console.log("  --yes            Skip the interactive confirmation for destructive ops");
  console.log("  --json           Emit machine-readable JSON output");
  console.log("  --help           Show this message (or `<command> --help` for command-specific help)");
  console.log("");

  const byRole = new Map<string, CommandSpec[]>();
  for (const spec of specs) {
    const key = spec.role;
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key)!.push(spec);
  }

  const roleOrder = [
    "VIEW",
    "ADMIN",
    "MINTER",
    "PAUSER",
    "BLOCK_OPERATOR",
    "UNBLOCK_OPERATOR",
    "FORCED_TRANSFER_MANAGER",
    "YIELD_RECIPIENT_MANAGER",
    "ISSUER",
  ];

  for (const role of roleOrder) {
    const group = byRole.get(role);
    if (!group || group.length === 0) continue;
    console.log(`${role}:`);
    for (const spec of group.sort((a, b) => a.name.localeCompare(b.name))) {
      const destructive = spec.destructive ? " (destructive)" : "";
      console.log(`  ${spec.name.padEnd(34)} ${spec.description}${destructive}`);
    }
    console.log("");
  }

  console.log("Special commands:");
  console.log(`  ${"roles".padEnd(34)} Show which roles are configured in your environment`);
  console.log(`  ${"verify-envelope --xdr <b64>".padEnd(34)} Decode a tx envelope offline (for approver-side verification)`);
  console.log("");
}

export function printCommandHelp(spec: CommandSpec): void {
  console.log(`Usage: npm run cli -- ${spec.name} [flags]`);
  console.log("");
  console.log(spec.description);
  console.log("");
  console.log(`Role required:    ${spec.role}`);
  console.log(`Contract method:  ${spec.contractMethod}`);
  if (spec.destructive) console.log(`Destructive:      yes (requires --yes or interactive confirmation)`);
  console.log("");

  if (spec.args.length > 0) {
    console.log("Flags:");
    for (const arg of spec.args) {
      const required = arg.required ? " (required)" : " (optional)";
      const envHint = arg.envVar ? ` — env: ${arg.envVar}` : "";
      console.log(`  --${arg.flag.padEnd(30)} ${arg.description}${required}${envHint}`);
    }
    console.log("");
  }
}
