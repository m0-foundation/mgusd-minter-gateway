import { Account, Keypair, Networks, Operation, rpc, Transaction } from "@stellar/stellar-sdk";
import {
  buildInvokeTransaction,
  buildConfigureIssuerTransaction,
  buildAddIssuerSignerTransaction,
  buildDeploySacTransaction,
  buildUploadWasmTransaction,
  buildDeployContractTransaction,
  simulateAndPrepare,
  submitAndPoll,
  addSignatureToTransaction,
} from "../../src/soroban-tx-builder";
import { SimulationError, SubmissionError } from "../../src/errors";
import { SorobanFireblocksConfig } from "../../src/types";

function makeConfig(overrides?: Partial<SorobanFireblocksConfig>): SorobanFireblocksConfig {
  return {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    fireblocksApiKey: "key",
    fireblocksSecretKey: "secret",
    fireblocksVaultAccountId: "0",
    fireblocksAssetId: "XLM_TEST",
    sourcePublicKey: Keypair.random().publicKey(),
    ...overrides,
  };
}

function mockServer(overrides: Record<string, jest.Mock> = {}): rpc.Server {
  return {
    getAccount: jest.fn().mockResolvedValue(
      new Account(Keypair.random().publicKey(), "100"),
    ),
    simulateTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    getTransaction: jest.fn(),
    ...overrides,
  } as unknown as rpc.Server;
}

describe("buildInvokeTransaction", () => {
  it("builds a transaction with the correct source account", async () => {
    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    const tx = await buildInvokeTransaction(server, config, {
      contractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
      method: "increment",
    });

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.source).toBe(kp.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });
});

describe("simulateAndPrepare", () => {
  it("throws SimulationError on simulation error response", async () => {
    const server = mockServer({
      simulateTransaction: jest.fn().mockResolvedValue({
        error: "something went wrong",
        _parsed: true,
      }),
    });

    const origIsError = rpc.Api.isSimulationError;
    const origIsSuccess = rpc.Api.isSimulationSuccess;
    (rpc.Api as any).isSimulationError = jest.fn().mockReturnValue(true);
    (rpc.Api as any).isSimulationSuccess = jest.fn().mockReturnValue(false);

    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const buildServer = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });
    const tx = await buildInvokeTransaction(buildServer, config, {
      contractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
      method: "increment",
    });

    await expect(simulateAndPrepare(server, tx, Networks.TESTNET)).rejects.toThrow(
      SimulationError,
    );

    (rpc.Api as any).isSimulationError = origIsError;
    (rpc.Api as any).isSimulationSuccess = origIsSuccess;
  });

  it("throws SimulationError when response is not success", async () => {
    const server = mockServer({
      simulateTransaction: jest.fn().mockResolvedValue({}),
    });

    const origIsError = rpc.Api.isSimulationError;
    const origIsSuccess = rpc.Api.isSimulationSuccess;
    (rpc.Api as any).isSimulationError = jest.fn().mockReturnValue(false);
    (rpc.Api as any).isSimulationSuccess = jest.fn().mockReturnValue(false);

    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const buildServer = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });
    const tx = await buildInvokeTransaction(buildServer, config, {
      contractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
      method: "increment",
    });

    await expect(simulateAndPrepare(server, tx, Networks.TESTNET)).rejects.toThrow(
      SimulationError,
    );

    (rpc.Api as any).isSimulationError = origIsError;
    (rpc.Api as any).isSimulationSuccess = origIsSuccess;
  });
});

describe("submitAndPoll", () => {
  it("throws SubmissionError when sendTransaction returns ERROR", async () => {
    const server = mockServer({
      sendTransaction: jest.fn().mockResolvedValue({
        status: "ERROR",
        errorResult: { toXDR: () => "AAAA" },
      }),
    });

    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const buildServer = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });
    const tx = await buildInvokeTransaction(buildServer, config, {
      contractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
      method: "increment",
    });

    await expect(submitAndPoll(server, tx)).rejects.toThrow(SubmissionError);
  });

  it("polls until SUCCESS", async () => {
    const server = mockServer({
      sendTransaction: jest.fn().mockResolvedValue({
        status: "PENDING",
        hash: "abc123",
      }),
      getTransaction: jest
        .fn()
        .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 12345,
          returnValue: null,
        }),
    });

    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const buildServer = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });
    const tx = await buildInvokeTransaction(buildServer, config, {
      contractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
      method: "increment",
    });

    const result = await submitAndPoll(server, tx);
    expect(result.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
  }, 15_000);
});

