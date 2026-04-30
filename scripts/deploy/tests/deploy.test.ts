import { Horizon, Keypair, Networks, rpc, StrKey, Transaction, xdr } from "@stellar/stellar-sdk";

import {
  ConfigError,
  IssuerContaminatedError,
  WasmHashMismatchError,
  addressToScVal,
  assertIssuerNotContaminated,
  confirmMainnetPassphrase,
  DeployClient,
  DeployEnv,
  deriveNetworkConfig,
  loadDeployEnv,
  parseCliArgs,
  requireRolePubkey,
} from "../src/deploy";

// =============================================================================
// Fixtures — generated at runtime so checksums are always valid
// =============================================================================

const VALID_PUBKEY = Keypair.random().publicKey();
// The issuer keypair is used by the orchestration tests to produce real
// Ed25519 signatures via the mocked `fireblocksSign` — `addSignatureToTransaction`
// validates the signature against the public key, so a random "f".repeat(128)
// would fail signature verification.
const ISSUER_KEYPAIR = Keypair.random();
const ISSUER_PUBKEY = ISSUER_KEYPAIR.publicKey();
const FAKE_SAC_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0x01));
const FAKE_WRAPPER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0x02));
const ROLE_VARS = [
  "ADMIN_PUBLIC_KEY",
  "MINTER_PUBLIC_KEY",
  "YIELD_RECIPIENT_MANAGER_PUBLIC_KEY",
  "YIELD_RECIPIENT_PUBLIC_KEY",
  "FORCED_TRANSFER_MANAGER_PUBLIC_KEY",
  "BLOCK_OPERATOR_PUBLIC_KEY",
  "UNBLOCK_OPERATOR_PUBLIC_KEY",
  "PAUSER_PUBLIC_KEY",
];

function makeBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    STELLAR_NETWORK: "testnet",
    ASSET_CODE: "TMGUSD",
    ISSUER_PUBLIC_KEY: ISSUER_PUBKEY,
    FIREBLOCKS_API_KEY: "fb-key",
    FIREBLOCKS_SECRET_PATH: "/some/path/that/is/never/read.pem",
    FIREBLOCKS_VAULT_ACCOUNT_ID: "0",
    FIREBLOCKS_ASSET_ID: "XLM_TEST",
    FIREBLOCKS_BASE_PATH: "sandbox",
    FIREBLOCKS_POLL_TIMEOUT_SECONDS: "120",
  };
  for (const v of ROLE_VARS) {
    env[v] = VALID_PUBKEY;
  }
  return env;
}

// =============================================================================
// Role separation enforcement
// =============================================================================

describe("loadDeployEnv — role separation", () => {
  it.each(ROLE_VARS)("aborts when %s is missing", (varName) => {
    const env = makeBaseEnv();
    delete env[varName];
    expect(() => loadDeployEnv(env)).toThrow(ConfigError);
    expect(() => loadDeployEnv(env)).toThrow(varName);
  });

  it("aborts when ISSUER_PUBLIC_KEY is missing", () => {
    const env = makeBaseEnv();
    delete env.ISSUER_PUBLIC_KEY;
    expect(() => loadDeployEnv(env)).toThrow("ISSUER_PUBLIC_KEY");
  });

  it.each(ROLE_VARS)("aborts when %s is not a valid Stellar pubkey", (varName) => {
    const env = makeBaseEnv();
    env[varName] = "not-a-valid-pubkey";
    expect(() => loadDeployEnv(env)).toThrow(ConfigError);
    expect(() => loadDeployEnv(env)).toThrow("not a valid Stellar pubkey");
  });

  it("loads cleanly when all 8 roles + issuer are valid distinct pubkeys", () => {
    const env = makeBaseEnv();
    const result = loadDeployEnv(env);
    expect(result.roles.admin).toBe(VALID_PUBKEY);
    expect(result.issuerPublicKey).toBe(ISSUER_PUBKEY);
    expect(result.fireblocks.vaultAccountId).toBe("0");
  });

  it("does not read the Fireblocks secret file at env-load time (so dry-run works without a real secret)", () => {
    const env = makeBaseEnv();
    env.FIREBLOCKS_SECRET_PATH = "/this/path/definitely/does/not/exist.pem";
    // Should still succeed — secret read is deferred to createFireblocksClient
    expect(() => loadDeployEnv(env)).not.toThrow();
  });
});

describe("requireRolePubkey", () => {
  it("returns the pubkey when valid", () => {
    expect(requireRolePubkey("ADMIN", { ADMIN: VALID_PUBKEY })).toBe(VALID_PUBKEY);
  });

  it("throws ConfigError when missing", () => {
    expect(() => requireRolePubkey("ADMIN", {})).toThrow(ConfigError);
    expect(() => requireRolePubkey("ADMIN", {})).toThrow("Missing required env var: ADMIN");
  });

  it("throws ConfigError when invalid pubkey", () => {
    expect(() => requireRolePubkey("ADMIN", { ADMIN: "garbage" })).toThrow(
      "not a valid Stellar pubkey",
    );
  });
});

