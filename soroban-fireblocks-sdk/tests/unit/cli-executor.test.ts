import { Networks } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";

// Mock the SDK client + config loaders BEFORE importing the executor.
jest.mock("../../src/sctoken-client");
jest.mock("../../src/config");

import { executeCommand } from "../../scripts/cli/executor";
import { CliArgError } from "../../scripts/cli/args";
import { SctokenFireblocksClient } from "../../src/sctoken-client";
import * as config from "../../src/config";
import { ConfigError } from "../../src/errors";
import type { CommandSpec, ExecutionContext } from "../../scripts/cli/types";
import type { SorobanFireblocksConfig } from "../../src/types";

const mockedClient = SctokenFireblocksClient as unknown as jest.Mock;
const mockedConfig = config as jest.Mocked<typeof config>;

function makeConfig(role = "PAUSER"): SorobanFireblocksConfig {
  return {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    fireblocksApiKey: "key",
    fireblocksSecretKey: "secret",
    fireblocksVaultAccountId: "2",
    fireblocksAssetId: "XLM_TEST",
    sourcePublicKey: `G${role}123`,
  };
}

function makeSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    name: "pause",
    contractMethod: "pause",
    role: "PAUSER",
    args: [{ name: "contract", flag: "contract", envVar: "CONTRACT_ID", type: "address", required: true, description: "" }],
    description: "Pause the contract",
    destructive: false,
    invoke: jest.fn(async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: "abc",
      ledger: 100,
    })),
    ...overrides,
  };
}

const baseOptions = { dryRun: false, yes: false, json: false, help: false };