describe("addSignatureToTransaction", () => {
  it("adds a valid signature to the transaction", async () => {
    const kp = Keypair.random();
    const account = new Account(kp.publicKey(), "100");

    const { TransactionBuilder: TB, Networks: N } = await import("@stellar/stellar-sdk");
    const tx = new TB(account, {
      fee: "100",
      networkPassphrase: N.TESTNET,
    })
      .addOperation(
        (await import("@stellar/stellar-sdk")).Operation.manageData({
          name: "test",
          value: "test",
        }),
      )
      .setTimeout(30)
      .build();

    // Create a real signature
    const hash = tx.hash();
    const sig = kp.sign(hash);
    const sigHex = sig.toString("hex");

    const signedTx = addSignatureToTransaction(tx, kp.publicKey(), sigHex, N.TESTNET);
    expect(signedTx.signatures).toHaveLength(1);
  });
});

describe("buildConfigureIssuerTransaction", () => {
  it("builds a setOptions transaction with setFlags", async () => {
    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    const tx = await buildConfigureIssuerTransaction(server, config, {});

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.source).toBe(kp.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("setOptions");
  });
});

describe("buildAddIssuerSignerTransaction", () => {
  it("adds ONLY a signer — master weight, thresholds, and flags untouched", async () => {
    const kp = Keypair.random();
    const signerKp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    const tx = await buildAddIssuerSignerTransaction(server, config, {
      signerPublicKey: signerKp.publicKey(),
    });

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.source).toBe(kp.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("setOptions");

    const op = tx.operations[0] as Operation.SetOptions;
    // Adds the new signer at the default weight 1 ...
    expect(op.signer).toEqual({ ed25519PublicKey: signerKp.publicKey(), weight: 1 });
    // ... and THIS op sets no other field, so building "add a signer" can never
    // also mutate the master weight, thresholds, or auth flags in the same tx.
    // (A guard on what this transaction changes — NOT a limit on the signer:
    // with thresholds at 0 the new weight-1 signer can later do anything,
    // renounce included.) This is the load-bearing safety property.
    expect(op.masterWeight).toBeUndefined();
    expect(op.lowThreshold).toBeUndefined();
    expect(op.medThreshold).toBeUndefined();
    expect(op.highThreshold).toBeUndefined();
    expect(op.setFlags).toBeUndefined();
    expect(op.clearFlags).toBeUndefined();
  });

  it("honors an explicit signer weight", async () => {
    const kp = Keypair.random();
    const signerKp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    const tx = await buildAddIssuerSignerTransaction(server, config, {
      signerPublicKey: signerKp.publicKey(),
      weight: 10,
    });

    const op = tx.operations[0] as Operation.SetOptions;
    expect(op.signer).toEqual({ ed25519PublicKey: signerKp.publicKey(), weight: 10 });
  });

  it("rejects adding the issuer's own master key as a signer", async () => {
    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    await expect(
      buildAddIssuerSignerTransaction(server, config, { signerPublicKey: kp.publicKey() }),
    ).rejects.toThrow(/master key/);
  });

  it("rejects an out-of-range weight", async () => {
    const kp = Keypair.random();
    const signerKp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    await expect(
      buildAddIssuerSignerTransaction(server, config, {
        signerPublicKey: signerKp.publicKey(),
        weight: 256,
      }),
    ).rejects.toThrow(/weight/);
  });
});

describe("buildDeploySacTransaction", () => {
  it("builds a createStellarAssetContract transaction", async () => {
    const kp = Keypair.random();
    const issuerKp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    const tx = await buildDeploySacTransaction(server, config, {
      assetCode: "TMGUSD",
      assetIssuer: issuerKp.publicKey(),
    });

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.source).toBe(kp.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });
});

describe("buildUploadWasmTransaction", () => {
  it("builds an uploadContractWasm transaction", async () => {
    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d]); // minimal WASM header

    const tx = await buildUploadWasmTransaction(server, config, { wasm });

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.source).toBe(kp.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });
});

describe("buildDeployContractTransaction", () => {
  it("builds a createCustomContract transaction", async () => {
    const kp = Keypair.random();
    const config = makeConfig({ sourcePublicKey: kp.publicKey() });
    const server = mockServer({
      getAccount: jest.fn().mockResolvedValue(new Account(kp.publicKey(), "100")),
    });

    const wasmHash = Buffer.alloc(32, 0xab);

    const tx = await buildDeployContractTransaction(server, config, { wasmHash });

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.source).toBe(kp.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });
});
