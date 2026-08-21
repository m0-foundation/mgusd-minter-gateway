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
  "ONBOARDER_PUBLIC_KEY",
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

    // Safety net: stub `child_process.execFileSync` so the resolver can't
    // accidentally fork `gh`/`git`/`stellar` if a test forgets to mock the
    // attestation module. Tests that need real exec behavior override this.
    jest.doMock("child_process", () => {
      const actual = jest.requireActual("child_process") as object;
      return {
        ...actual,
        execFileSync: jest.fn(() => {
          throw new Error("execFileSync called without explicit mock");
        }),
      };
    });

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
      // Existing tests pre-date the attestation feature — they all supply a
      // local WASM_PATH. Default ALLOW_UNATTESTED_WASM=1 here so they keep
      // hitting the dev-iteration path; tests that exercise the new decision
      // matrix override these vars individually.
      ALLOW_UNATTESTED_WASM: "1",
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
      ONBOARDER_PUBLIC_KEY: Keypair.random().publicKey(),
    };

    process.env = { ...originalEnv, ...envSetup };
    // These three control the attestation path and must NOT leak in from
    // the parent shell. Each test that needs them sets them explicitly.
    delete process.env.RELEASE_TAG;
    delete process.env.RELEASE_REPO;
    delete process.env.CROSS_VERIFY_LOCAL_BUILD;
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
    expect(params.onboarder).toBe(process.env.ONBOARDER_PUBLIC_KEY);

    // Strong "no collapse" assertion: all nine role values are distinct.
    const roles = [
      params.admin,
      params.minter,
      params.yieldRecipientManager,
      params.yieldRecipient,
      params.forcedTransferManager,
      params.blockOperator,
      params.unblockOperator,
      params.pauser,
      params.onboarder,
    ];
    expect(new Set(roles).size).toBe(9);
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

  // ── resolveWasmSource decision matrix (PR #80 attestation parity) ──────
  //
  // Helper: install a fake attestation module that records its calls and
  // simulates the WASM download into the existing temp WASM_PATH so the
  // downstream readFileSync + sha256 + EXPECTED_WASM_SHA256 check all pass.
  function mockAttestation(opts: {
    onFetch?: () => void;
    fetchThrows?: Error;
    verifyThrows?: Error;
    crossVerifyThrows?: Error;
  } = {}) {
    const fetchAttestedWasm = jest.fn().mockImplementation(() => {
      if (opts.fetchThrows) throw opts.fetchThrows;
      if (opts.onFetch) opts.onFetch();
      return process.env.WASM_PATH as string;
    });
    const verifyAttestation = jest.fn().mockImplementation(() => {
      if (opts.verifyThrows) throw opts.verifyThrows;
    });
    const crossVerifyLocalBuild = jest.fn().mockImplementation(() => {
      if (opts.crossVerifyThrows) throw opts.crossVerifyThrows;
    });
    jest.doMock("../../scripts/lib/attestation", () => ({
      requireGhCli: jest.fn(),
      fetchAttestedWasm,
      verifyAttestation,
      resolveReleaseCommit: jest.fn(),
      crossVerifyLocalBuild,
    }));
    return { fetchAttestedWasm, verifyAttestation, crossVerifyLocalBuild };
  }

  function spyDeploy() {
    const sdk = require("../../src") as typeof import("../../src");
    return jest
      .spyOn(sdk.SctokenFireblocksClient.prototype, "deployFull")
      .mockResolvedValue({
        sacContractId: "C".padEnd(56, "A"),
        wasmHash: "11".repeat(32),
        wrapperContractId: "C".padEnd(56, "B"),
      });
  }

  function silenceConsole() {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    return jest.spyOn(console, "warn").mockImplementation(() => undefined);
  }

  it("Path 1 (attested): RELEASE_TAG set → fetch + verify run; deployFull is called", async () => {
    process.env.RELEASE_TAG = "v1.0.0";
    process.env.RELEASE_REPO = "m0-foundation/mgusd-minter-gateway";
    delete process.env.WASM_PATH;

    // Re-point the resolver at the pre-seeded WASM so the EXPECTED_WASM_SHA256
    // check still passes after the download "happens".
    const seededPath = path.join(tempDir, "mintergateway.wasm");
    process.env.WASM_PATH = seededPath; // restored for the helper to return

    const { fetchAttestedWasm, verifyAttestation, crossVerifyLocalBuild } = mockAttestation();
    const deploySpy = spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };
    await main();

    expect(fetchAttestedWasm).toHaveBeenCalledTimes(1);
    expect(fetchAttestedWasm).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    );
    expect(verifyAttestation).toHaveBeenCalledTimes(1);
    expect(crossVerifyLocalBuild).not.toHaveBeenCalled(); // not opted in
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });

  it("Path 1 → receipt is written with wasm.attested=true plus releaseTag/releaseRepo", async () => {
    process.env.RELEASE_TAG = "v1.2.3";
    process.env.RELEASE_REPO = "m0-foundation/mgusd-minter-gateway";

    const writeDeployReceipt = jest.fn().mockReturnValue("/tmp/fake.json");
    jest.doMock("../../scripts/lib/deploy-receipt", () => ({
      gitInfo: jest.fn().mockReturnValue({
        commit: "deadbeef",
        branch: "test",
        repo: "test",
        dirty: false,
      }),
      writeDeployReceipt,
    }));

    mockAttestation();
    spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };
    await main();

    expect(writeDeployReceipt).toHaveBeenCalledTimes(1);
    const [receipt] = writeDeployReceipt.mock.calls[0];
    expect(receipt.wasm.attested).toBe(true);
    expect(receipt.wasm.releaseTag).toBe("v1.2.3");
    expect(receipt.wasm.releaseRepo).toBe("m0-foundation/mgusd-minter-gateway");
  });

  it("Path 2 (dev): WASM_PATH + ALLOW_UNATTESTED_WASM=1 → no gh calls; warning printed; attested=false", async () => {
    process.env.ALLOW_UNATTESTED_WASM = "1";
    delete process.env.RELEASE_TAG;

    const writeDeployReceipt = jest.fn().mockReturnValue("/tmp/fake.json");
    jest.doMock("../../scripts/lib/deploy-receipt", () => ({
      gitInfo: jest.fn().mockReturnValue({
        commit: "deadbeef",
        branch: "test",
        repo: "test",
        dirty: false,
      }),
      writeDeployReceipt,
    }));

    const { fetchAttestedWasm, verifyAttestation } = mockAttestation();
    const deploySpy = spyDeploy();
    const warnSpy = silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };
    await main();

    expect(fetchAttestedWasm).not.toHaveBeenCalled();
    expect(verifyAttestation).not.toHaveBeenCalled();
    expect(deploySpy).toHaveBeenCalledTimes(1);

    // Loud warning explicitly flags unattested deploys.
    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allWarnings).toMatch(/UNATTESTED|attestation/i);

    const [receipt] = writeDeployReceipt.mock.calls[0];
    expect(receipt.wasm.attested).toBe(false);
    expect(receipt.wasm.releaseTag).toBeUndefined();
    expect(receipt.wasm.releaseRepo).toBeUndefined();
  });

  it("Path 3 (hard-error): WASM_PATH set without ALLOW_UNATTESTED_WASM=1 → main rejects, deployFull not called", async () => {
    delete process.env.RELEASE_TAG;
    delete process.env.ALLOW_UNATTESTED_WASM;
    // WASM_PATH is already set from beforeEach.

    mockAttestation();
    const deploySpy = spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };

    await expect(main()).rejects.toThrow(/ALLOW_UNATTESTED_WASM/);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("Path: neither RELEASE_TAG nor WASM_PATH set → main rejects with a clear error", async () => {
    delete process.env.RELEASE_TAG;
    delete process.env.WASM_PATH;
    delete process.env.ALLOW_UNATTESTED_WASM;

    mockAttestation();
    const deploySpy = spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };

    await expect(main()).rejects.toThrow(/RELEASE_TAG|WASM_PATH/);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("Path 4: RELEASE_TAG wins over WASM_PATH; warns it's ignoring WASM_PATH", async () => {
    process.env.RELEASE_TAG = "v1.0.0";
    process.env.RELEASE_REPO = "m0-foundation/mgusd-minter-gateway";
    process.env.ALLOW_UNATTESTED_WASM = "1"; // even with this, attested wins

    const { fetchAttestedWasm, verifyAttestation } = mockAttestation();
    const deploySpy = spyDeploy();
    const warnSpy = silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };
    await main();

    expect(fetchAttestedWasm).toHaveBeenCalledTimes(1);
    expect(verifyAttestation).toHaveBeenCalledTimes(1);
    expect(deploySpy).toHaveBeenCalledTimes(1);

    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allWarnings).toMatch(/ignoring WASM_PATH/i);
  });

  it("EXPECTED_WASM_SHA256 still gates the attested path (mismatch throws)", async () => {
    process.env.RELEASE_TAG = "v1.0.0";
    process.env.RELEASE_REPO = "m0-foundation/mgusd-minter-gateway";
    // Replace the file's content so its sha256 no longer matches what envSetup recorded.
    fs.writeFileSync(process.env.WASM_PATH as string, Buffer.from([0xff, 0xff, 0xff, 0xff]));

    mockAttestation();
    const deploySpy = spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };

    await expect(main()).rejects.toThrow(/WASM hash mismatch/);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("Cross-verify is OFF by default — even on attested path", async () => {
    process.env.RELEASE_TAG = "v1.0.0";
    process.env.RELEASE_REPO = "m0-foundation/mgusd-minter-gateway";
    delete process.env.CROSS_VERIFY_LOCAL_BUILD;

    const { crossVerifyLocalBuild } = mockAttestation();
    spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };
    await main();

    expect(crossVerifyLocalBuild).not.toHaveBeenCalled();
  });

  it("Cross-verify ON + prereq missing → HARD ERROR (matches bash strictness)", async () => {
    process.env.RELEASE_TAG = "v1.0.0";
    process.env.RELEASE_REPO = "m0-foundation/mgusd-minter-gateway";
    process.env.CROSS_VERIFY_LOCAL_BUILD = "1";

    const { crossVerifyLocalBuild } = mockAttestation({
      crossVerifyThrows: new Error("stellar CLI required for cross-verify"),
    });
    const deploySpy = spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };

    await expect(main()).rejects.toThrow(/stellar CLI required/);
    expect(crossVerifyLocalBuild).toHaveBeenCalledTimes(1);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("Cross-verify ON + match → cross-verify ran, deployFull called", async () => {
    process.env.RELEASE_TAG = "v1.0.0";
    process.env.RELEASE_REPO = "m0-foundation/mgusd-minter-gateway";
    process.env.CROSS_VERIFY_LOCAL_BUILD = "1";

    const { crossVerifyLocalBuild } = mockAttestation();
    const deploySpy = spyDeploy();
    silenceConsole();

    const { main } = require("../../scripts/deploy-full") as { main: () => Promise<void> };
    await main();

    expect(crossVerifyLocalBuild).toHaveBeenCalledTimes(1);
    expect(deploySpy).toHaveBeenCalledTimes(1);
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
