/**
 * Tests for `scripts/deploy-full.ts`.
 *
 * STEL1-5 regression — the inverse of the audit's PoC. The audit's PoC
 * passes because the buggy script collapses every privileged role into
 * `MINTER_PUBLIC_KEY`. The "no-collapse" test below passes because the
 * fixed script reads each role from its own env var and passes each
 * distinct value into `deployFull`. The "fail-closed" tests prove the
 * script aborts (without calling `deployFull`) when any single required
 * role var is missing.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

const ROLE_ENV_VARS = [
  "ADMIN_PUBLIC_KEY",
  "MINTER_PUBLIC_KEY",
  "YIELD_RECIPIENT_MANAGER_PUBLIC_KEY",
  "YIELD_RECIPIENT_PUBLIC_KEY",
  "FORCED_TRANSFER_MANAGER_PUBLIC_KEY",
  "BLOCK_OPERATOR_PUBLIC_KEY",
  "UNBLOCK_OPERATOR_PUBLIC_KEY",
  "PAUSER_PUBLIC_KEY",
] as const;

type RoleEnvVar = (typeof ROLE_ENV_VARS)[number];

describe("scripts/deploy-full.ts (STEL1-5)", () => {
  const originalEnv = process.env;
  let tempDir: string;
  let envSetup: Record<string, string>;

  beforeEach(() => {
    jest.resetModules();

    jest.doMock("dotenv", () => ({ config: jest.fn() }));

    // Mock the new dependencies the deploy script invokes: all preflights
    // (no Horizon / Fireblocks API hits in unit tests), interactive confirm
    // (auto-yes), and receipt writer (no disk writes).
    jest.doMock("../../src/deploy-checks", () => ({
      assertIssuerNotContaminated: jest.fn().mockResolvedValue(undefined),
      assertIssuerSufficientlyFunded: jest.fn().mockResolvedValue(undefined),
      assertVaultMatchesPubkey: jest.fn().mockResolvedValue(undefined),
      assertIssuerFlagsClean: jest.fn().mockResolvedValue(undefined),
      assertDeployerSufficientlyFunded: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock("../../scripts/lib/confirm", () => ({
      confirm: jest.fn().mockResolvedValue(true),
    }));
    jest.doMock("../../scripts/lib/deploy-receipt", () => ({
      gitInfo: jest.fn().mockReturnValue({
        commit: "deadbeef",
        branch: "test",
        repo: "test",
        dirty: false,
      }),
      writeDeployReceipt: jest.fn().mockReturnValue("/tmp/fake-receipt.json"),
    }));

    jest.restoreAllMocks();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stel1-5-deploy-"));

    const issuer = Keypair.random().publicKey();
    const secretPath = path.join(tempDir, "fireblocks-secret.key");
    const wasmPath = path.join(tempDir, "mintergateway.wasm");

    fs.writeFileSync(
      secretPath,
      "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    );
    const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
    fs.writeFileSync(wasmPath, wasmBytes);
    const wasmSha256 = createHash("sha256").update(wasmBytes).digest("hex");

    envSetup = {
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      FIREBLOCKS_API_KEY: "fb-api-key",
      FIREBLOCKS_SECRET_PATH: secretPath,
      FIREBLOCKS_ASSET_ID: "XLM_TEST",
      FIREBLOCKS_BASE_PATH: "sandbox",
      ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID: "0",
      ISSUER_PUBLIC_KEY: issuer,
      MINTER_FIREBLOCKS_VAULT_ACCOUNT_ID: "1",
      ASSET_CODE: "TMGUSD",
      WASM_PATH: wasmPath,
      EXPECTED_WASM_SHA256: wasmSha256,
      DEPLOYER_SECRET_KEY: Keypair.random().secret(),
      HOME_DOMAIN: "test.example",
      // Each role gets its OWN distinct pubkey — proves no-collapse.
      ADMIN_PUBLIC_KEY: Keypair.random().publicKey(),
      MINTER_PUBLIC_KEY: Keypair.random().publicKey(),
      YIELD_RECIPIENT_MANAGER_PUBLIC_KEY: Keypair.random().publicKey(),
      YIELD_RECIPIENT_PUBLIC_KEY: Keypair.random().publicKey(),
      FORCED_TRANSFER_MANAGER_PUBLIC_KEY: Keypair.random().publicKey(),
      BLOCK_OPERATOR_PUBLIC_KEY: Keypair.random().publicKey(),
      UNBLOCK_OPERATOR_PUBLIC_KEY: Keypair.random().publicKey(),
      PAUSER_PUBLIC_KEY: Keypair.random().publicKey(),
    };

    process.env = { ...originalEnv, ...envSetup };
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes each role's own env var into deployFull (no role collapse)", async () => {
    const sdk = require("../../src") as typeof import("../../src");

    const deploySpy = jest
      .spyOn(sdk.SctokenFireblocksClient.prototype, "deployFull")
      .mockResolvedValue({
        sacContractId: "C".padEnd(56, "A"),
        wasmHash: "11".repeat(32),
        wrapperContractId: "C".padEnd(56, "B"),
      });

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { main } = require("../../scripts/deploy-full") as {
      main: () => Promise<void>;
    };

    // Directly await main() — no setImmediate guessing needed.
    await main();

    expect(deploySpy).toHaveBeenCalledTimes(1);

    const [params] = deploySpy.mock.calls[0];

    // Each privileged role must come from its dedicated env var.
    expect(params.admin).toBe(process.env.ADMIN_PUBLIC_KEY);
    expect(params.minter).toBe(process.env.MINTER_PUBLIC_KEY);
    expect(params.yieldRecipientManager).toBe(
      process.env.YIELD_RECIPIENT_MANAGER_PUBLIC_KEY,
    );
    expect(params.yieldRecipient).toBe(process.env.YIELD_RECIPIENT_PUBLIC_KEY);
    expect(params.forcedTransferManager).toBe(
      process.env.FORCED_TRANSFER_MANAGER_PUBLIC_KEY,
    );
    expect(params.blockOperator).toBe(process.env.BLOCK_OPERATOR_PUBLIC_KEY);
    expect(params.unblockOperator).toBe(process.env.UNBLOCK_OPERATOR_PUBLIC_KEY);
    expect(params.pauser).toBe(process.env.PAUSER_PUBLIC_KEY);

    // Strong "no collapse" assertion: the eight role values are all
    // distinct. The audit's PoC bug-state would have all equal.
    const roles = [
      params.admin,
      params.minter,
      params.yieldRecipientManager,
      params.yieldRecipient,
      params.forcedTransferManager,
      params.blockOperator,
      params.unblockOperator,
      params.pauser,
    ];
    expect(new Set(roles).size).toBe(8);
  });

  it.each(ROLE_ENV_VARS)(
    "aborts (fail-closed) when %s is missing — never calls deployFull",
    async (missing: RoleEnvVar) => {
      delete process.env[missing];

      const sdk = require("../../src") as typeof import("../../src");

      const deploySpy = jest
        .spyOn(sdk.SctokenFireblocksClient.prototype, "deployFull")
        .mockResolvedValue({
          sacContractId: "C".padEnd(56, "A"),
          wasmHash: "11".repeat(32),
          wrapperContractId: "C".padEnd(56, "B"),
        });

      jest.spyOn(console, "log").mockImplementation(() => undefined);
      jest.spyOn(console, "error").mockImplementation(() => undefined);

      const { main } = require("../../scripts/deploy-full") as {
        main: () => Promise<void>;
      };

      // main() rejects — await and assert the rejection names the missing var.
      // No process.exit mocking needed.
      await expect(main()).rejects.toThrow(missing);

      expect(deploySpy).not.toHaveBeenCalled();
    },
  );

  it("aborts when a role env var is set to something not starting with G", async () => {
    process.env.ADMIN_PUBLIC_KEY = "SBADADMINKEY"; // 'S'-prefixed (secret seed style)

    const sdk = require("../../src") as typeof import("../../src");

    const deploySpy = jest
      .spyOn(sdk.SctokenFireblocksClient.prototype, "deployFull")
      .mockResolvedValue({
        sacContractId: "C".padEnd(56, "A"),
        wasmHash: "11".repeat(32),
        wrapperContractId: "C".padEnd(56, "B"),
      });

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { main } = require("../../scripts/deploy-full") as {
      main: () => Promise<void>;
    };

    await expect(main()).rejects.toThrow(/ADMIN_PUBLIC_KEY/);

    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("aborts when EXPECTED_WASM_SHA256 is missing", async () => {
    delete process.env.EXPECTED_WASM_SHA256;

    const sdk = require("../../src") as typeof import("../../src");
    const deploySpy = jest
      .spyOn(sdk.SctokenFireblocksClient.prototype, "deployFull")
      .mockResolvedValue({
        sacContractId: "C".padEnd(56, "A"),
        wasmHash: "11".repeat(32),
        wrapperContractId: "C".padEnd(56, "B"),
      });

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { main } = require("../../scripts/deploy-full") as {
      main: () => Promise<void>;
    };

    await expect(main()).rejects.toThrow(/EXPECTED_WASM_SHA256/);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("aborts when EXPECTED_WASM_SHA256 does not match the file's actual sha256", async () => {
    // Replace the file's content so its sha256 no longer matches what envSetup recorded.
    fs.writeFileSync(process.env.WASM_PATH as string, Buffer.from([0xff, 0xff, 0xff, 0xff]));

    const sdk = require("../../src") as typeof import("../../src");
    const deploySpy = jest
      .spyOn(sdk.SctokenFireblocksClient.prototype, "deployFull")
      .mockResolvedValue({
        sacContractId: "C".padEnd(56, "A"),
        wasmHash: "11".repeat(32),
        wrapperContractId: "C".padEnd(56, "B"),
      });

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { main } = require("../../scripts/deploy-full") as {
      main: () => Promise<void>;
    };

    await expect(main()).rejects.toThrow(/WASM hash mismatch/);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("does not call deployFull when the operator declines the confirm prompt", async () => {
    jest.doMock("../../scripts/lib/confirm", () => ({
      confirm: jest.fn().mockResolvedValue(false),
    }));

    const sdk = require("../../src") as typeof import("../../src");
    const deploySpy = jest
      .spyOn(sdk.SctokenFireblocksClient.prototype, "deployFull")
      .mockResolvedValue({
        sacContractId: "C".padEnd(56, "A"),
        wasmHash: "11".repeat(32),
        wrapperContractId: "C".padEnd(56, "B"),
      });

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { main } = require("../../scripts/deploy-full") as {
      main: () => Promise<void>;
    };

    await main();
    expect(deploySpy).not.toHaveBeenCalled();
  });
});