// =============================================================================
// Issuer contamination check
// =============================================================================

interface AssetRecord {
  accounts: {
    authorized: number;
    authorized_to_maintain_liabilities: number;
    unauthorized: number;
  };
  num_claimable_balances: number;
  num_liquidity_pools: number;
  num_contracts: number;
}

function makeRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    accounts: {
      authorized: 0,
      authorized_to_maintain_liabilities: 0,
      unauthorized: 0,
      ...(overrides.accounts ?? {}),
    },
    num_claimable_balances: overrides.num_claimable_balances ?? 0,
    num_liquidity_pools: overrides.num_liquidity_pools ?? 0,
    num_contracts: overrides.num_contracts ?? 0,
  };
}

function makeHorizon(records: AssetRecord[]): Horizon.Server {
  const callBuilder = {
    forCode: jest.fn().mockReturnThis(),
    forIssuer: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records }),
  };
  return {
    assets: jest.fn().mockReturnValue(callBuilder),
  } as unknown as Horizon.Server;
}

describe("assertIssuerNotContaminated", () => {
  it("passes when Horizon returns no record for the asset", async () => {
    const horizon = makeHorizon([]);
    await expect(
      assertIssuerNotContaminated(horizon, "MGUSD", ISSUER_PUBKEY),
    ).resolves.toBeUndefined();
  });

  it("passes when all footprint counts are zero", async () => {
    const horizon = makeHorizon([makeRecord()]);
    await expect(
      assertIssuerNotContaminated(horizon, "MGUSD", ISSUER_PUBKEY),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["authorized trustlines", makeRecord({ accounts: { authorized: 1, authorized_to_maintain_liabilities: 0, unauthorized: 0 } }), { trustlines: 1 }],
    ["authorized_to_maintain_liabilities trustlines", makeRecord({ accounts: { authorized: 0, authorized_to_maintain_liabilities: 2, unauthorized: 0 } }), { trustlines: 2 }],
    ["unauthorized trustlines", makeRecord({ accounts: { authorized: 0, authorized_to_maintain_liabilities: 0, unauthorized: 3 } }), { trustlines: 3 }],
    ["claimable balances", makeRecord({ num_claimable_balances: 4 }), { claimableBalances: 4 }],
    ["liquidity pools", makeRecord({ num_liquidity_pools: 5 }), { liquidityPools: 5 }],
    ["contract holders", makeRecord({ num_contracts: 6 }), { contracts: 6 }],
  ] as const)("rejects when issuer has %s", async (_label, record, expected) => {
    const horizon = makeHorizon([record]);
    await expect(
      assertIssuerNotContaminated(horizon, "MGUSD", ISSUER_PUBKEY),
    ).rejects.toMatchObject({
      name: "IssuerContaminatedError",
      assetCode: "MGUSD",
      assetIssuer: ISSUER_PUBKEY,
      counts: expect.objectContaining(expected),
    });
  });

  it("rejects a single pre-flag trustline on an otherwise-empty issuer", async () => {
    const horizon = makeHorizon([
      makeRecord({ accounts: { authorized: 1, authorized_to_maintain_liabilities: 0, unauthorized: 0 } }),
    ]);
    let thrown: unknown;
    try {
      await assertIssuerNotContaminated(horizon, "POCASSET", ISSUER_PUBKEY);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IssuerContaminatedError);
    expect((thrown as IssuerContaminatedError).message).toContain("AUTH_CLAWBACK_ENABLED");
    expect((thrown as IssuerContaminatedError).counts.trustlines).toBe(1);
  });
});

// =============================================================================
// Network derivation
// =============================================================================

describe("deriveNetworkConfig", () => {
  it("derives testnet RPC + Horizon + passphrase", () => {
    const cfg = deriveNetworkConfig("testnet");
    expect(cfg.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(cfg.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    expect(cfg.networkPassphrase).toBe(Networks.TESTNET);
  });

  it("derives mainnet RPC + Horizon + passphrase", () => {
    const cfg = deriveNetworkConfig("public");
    expect(cfg.rpcUrl).toBe("https://soroban.stellar.org");
    expect(cfg.horizonUrl).toBe("https://horizon.stellar.org");
    expect(cfg.networkPassphrase).toBe(Networks.PUBLIC);
  });

  it("honors RPC + Horizon overrides", () => {
    const cfg = deriveNetworkConfig("testnet", {
      rpcUrl: "https://my-rpc.example",
      horizonUrl: "https://my-horizon.example",
    });
    expect(cfg.rpcUrl).toBe("https://my-rpc.example");
    expect(cfg.horizonUrl).toBe("https://my-horizon.example");
  });
});

// =============================================================================
// CLI parsing
// =============================================================================

describe("parseCliArgs", () => {
  it("defaults to dry-run when no flag passed", () => {
    expect(parseCliArgs([])).toEqual({ mode: "dry-run", networkOverride: undefined });
  });

  it("recognizes --dry-run", () => {
    expect(parseCliArgs(["--dry-run"]).mode).toBe("dry-run");
  });

  it("recognizes --execute", () => {
    expect(parseCliArgs(["--execute"]).mode).toBe("execute");
  });

  it("--execute overrides earlier --dry-run", () => {
    expect(parseCliArgs(["--dry-run", "--execute"]).mode).toBe("execute");
  });

  it("parses --network=testnet|public", () => {
    expect(parseCliArgs(["--network=testnet"]).networkOverride).toBe("testnet");
    expect(parseCliArgs(["--network=public"]).networkOverride).toBe("public");
  });

  it("rejects unknown --network values", () => {
    expect(() => parseCliArgs(["--network=mainnet"])).toThrow("Invalid --network value");
  });
});

// =============================================================================
// Mainnet passphrase confirm
// =============================================================================

describe("confirmMainnetPassphrase", () => {
  function fakeRl(answer: string) {
    return {
      question: (_q: string, cb: (a: string) => void) => cb(answer),
      close: jest.fn(),
    } as unknown as import("readline").Interface;
  }

  it("resolves when passphrase matches", async () => {
    await expect(
      confirmMainnetPassphrase(Networks.PUBLIC, fakeRl(Networks.PUBLIC), false),
    ).resolves.toBeUndefined();
  });

  it("aborts when passphrase mismatches", async () => {
    await expect(
      confirmMainnetPassphrase(Networks.PUBLIC, fakeRl("nope"), false),
    ).rejects.toThrow("Passphrase mismatch");
  });

  it("trims whitespace before compare", async () => {
    await expect(
      confirmMainnetPassphrase(Networks.PUBLIC, fakeRl(`  ${Networks.PUBLIC}  `), false),
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// DeployClient orchestration (with mocks)
// =============================================================================

function makeEnv(): DeployEnv {
  return {
    network: deriveNetworkConfig("testnet"),
    assetCode: "TMGUSD",
    wasmPath: "/tmp/fake.wasm",
    issuerPublicKey: ISSUER_PUBKEY,
    fireblocks: {
      apiKey: "k",
      secretPath: "/never/read.pem",
      basePath: "sandbox",
      vaultAccountId: "0",
      assetId: "XLM_TEST",
      pollTimeoutSeconds: 60,
    },
    roles: {
      admin: VALID_PUBKEY,
      minter: VALID_PUBKEY,
      yieldRecipientManager: VALID_PUBKEY,
      yieldRecipient: VALID_PUBKEY,
      forcedTransferManager: VALID_PUBKEY,
      blockOperator: VALID_PUBKEY,
      unblockOperator: VALID_PUBKEY,
      pauser: VALID_PUBKEY,
    },
  };
}

const TEST_WASM = Buffer.from(
  "0061736d010000000105016000017f030201000404017000000503010001070d010974657374546f6b656e0000",
  "hex",
);
const EXPECTED_TEST_WASM_HASH = require("crypto")
  .createHash("sha256")
  .update(TEST_WASM)
  .digest("hex");

function fakeRpcServer(): rpc.Server {
  // Stellar's TransactionBuilder requires `getAccount` to return an Account
  // instance (not a plain object) because it muxes the source pubkey through
  // strkey decode at .build() time. Use the real Account type here.
  const Account = require("@stellar/stellar-sdk").Account;
  return {
    getAccount: jest.fn(async () => new Account(ISSUER_PUBKEY, "1")),
  } as unknown as rpc.Server;
}

type SubmitFn = (
  tx: Transaction,
) => Promise<rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse>;

function makeDeps(overrides: Partial<{
  fireblocksSign: jest.Mock;
  simulate: jest.Mock;
  submit: jest.Mock;
  horizon: Horizon.Server;
  uploadReturnHash: string;
}> = {}) {
  // Real Ed25519 signature over the actual tx hash so addSignatureToTransaction
  // passes signature verification.
  const fireblocksSign =
    overrides.fireblocksSign ??
    jest.fn(async (hashHex: string) =>
      ISSUER_KEYPAIR.sign(Buffer.from(hashHex, "hex")).toString("hex"),
    );
  const simulate = overrides.simulate ?? jest.fn(async (tx: Transaction) => tx);
  const uploadHash = overrides.uploadReturnHash ?? EXPECTED_TEST_WASM_HASH;

  let stepIndex = 0;
  // The mock returns a structurally-minimal response; cast through `unknown`
  // because GetSuccessfulTransactionResponse has many fields the DeployClient
  // does not consume.
  const submit: SubmitFn =
    (overrides.submit as SubmitFn | undefined) ??
    (jest.fn(async (_tx: Transaction) => {
      stepIndex++;
      if (stepIndex === 2) {
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 100,
          returnValue: addressToScVal(FAKE_SAC_CONTRACT_ID),
        };
      }
      if (stepIndex === 3) {
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 101,
          returnValue: xdr.ScVal.scvBytes(Buffer.from(uploadHash, "hex")),
        };
      }
      if (stepIndex === 4) {
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 102,
          returnValue: addressToScVal(FAKE_WRAPPER_CONTRACT_ID),
        };
      }
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 103 };
    }) as unknown as SubmitFn);

  const horizon = overrides.horizon ?? makeHorizon([]);
  const log = jest.fn();
  return { fireblocksSign, simulate, submit, horizon, log };
}

describe("DeployClient.deployFull (orchestration)", () => {
  it("runs all 5 steps and returns the deployed ids", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const client = new DeployClient(env, {
      rpc: fakeRpcServer(),
      horizon: deps.horizon,
      fireblocksSign: deps.fireblocksSign,
      simulate: deps.simulate,
      submit: deps.submit,
      log: deps.log,
    });

    const result = await client.deployFull(TEST_WASM);

    expect(result.sacContractId).toBe(FAKE_SAC_CONTRACT_ID);
    expect(result.wasmHash).toBe(EXPECTED_TEST_WASM_HASH);
    expect(result.wrapperContractId).toBe(FAKE_WRAPPER_CONTRACT_ID);

    // 5 sign + 5 submit calls (step 1 also uses sign+submit, even though
    // it's a classic op without simulation)
    expect(deps.fireblocksSign).toHaveBeenCalledTimes(5);
    expect(deps.submit).toHaveBeenCalledTimes(5);
    // 4 simulations (steps 2, 3, 4, 5 — step 1 is classic)
    expect(deps.simulate).toHaveBeenCalledTimes(4);
  });

  it("throws WasmHashMismatchError when RPC returns a hash that doesn't match sha256(wasm)", async () => {
    const env = makeEnv();
    const wrongHash = "0".repeat(64);
    const deps = makeDeps({ uploadReturnHash: wrongHash });
    const client = new DeployClient(env, {
      rpc: fakeRpcServer(),
      horizon: deps.horizon,
      fireblocksSign: deps.fireblocksSign,
      simulate: deps.simulate,
      submit: deps.submit,
      log: deps.log,
    });

    await expect(client.deployFull(TEST_WASM)).rejects.toBeInstanceOf(WasmHashMismatchError);
  });

  it("aborts at step 0 when issuer is contaminated", async () => {
    const env = makeEnv();
    const deps = makeDeps({
      horizon: makeHorizon([
        makeRecord({ accounts: { authorized: 1, authorized_to_maintain_liabilities: 0, unauthorized: 0 } }),
      ]),
    });
    const client = new DeployClient(env, {
      rpc: fakeRpcServer(),
      horizon: deps.horizon,
      fireblocksSign: deps.fireblocksSign,
      simulate: deps.simulate,
      submit: deps.submit,
      log: deps.log,
    });

    await expect(client.deployFull(TEST_WASM)).rejects.toBeInstanceOf(IssuerContaminatedError);
    expect(deps.fireblocksSign).not.toHaveBeenCalled();
  });
});

describe("DeployClient.planXdr (dry-run)", () => {
  it("plans the buildable steps without ever calling Fireblocks", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const client = new DeployClient(env, {
      rpc: fakeRpcServer(),
      horizon: deps.horizon,
      fireblocksSign: deps.fireblocksSign,
      simulate: deps.simulate,
      submit: deps.submit,
      log: deps.log,
    });

    const plan = await client.planXdr(TEST_WASM);

    expect(deps.fireblocksSign).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    // 5 step entries; first 3 buildable, last 2 deferred
    expect(plan).toHaveLength(5);
    expect(plan[0].step).toMatch(/^1\/5/);
    expect(plan[0].xdr).not.toBe("(deferred)");
    expect(plan[1].step).toMatch(/^2\/5/);
    expect(plan[1].xdr).not.toBe("(deferred)");
    expect(plan[2].step).toMatch(/^3\/5 upload_wasm/);
    expect(plan[2].step).toContain(EXPECTED_TEST_WASM_HASH);
    expect(plan[3].xdr).toBe("(deferred)");
    expect(plan[4].xdr).toBe("(deferred)");
  });
});
