import { parseArgv, coerceArg, resolveArgs, CliArgError } from "../../scripts/cli/args";
import type { ArgSpec } from "../../scripts/cli/types";

describe("parseArgv", () => {
  it("returns empty when argv is empty", () => {
    const result = parseArgv([]);
    expect(result.positionals).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it("collects positionals in order", () => {
    const result = parseArgv(["pause"]);
    expect(result.positionals).toEqual(["pause"]);
    expect(result.flags).toEqual({});
  });

  it("parses --flag value", () => {
    const result = parseArgv(["pause", "--contract", "C123"]);
    expect(result.positionals).toEqual(["pause"]);
    expect(result.flags).toEqual({ contract: "C123" });
  });

  it("parses --flag=value", () => {
    const result = parseArgv(["pause", "--contract=C123"]);
    expect(result.flags).toEqual({ contract: "C123" });
  });

  it("parses boolean flag with no value", () => {
    const result = parseArgv(["pause", "--dry-run"]);
    expect(result.flags).toEqual({ "dry-run": true });
  });

  it("parses boolean flag when followed by another --flag", () => {
    const result = parseArgv(["pause", "--dry-run", "--yes"]);
    expect(result.flags).toEqual({ "dry-run": true, yes: true });
  });

  it("treats --flag= as empty string, not boolean", () => {
    const result = parseArgv(["pause", "--contract="]);
    expect(result.flags).toEqual({ contract: "" });
  });

  it("handles mixed positionals and flags", () => {
    const result = parseArgv(["mint", "--to", "GABC", "--amount", "1000", "--yes"]);
    expect(result.positionals).toEqual(["mint"]);
    expect(result.flags).toEqual({ to: "GABC", amount: "1000", yes: true });
  });
});

describe("coerceArg", () => {
  it("passes string through", () => {
    expect(coerceArg("hello", "string", "name")).toBe("hello");
  });

  it("accepts G... address", () => {
    const g = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
    expect(coerceArg(g, "address", "to")).toBe(g);
  });

  it("accepts C... contract id", () => {
    const c = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
    expect(coerceArg(c, "address", "contract")).toBe(c);
  });

  it("rejects an address that doesn't start with G or C", () => {
    expect(() => coerceArg("XABC", "address", "to")).toThrow(CliArgError);
  });

  it("coerces numeric string to bigint", () => {
    expect(coerceArg("1000000000", "bigint", "amount")).toBe(1_000_000_000n);
  });

  it("rejects non-numeric bigint input", () => {
    expect(() => coerceArg("not-a-number", "bigint", "amount")).toThrow(CliArgError);
  });

  it("coerces numeric string to u32", () => {
    expect(coerceArg("500", "u32", "rateBps")).toBe(500);
  });

  it("rejects negative u32", () => {
    expect(() => coerceArg("-1", "u32", "rateBps")).toThrow(CliArgError);
  });

  it("rejects u32 above 2^32-1", () => {
    expect(() => coerceArg("4294967296", "u32", "rateBps")).toThrow(CliArgError);
  });

  it("accepts 64-char hex32, returns Buffer of length 32", () => {
    const hex = "ab".repeat(32);
    const result = coerceArg(hex, "hex32", "wasmHash") as Buffer;
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(32);
    expect(result.toString("hex")).toBe(hex);
  });

  it("accepts 0x-prefixed hex32", () => {
    const hex = "ab".repeat(32);
    const result = coerceArg(`0x${hex}`, "hex32", "wasmHash") as Buffer;
    expect(result.length).toBe(32);
    expect(result.toString("hex")).toBe(hex);
  });

  it("rejects hex32 shorter than 32 bytes", () => {
    expect(() => coerceArg("ab".repeat(31), "hex32", "wasmHash")).toThrow(CliArgError);
  });

  it("rejects hex32 with non-hex chars", () => {
    expect(() => coerceArg("ZZ".repeat(32), "hex32", "wasmHash")).toThrow(CliArgError);
  });
});

describe("resolveArgs", () => {
  const argSpecs: ArgSpec[] = [
    { name: "contract", flag: "contract", envVar: "CONTRACT_ID", type: "address", required: true, description: "Contract ID" },
    { name: "amount", flag: "amount", envVar: "MINT_AMOUNT", type: "bigint", required: true, description: "Amount" },
    { name: "to", flag: "to", envVar: "MINT_TO", type: "address", required: true, description: "Destination" },
  ];

  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves all flags from CLI flags", () => {
    const out = resolveArgs(argSpecs, { amount: "1000", to: "GABC", contract: "CXYZ" });
    expect(out.contract).toBe("CXYZ");
    expect(out.amount).toBe(1000n);
    expect(out.to).toBe("GABC");
  });

  it("falls back to envVar when flag not provided", () => {
    process.env.CONTRACT_ID = "CFROMENV";
    process.env.MINT_TO = "GFROMENV";
    process.env.MINT_AMOUNT = "5000";
    const out = resolveArgs(argSpecs, {});
    expect(out.contract).toBe("CFROMENV");
    expect(out.amount).toBe(5000n);
    expect(out.to).toBe("GFROMENV");
  });

  it("flag overrides env when both are set", () => {
    process.env.CONTRACT_ID = "CFROMENV";
    const out = resolveArgs(
      [{ name: "contract", flag: "contract", envVar: "CONTRACT_ID", type: "address", required: true, description: "" }],
      { contract: "CFROMFLAG" },
    );
    expect(out.contract).toBe("CFROMFLAG");
  });

  it("throws when required arg is missing from both flag and env", () => {
    expect(() => resolveArgs([{ name: "to", flag: "to", envVar: "MINT_TO", type: "address", required: true, description: "" }], {})).toThrow(
      CliArgError,
    );
    // Error message names the flag and the env var
    try {
      resolveArgs([{ name: "to", flag: "to", envVar: "MINT_TO", type: "address", required: true, description: "" }], {});
    } catch (e) {
      expect((e as Error).message).toMatch(/--to/);
      expect((e as Error).message).toMatch(/MINT_TO/);
    }
  });

  it("skips optional args silently when missing", () => {
    const out = resolveArgs(
      [{ name: "to", flag: "to", envVar: "MINT_TO", type: "address", required: false, description: "" }],
      {},
    );
    expect(out.to).toBeUndefined();
  });
});