describe("executor: role resolution + lazy env validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedClient.mockImplementation(() => ({} as never));
    mockedConfig.loadPauserConfigFromEnv.mockReturnValue(makeConfig("PAUSER"));
    mockedConfig.loadMinterConfigFromEnv.mockReturnValue(makeConfig("MINTER"));
    mockedConfig.loadAdminConfigFromEnv.mockReturnValue(makeConfig("ADMIN"));
    mockedConfig.loadReadOnlyConfigFromEnv.mockReturnValue(makeConfig("VIEW"));
  });

  it("calls only the PAUSER loader when running a PAUSER command", async () => {
    await executeCommand(makeSpec({ role: "PAUSER" }), { contract: "CABC" }, baseOptions);

    expect(mockedConfig.loadPauserConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(mockedConfig.loadMinterConfigFromEnv).not.toHaveBeenCalled();
    expect(mockedConfig.loadAdminConfigFromEnv).not.toHaveBeenCalled();
    expect(mockedConfig.loadReadOnlyConfigFromEnv).not.toHaveBeenCalled();
  });

  it("calls only the MINTER loader when running a MINTER command", async () => {
    await executeCommand(
      makeSpec({ name: "mint", contractMethod: "mint", role: "MINTER" }),
      { contract: "CABC" },
      baseOptions,
    );

    expect(mockedConfig.loadMinterConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(mockedConfig.loadPauserConfigFromEnv).not.toHaveBeenCalled();
  });

  it("calls only the read-only loader for VIEW commands", async () => {
    await executeCommand(
      makeSpec({ name: "query-paused", contractMethod: "paused", role: "VIEW" }),
      { contract: "CABC" },
      baseOptions,
    );

    expect(mockedConfig.loadReadOnlyConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(mockedConfig.loadPauserConfigFromEnv).not.toHaveBeenCalled();
    expect(mockedConfig.loadMinterConfigFromEnv).not.toHaveBeenCalled();
  });

  it("reformats ConfigError to name only the invoked command's role", async () => {
    mockedConfig.loadMinterConfigFromEnv.mockImplementation(() => {
      throw new ConfigError("Missing required config: MINTER_PUBLIC_KEY");
    });

    await expect(
      executeCommand(
        makeSpec({ name: "mint", contractMethod: "mint", role: "MINTER" }),
        { contract: "CABC" },
        baseOptions,
      ),
    ).rejects.toThrow(CliArgError);

    try {
      await executeCommand(
        makeSpec({ name: "mint", contractMethod: "mint", role: "MINTER" }),
        { contract: "CABC" },
        baseOptions,
      );
    } catch (e) {
      // Mentions only MINTER role; nothing about ADMIN/PAUSER/etc.
      expect((e as Error).message).toMatch(/mint/);
      expect((e as Error).message).toMatch(/MINTER/);
      expect((e as Error).message).not.toMatch(/ADMIN/);
      expect((e as Error).message).not.toMatch(/PAUSER/);
    }
  });
});

describe("executor: dry-run", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedClient.mockImplementation(() => ({} as never));
    mockedConfig.loadPauserConfigFromEnv.mockReturnValue(makeConfig("PAUSER"));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints preview and does NOT call invoke", async () => {
    const invoke = jest.fn();
    await executeCommand(
      makeSpec({ invoke }),
      { contract: "CABC" },
      { ...baseOptions, dryRun: true },
    );

    expect(invoke).not.toHaveBeenCalled();
    // Preview header was printed
    const allLogs = logSpy.mock.calls.flat().join("\n");
    expect(allLogs).toMatch(/Dry-run preview/);
    expect(allLogs).toMatch(/pause/);
    expect(allLogs).toMatch(/CABC/);
  });

  it("still runs preflight in dry-run (catches misconfig before signing)", async () => {
    const preflight = jest.fn();
    const invoke = jest.fn();
    await executeCommand(
      makeSpec({ preflight, invoke }),
      { contract: "CABC" },
      { ...baseOptions, dryRun: true },
    );

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not prompt in dry-run even on destructive commands", async () => {
    const invoke = jest.fn();
    await executeCommand(
      makeSpec({ destructive: true, invoke }),
      { contract: "CABC" },
      { ...baseOptions, dryRun: true },
    );

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("executor: destructive + confirmation gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedClient.mockImplementation(() => ({} as never));
    mockedConfig.loadPauserConfigFromEnv.mockReturnValue(makeConfig("PAUSER"));
  });

  it("with --yes, runs invoke without prompting", async () => {
    const invoke = jest.fn(async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: "abc",
      ledger: 100,
    }));

    jest.spyOn(console, "log").mockImplementation(() => {});

    await executeCommand(
      makeSpec({ destructive: true, invoke }),
      { contract: "CABC" },
      { ...baseOptions, yes: true },
    );

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("executor: preflight + postcheck", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedClient.mockImplementation(() => ({} as never));
    mockedConfig.loadPauserConfigFromEnv.mockReturnValue(makeConfig("PAUSER"));
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs preflight, invoke, postcheck in that order", async () => {
    const order: string[] = [];
    const preflight = jest.fn(async () => {
      order.push("preflight");
    });
    const invoke = jest.fn(async () => {
      order.push("invoke");
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: "abc", ledger: 100 };
    });
    const postcheck = jest.fn(async () => {
      order.push("postcheck");
    });

    await executeCommand(
      makeSpec({ preflight, invoke, postcheck }),
      { contract: "CABC" },
      { ...baseOptions, yes: true },
    );

    expect(order).toEqual(["preflight", "invoke", "postcheck"]);
  });

  it("aborts before invoke if preflight throws", async () => {
    const preflight = jest.fn(async () => {
      throw new Error("pauser mismatch");
    });
    const invoke = jest.fn();

    await expect(
      executeCommand(
        makeSpec({ preflight, invoke }),
        { contract: "CABC" },
        { ...baseOptions, yes: true },
      ),
    ).rejects.toThrow(/pauser mismatch/);

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("executor: passes resolved args to invoke", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedClient.mockImplementation(() => ({ mockedClient: true } as never));
    mockedConfig.loadMinterConfigFromEnv.mockReturnValue(makeConfig("MINTER"));
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  it("invoke receives an ExecutionContext with resolvedArgs containing coerced values", async () => {
    let received: ExecutionContext | undefined;
    const spec = makeSpec({
      name: "mint",
      contractMethod: "mint",
      role: "MINTER",
      args: [
        { name: "contract", flag: "contract", type: "address", required: true, description: "" },
        { name: "to", flag: "to", type: "address", required: true, description: "" },
        { name: "amount", flag: "amount", type: "bigint", required: true, description: "" },
      ],
      invoke: jest.fn(async (ctx) => {
        received = ctx;
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: "abc", ledger: 100 };
      }),
    });

    await executeCommand(spec, { contract: "CABC", to: "GDEF", amount: "1000000" }, { ...baseOptions, yes: true });

    expect(received).toBeDefined();
    expect(received!.resolvedArgs.contract).toBe("CABC");
    expect(received!.resolvedArgs.to).toBe("GDEF");
    expect(received!.resolvedArgs.amount).toBe(1_000_000n);
    expect(received!.config.sourcePublicKey).toBe("GMINTER123");
  });
});
