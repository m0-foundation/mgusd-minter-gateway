import type { ArgSpec, ArgType, ParsedArgs } from "./types";

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

/**
 * Parses argv into positionals + flags.
 *
 * Supported shapes:
 *   --flag value          → flags.flag = "value"
 *   --flag=value          → flags.flag = "value"
 *   --flag (no value)     → flags.flag = true   (boolean flag)
 *   --flag --next         → flags.flag = true, flags.next = (parsed next)
 *   --flag=               → flags.flag = ""     (empty string, not boolean)
 *   positional            → positionals.push("positional")
 */
export function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positionals.push(arg);
    }
    i++;
  }
  return { positionals, flags };
}

/**
 * Coerces a raw string value into the declared ArgType. Throws CliArgError
 * with a descriptive message on failure. `argName` is included in errors for
 * operator legibility (e.g., "--amount: expected bigint").
 */
export function coerceArg(value: string, type: ArgType, argName: string): string | bigint | Buffer | number {
  switch (type) {
    case "string":
      return value;
    case "address":
      if (!value.startsWith("G") && !value.startsWith("C")) {
        throw new CliArgError(`--${argName}: expected Stellar address starting with G or C, got ${value}`);
      }
      return value;
    case "bigint":
      try {
        return BigInt(value);
      } catch {
        throw new CliArgError(`--${argName}: expected integer, got "${value}"`);
      }
    case "u32": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
        throw new CliArgError(`--${argName}: expected u32 (0 to 4294967295), got "${value}"`);
      }
      return n;
    }
    case "hex32": {
      const stripped = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
      if (stripped.length !== 64) {
        throw new CliArgError(`--${argName}: expected 32-byte (64-char) hex, got ${stripped.length} chars`);
      }
      if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
        throw new CliArgError(`--${argName}: hex contains non-hex characters`);
      }
      return Buffer.from(stripped, "hex");
    }
  }
}

/**
 * Resolves an ArgSpec[] against parsed CLI flags + process.env, producing a
 * typed args map. For each spec:
 *   1. CLI flag (--name) → coerce
 *   2. else env var → coerce
 *   3. else if required → throw CliArgError naming both --flag and envVar
 *   4. else leave undefined
 */
export function resolveArgs(
  specs: ArgSpec[],
  flags: Record<string, string | boolean>,
): Record<string, string | bigint | Buffer | number | undefined> {
  const out: Record<string, string | bigint | Buffer | number | undefined> = {};
  for (const spec of specs) {
    const flagVal = flags[spec.flag];
    let rawValue: string | undefined;
    if (typeof flagVal === "string") {
      rawValue = flagVal;
    } else if (spec.envVar && process.env[spec.envVar]) {
      rawValue = process.env[spec.envVar];
    }
    if (rawValue === undefined || rawValue === "") {
      if (spec.required) {
        const envHint = spec.envVar ? ` (or env var ${spec.envVar})` : "";
        throw new CliArgError(`Missing required argument --${spec.flag}${envHint}`);
      }
      continue;
    }
    out[spec.name] = coerceArg(rawValue, spec.type, spec.flag);
  }
  return out;
}
