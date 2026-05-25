import { createHash } from "crypto";
import { Address, Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import { SctokenFireblocksClient } from "../../src/sctoken-client";
import { WasmHashMismatchError } from "../../src/errors";
import { SorobanFireblocksConfig } from "../../src/types";

const TEST_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const TEST_WASM_SHA256 = createHash("sha256").update(TEST_WASM).digest();

// Mock all dependencies
jest.mock("../../src/soroban-tx-builder");
jest.mock("../../src/fireblocks-signer");
jest.mock("../../src/deploy-checks");

import * as txBuilder from "../../src/soroban-tx-builder";
import * as fbSigner from "../../src/fireblocks-signer";
import * as deployChecks from "../../src/deploy-checks";
import { IssuerContaminatedError } from "../../src/errors";

const mockedTxBuilder = txBuilder as jest.Mocked<typeof txBuilder>;
const mockedFbSigner = fbSigner as jest.Mocked<typeof fbSigner>;
const mockedDeployChecks = deployChecks as jest.Mocked<typeof deployChecks>;

const CONTRACT_ID = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";

function makeConfig(): SorobanFireblocksConfig {
  return {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    fireblocksApiKey: "key",
    fireblocksSecretKey: "secret",
    fireblocksVaultAccountId: "0",
    fireblocksAssetId: "XLM_TEST",
    sourcePublicKey: Keypair.random().publicKey(),
  };
}

let mockSimulateTransaction: jest.Mock;

function setupMocks(returnValue?: xdr.ScVal): void {
  const fakeHash = Buffer.from("a".repeat(64), "hex");
  const mockTx = {
    hash: jest.fn().mockReturnValue(fakeHash),
    source: "GABC",
    operations: [],
    signatures: [],
    addSignature: jest.fn(),
    sign: jest.fn(),
    toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
  };

  // Mock server with simulateTransaction for view functions
  mockSimulateTransaction = jest.fn().mockResolvedValue(
    returnValue
      ? { latestLedger: 100, minResourceFee: "0", transactionData: {}, result: { retval: returnValue, auth: [] }, events: [] }
      : { latestLedger: 100, minResourceFee: "0", transactionData: {}, result: undefined, events: [] },
  );
  mockedTxBuilder.createRpcServer.mockReturnValue({
    simulateTransaction: mockSimulateTransaction,
  } as never);

  mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);

  mockedTxBuilder.buildInvokeTransaction.mockResolvedValue(mockTx as never);
  mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
  mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
  mockedTxBuilder.submitAndPoll.mockResolvedValue({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    ledger: 100,
    returnValue,
  } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

  mockedFbSigner.signHash.mockResolvedValue({
    signatureHex: "b".repeat(128),
    fireblocksTransactionId: "fb-tx-001",
  });
}

describe("SctokenFireblocksClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: deployFull's step-0 contamination check passes. Individual
    // tests can override (see "deployFull aborts when issuer is contaminated").
    mockedDeployChecks.assertIssuerNotContaminated.mockResolvedValue(undefined);
  });

  describe("mint", () => {
    it("calls invokeContract with method 'mint' and correct args", async () => {
      setupMocks();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);
      const mintTo = Keypair.random().publicKey();

      const result = await client.mint({
        contractId: CONTRACT_ID,
        caller: config.sourcePublicKey,
        to: mintTo,
        amount: 1_000_000_000n,
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(100);

      // Verify buildInvokeTransaction was called with correct method and args
      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("mint");
      expect(params.args).toHaveLength(3);

      // Verify first arg is the caller Address ScVal
      const callerScVal = params.args![0];
      const decodedCaller = Address.fromScVal(callerScVal).toString();
      expect(decodedCaller).toBe(config.sourcePublicKey);

      // Verify second arg is the destination Address ScVal
      const addrScVal = params.args![1];
      const decodedAddr = Address.fromScVal(addrScVal).toString();
      expect(decodedAddr).toBe(mintTo);

      // Verify third arg is an i128 ScVal
      const amountScVal = params.args![2];
      expect(amountScVal.switch().name).toBe("scvI128");
    });
  });

  describe("burn", () => {
    it("calls invokeContract with method 'burn' and correct args", async () => {
      setupMocks();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.burn({
        contractId: CONTRACT_ID,
        caller: config.sourcePublicKey,
        from: config.sourcePublicKey,
        amount: 500_000_000n,
      });

      expect(result.status).toBe("SUCCESS");

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("burn");
      expect(params.args).toHaveLength(3);

      // Verify first arg is the caller Address ScVal
      const callerScVal = params.args![0];
      const decodedCaller = Address.fromScVal(callerScVal).toString();
      expect(decodedCaller).toBe(config.sourcePublicKey);

      // Verify second arg is the from Address ScVal
      const addrScVal = params.args![1];
      const decodedAddr = Address.fromScVal(addrScVal).toString();
      expect(decodedAddr).toBe(config.sourcePublicKey);

      // Verify third arg is an i128 ScVal
      const amountScVal = params.args![2];
      expect(amountScVal.switch().name).toBe("scvI128");
    });
  });

  describe("queryAdmin", () => {
    it("returns admin address via simulation", async () => {
      const adminKp = Keypair.random();
      const adminScVal = new Address(adminKp.publicKey()).toScVal();
      setupMocks(adminScVal);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const address = await client.queryAdmin({ contractId: CONTRACT_ID });

      expect(address).toBe(adminKp.publicKey());

      // Simulation was called, not submitAndPoll or signHash
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.submitAndPoll).not.toHaveBeenCalled();
      expect(mockedFbSigner.signHash).not.toHaveBeenCalled();

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      expect(buildCall[2].method).toBe("admin");
      expect(buildCall[2].args).toBeUndefined();
    });

    it("throws when simulation returns no value", async () => {
      setupMocks(undefined);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(client.queryAdmin({ contractId: CONTRACT_ID })).rejects.toThrow(
        "admin returned no value",
      );
    });
  });

  describe("querySacToken", () => {
    it("returns SAC contract address via simulation", async () => {
      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      setupMocks(sacScVal);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const address = await client.querySacToken({ contractId: CONTRACT_ID });

      expect(address).toBe(sacContractId);

      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.submitAndPoll).not.toHaveBeenCalled();
      expect(mockedFbSigner.signHash).not.toHaveBeenCalled();

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      expect(buildCall[2].method).toBe("sac_token");
      expect(buildCall[2].args).toBeUndefined();
    });

    it("throws when simulation returns no value", async () => {
      setupMocks(undefined);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(client.querySacToken({ contractId: CONTRACT_ID })).rejects.toThrow(
        "sac_token returned no value",
      );
    });
  });

  describe("setRate", () => {
    it("calls invokeContract with method 'set_rate' and correct args", async () => {
      setupMocks();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.setRate({
        contractId: CONTRACT_ID,
        caller: config.sourcePublicKey,
        rateBps: 500,
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(100);

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("set_rate");
      expect(params.args).toHaveLength(2);

      // Verify first arg is the caller Address ScVal
      const callerScVal = params.args![0];
      const decodedCaller = Address.fromScVal(callerScVal).toString();
      expect(decodedCaller).toBe(config.sourcePublicKey);

      // Verify second arg is a u32 ScVal
      const rateScVal = params.args![1];
      expect(rateScVal.switch().name).toBe("scvU32");
    });
  });

  describe("setMinter", () => {
    it("calls invokeContract with method 'set_minter' and correct args", async () => {
      setupMocks();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);
      const newMinter = Keypair.random().publicKey();

      const result = await client.setMinter({
        contractId: CONTRACT_ID,
        newMinter,
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(100);

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("set_minter");
      expect(params.args).toHaveLength(1);

      // Verify arg is the new minter Address ScVal
      const minterScVal = params.args![0];
      const decodedMinter = Address.fromScVal(minterScVal).toString();
      expect(decodedMinter).toBe(newMinter);
    });
  });

  describe("setAdmin", () => {
    it("calls invokeContract with method 'set_admin' and the new admin Address arg", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());
      const newAdmin = Keypair.random().publicKey();

      const result = await client.setAdmin({ contractId: CONTRACT_ID, newAdmin });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("set_admin");
      expect(params.args).toHaveLength(1);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(newAdmin);
    });
  });

  describe("setYieldRecipientManager", () => {
    it("calls invokeContract with method 'set_yield_recipient_manager' and the new manager Address arg", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());
      const newYieldRecipientManager = Keypair.random().publicKey();

      const result = await client.setYieldRecipientManager({
        contractId: CONTRACT_ID,
        newYieldRecipientManager,
      });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("set_yield_recipient_manager");
      expect(params.args).toHaveLength(1);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(newYieldRecipientManager);
    });
  });

  describe("setForcedTransferManager", () => {
    it("calls invokeContract with method 'set_forced_transfer_manager' and the new manager Address arg", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());
      const newForcedTransferManager = Keypair.random().publicKey();

      const result = await client.setForcedTransferManager({
        contractId: CONTRACT_ID,
        newForcedTransferManager,
      });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("set_forced_transfer_manager");
      expect(params.args).toHaveLength(1);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(newForcedTransferManager);
    });
  });

  describe("setPauser", () => {
    it("calls invokeContract with method 'set_pauser' and the new pauser Address arg", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());
      const newPauser = Keypair.random().publicKey();

      const result = await client.setPauser({ contractId: CONTRACT_ID, newPauser });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("set_pauser");
      expect(params.args).toHaveLength(1);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(newPauser);
    });
  });

  describe("setYieldRecipient", () => {
    it("calls invokeContract with method 'set_yield_recipient' and caller + new recipient Address args", async () => {
      setupMocks();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);
      const newYieldRecipient = Keypair.random().publicKey();

      const result = await client.setYieldRecipient({
        contractId: CONTRACT_ID,
        caller: config.sourcePublicKey,
        newYieldRecipient,
      });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("set_yield_recipient");
      expect(params.args).toHaveLength(2);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(config.sourcePublicKey);
      expect(Address.fromScVal(params.args![1]).toString()).toBe(newYieldRecipient);
    });
  });

  describe("transferSacAdmin", () => {
    it("calls invokeContract with method 'transfer_sac_admin' and the new SAC admin Address arg", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());
      const newSacAdmin = Keypair.random().publicKey();

      const result = await client.transferSacAdmin({ contractId: CONTRACT_ID, newSacAdmin });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("transfer_sac_admin");
      expect(params.args).toHaveLength(1);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(newSacAdmin);
    });
  });

  describe("upgrade", () => {
    it("calls invokeContract with method 'upgrade' and a 32-byte scvBytes arg (Buffer input)", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());
      const newWasmHash = Buffer.alloc(32, 0xcd);

      const result = await client.upgrade({ contractId: CONTRACT_ID, newWasmHash });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("upgrade");
      expect(params.args).toHaveLength(1);
      expect(params.args![0].switch().name).toBe("scvBytes");
      expect(Buffer.from(params.args![0].bytes()).equals(newWasmHash)).toBe(true);
    });

    it("accepts a 64-char hex string and encodes it as 32-byte scvBytes", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());
      const hex = "cd".repeat(32);

      await client.upgrade({ contractId: CONTRACT_ID, newWasmHash: hex });

      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("upgrade");
      expect(params.args![0].bytes().length).toBe(32);
      expect(Buffer.from(params.args![0].bytes()).toString("hex")).toBe(hex);
    });

    it("rejects a buffer that is not 32 bytes (before building tx)", async () => {
      setupMocks();
      const client = new SctokenFireblocksClient(makeConfig());

      await expect(
        client.upgrade({ contractId: CONTRACT_ID, newWasmHash: Buffer.alloc(31, 0xcd) }),
      ).rejects.toThrow(/32-byte/i);

      // No transaction should have been built or signed
      expect(mockedTxBuilder.buildInvokeTransaction).not.toHaveBeenCalled();
      expect(mockedFbSigner.signHash).not.toHaveBeenCalled();
    });
  });

  describe("pause", () => {
    it("calls invokeContract with method 'pause' and the caller Address arg", async () => {
      setupMocks();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.pause({ contractId: CONTRACT_ID, caller: config.sourcePublicKey });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("pause");
      expect(params.args).toHaveLength(1);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(config.sourcePublicKey);
    });
  });

  describe("unpause", () => {
    it("calls invokeContract with method 'unpause' and the caller Address arg", async () => {
      setupMocks();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.unpause({ contractId: CONTRACT_ID, caller: config.sourcePublicKey });

      expect(result.status).toBe("SUCCESS");
      const params = mockedTxBuilder.buildInvokeTransaction.mock.calls[0][2];
      expect(params.method).toBe("unpause");
      expect(params.args).toHaveLength(1);
      expect(Address.fromScVal(params.args![0]).toString()).toBe(config.sourcePublicKey);
    });
  });

  describe("queryPaused", () => {
    it("returns the paused boolean via simulation", async () => {
      const pausedScVal = xdr.ScVal.scvBool(true);
      setupMocks(pausedScVal);

      const client = new SctokenFireblocksClient(makeConfig());

      const result = await client.queryPaused({ contractId: CONTRACT_ID });

      expect(result).toBe(true);
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.submitAndPoll).not.toHaveBeenCalled();
      expect(mockedFbSigner.signHash).not.toHaveBeenCalled();

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      expect(buildCall[2].method).toBe("paused");
      expect(buildCall[2].args).toBeUndefined();
    });

    it("throws when simulation returns no value", async () => {
      setupMocks(undefined);
      const client = new SctokenFireblocksClient(makeConfig());

      await expect(client.queryPaused({ contractId: CONTRACT_ID })).rejects.toThrow(
        "paused returned no value",
      );
    });
  });

  describe("queryPauser", () => {
    it("returns the pauser address via simulation", async () => {
      const pauserKp = Keypair.random();
      const pauserScVal = new Address(pauserKp.publicKey()).toScVal();
      setupMocks(pauserScVal);

      const client = new SctokenFireblocksClient(makeConfig());

      const address = await client.queryPauser({ contractId: CONTRACT_ID });

      expect(address).toBe(pauserKp.publicKey());
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.submitAndPoll).not.toHaveBeenCalled();
      expect(mockedFbSigner.signHash).not.toHaveBeenCalled();

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      expect(buildCall[2].method).toBe("pauser");
      expect(buildCall[2].args).toBeUndefined();
    });

    it("throws when simulation returns no value", async () => {
      setupMocks(undefined);
      const client = new SctokenFireblocksClient(makeConfig());

      await expect(client.queryPauser({ contractId: CONTRACT_ID })).rejects.toThrow(
        "pauser returned no value",
      );
    });
  });

  describe("deployFull", () => {
    it("orchestrates the full 5-step deploy pipeline", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
        sign: jest.fn(),
        toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      const wasmHashBytes = TEST_WASM_SHA256;
      const wasmReturnValue = xdr.ScVal.scvBytes(wasmHashBytes);
      const wrapperContractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      const wrapperScVal = new Address(wrapperContractId).toScVal();

      mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
      mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);

      // Step 1: configureIssuer (classic — no simulate)
      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      // Step 2: deploySac (soroban — simulate)
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      // Step 3: uploadWasm (soroban — simulate)
      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      // Step 4: deployContract (soroban — simulate)
      mockedTxBuilder.buildDeployContractTransaction.mockResolvedValue(mockTx as never);
      // Step 5: invokeContract → set_admin (soroban — simulate)
      mockedTxBuilder.buildInvokeTransaction.mockResolvedValue(mockTx as never);

      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);

      // Submit returns different results for each step
      mockedTxBuilder.submitAndPoll
        .mockResolvedValueOnce({
          // Step 1: configureIssuer SUCCESS
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 10,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          // Step 2: deploySac SUCCESS with SAC contract ID
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 11,
          returnValue: sacScVal,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          // Step 3: uploadWasm SUCCESS with wasm hash
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 12,
          returnValue: wasmReturnValue,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          // Step 4: deployContract SUCCESS with contract ID
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 13,
          returnValue: wrapperScVal,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          // Step 5: set_admin SUCCESS
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 14,
          returnValue: undefined,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-100",
      });

      // Suppress console.log during test
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      // Post-deploy smoke test calls queryAdmin → simulateView. Short-circuit
      // it here so we don't have to fake out the server's simulateTransaction
      // mock; the smoke test's only assertion is that the returned pubkey
      // equals the admin we passed into the constructor.
      const queryAdminSpy = jest
        .spyOn(SctokenFireblocksClient.prototype, "queryAdmin")
        .mockResolvedValue(config.sourcePublicKey);

      const customIssuer = Keypair.random().publicKey();
      const result = await client.deployFull({
        assetCode: "TMGUSD",
        assetIssuer: customIssuer,
        wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
        admin: config.sourcePublicKey,
        minter: config.sourcePublicKey,
        yieldRecipientManager: config.sourcePublicKey,
        yieldRecipient: config.sourcePublicKey,
        forcedTransferManager: config.sourcePublicKey,
        blockOperator: config.sourcePublicKey,
        unblockOperator: config.sourcePublicKey,
        pauser: config.sourcePublicKey,
        deployerKeypair: Keypair.random(),
      });

      expect(result.sacContractId).toBe(sacContractId);
      expect(result.wasmHash).toBe(wasmHashBytes.toString("hex"));
      expect(result.wrapperContractId).toBe(wrapperContractId);

      // Verify all 5 steps were called (each via its own tx-builder helper)
      expect(mockedTxBuilder.buildConfigureIssuerTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.buildDeploySacTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.buildUploadWasmTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.buildDeployContractTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.buildInvokeTransaction).toHaveBeenCalledTimes(1);

      // Verify deploySac received the explicit issuer (not config.sourcePublicKey)
      const deploySacCall = mockedTxBuilder.buildDeploySacTransaction.mock.calls[0];
      expect(deploySacCall[2]).toEqual({
        assetCode: "TMGUSD",
        assetIssuer: customIssuer,
      });

      // Split signing: issuer Fireblocks vault signs steps 1 + 5 only.
      // Steps 2, 3, 4 are signed locally by the deployer Keypair (no Fireblocks
      // round-trip), so signHash drops from 5 → 2.
      expect(mockedFbSigner.signHash).toHaveBeenCalledTimes(2);
      // All 5 deploy steps still submit through the same RPC helper.
      expect(mockedTxBuilder.submitAndPoll).toHaveBeenCalledTimes(5);
      // Smoke test invoked queryAdmin against the freshly-deployed wrapper.
      expect(queryAdminSpy).toHaveBeenCalledWith({ contractId: wrapperContractId });

      consoleSpy.mockRestore();
      queryAdminSpy.mockRestore();
    });

    it("aborts at step 0 when issuer is contaminated, never touching tx-builder helpers", async () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      mockedDeployChecks.assertIssuerNotContaminated.mockRejectedValue(
        new IssuerContaminatedError(
          "Issuer GISSUER... has prior on-chain footprint for asset TMGUSD",
          "TMGUSD",
          "GISSUER...",
          { trustlines: 1, claimableBalances: 0, liquidityPools: 0, contracts: 0 },
        ),
      );

      await expect(
        client.deployFull({
          assetCode: "TMGUSD",
          assetIssuer: "GISSUER...",
          wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          blockOperator: config.sourcePublicKey,
          unblockOperator: config.sourcePublicKey,
          pauser: config.sourcePublicKey,
          deployerKeypair: Keypair.random(),
        }),
      ).rejects.toBeInstanceOf(IssuerContaminatedError);

      // Critical: STEL1-6 mitigation must abort *before* any state-mutating
      // step runs. configureIssuer / deploySac / uploadWasm / deployContract /
      // set_admin must all be untouched.
      expect(mockedDeployChecks.assertIssuerNotContaminated).toHaveBeenCalledWith(
        expect.anything(),
        "TMGUSD",
        "GISSUER...",
      );
      expect(mockedTxBuilder.buildConfigureIssuerTransaction).not.toHaveBeenCalled();
      expect(mockedTxBuilder.buildDeploySacTransaction).not.toHaveBeenCalled();
      expect(mockedTxBuilder.buildUploadWasmTransaction).not.toHaveBeenCalled();
      expect(mockedTxBuilder.buildDeployContractTransaction).not.toHaveBeenCalled();
      expect(mockedTxBuilder.buildInvokeTransaction).not.toHaveBeenCalled();
      expect(mockedFbSigner.signHash).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("throws when configureIssuer fails", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
        sign: jest.fn(),
        toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
      };

      mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
      mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);
      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 10,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-101",
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(
        client.deployFull({
          assetCode: "TMGUSD",
          assetIssuer: config.sourcePublicKey,
          wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          blockOperator: config.sourcePublicKey,
          unblockOperator: config.sourcePublicKey,
          pauser: config.sourcePublicKey,
          deployerKeypair: Keypair.random(),
        }),
      ).rejects.toThrow("configureIssuer failed");

      consoleSpy.mockRestore();
    });

    it("throws when deploySac fails (step 2)", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
        sign: jest.fn(),
        toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
      };

      mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
      mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);
      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);

      mockedTxBuilder.submitAndPoll
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 10,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.FAILED,
          ledger: 11,
        } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-102",
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(
        client.deployFull({
          assetCode: "TMGUSD",
          assetIssuer: config.sourcePublicKey,
          wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          blockOperator: config.sourcePublicKey,
          unblockOperator: config.sourcePublicKey,
          pauser: config.sourcePublicKey,
          deployerKeypair: Keypair.random(),
        }),
      ).rejects.toThrow("deploySac failed");

      consoleSpy.mockRestore();
    });

    it("throws WasmHashMismatchError before signing the deploy tx when RPC-returned hash diverges from sha256(params.wasm)", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
        sign: jest.fn(),
        toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      const attackerHashBytes = Buffer.alloc(32, 0xab); // not sha256(TEST_WASM)
      const spoofedReturnValue = xdr.ScVal.scvBytes(attackerHashBytes);

      mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
      mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);
      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeployContractTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildInvokeTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);

      mockedTxBuilder.submitAndPoll
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 10,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 11,
          returnValue: sacScVal,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          // Step 3: malicious RPC returns a hash that does NOT match sha256(TEST_WASM)
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 12,
          returnValue: spoofedReturnValue,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-spoof",
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(
        client.deployFull({
          assetCode: "TMGUSD",
          assetIssuer: config.sourcePublicKey,
          wasm: TEST_WASM,
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          blockOperator: config.sourcePublicKey,
          unblockOperator: config.sourcePublicKey,
          pauser: config.sourcePublicKey,
          deployerKeypair: Keypair.random(),
        }),
      ).rejects.toBeInstanceOf(WasmHashMismatchError);

      // Critical: the deploy and set_admin txs were never built or signed.
      // Under split signing, only step 1 (configureIssuer) goes through
      // Fireblocks — steps 2 + 3 are signed locally by the deployer Keypair —
      // so signHash is exactly 1. The upload (step 3) submitted via the
      // shared submitAndPoll helper but never touched signHash.
      expect(mockedTxBuilder.buildDeployContractTransaction).not.toHaveBeenCalled();
      expect(mockedTxBuilder.buildInvokeTransaction).not.toHaveBeenCalled();
      expect(mockedFbSigner.signHash).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });

    it("throws when uploadWasm fails (step 3)", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
        sign: jest.fn(),
        toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();

      mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
      mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);
      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);

      mockedTxBuilder.submitAndPoll
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 10,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 11,
          returnValue: sacScVal,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.FAILED,
          ledger: 12,
        } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-103",
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(
        client.deployFull({
          assetCode: "TMGUSD",
          assetIssuer: config.sourcePublicKey,
          wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          blockOperator: config.sourcePublicKey,
          unblockOperator: config.sourcePublicKey,
          pauser: config.sourcePublicKey,
          deployerKeypair: Keypair.random(),
        }),
      ).rejects.toThrow("uploadWasm failed");

      consoleSpy.mockRestore();
    });

    it("throws when deployContract fails (step 4)", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
        sign: jest.fn(),
        toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      const wasmHashBytes = TEST_WASM_SHA256;
      const wasmReturnValue = xdr.ScVal.scvBytes(wasmHashBytes);

      mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
      mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);
      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeployContractTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);

      mockedTxBuilder.submitAndPoll
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 10,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 11,
          returnValue: sacScVal,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 12,
          returnValue: wasmReturnValue,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.FAILED,
          ledger: 13,
        } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-104",
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(
        client.deployFull({
          assetCode: "TMGUSD",
          assetIssuer: config.sourcePublicKey,
          wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          blockOperator: config.sourcePublicKey,
          unblockOperator: config.sourcePublicKey,
          pauser: config.sourcePublicKey,
          deployerKeypair: Keypair.random(),
        }),
      ).rejects.toThrow("deployContract failed");

      consoleSpy.mockRestore();
    });

    it("throws when set_admin fails (step 5)", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
        sign: jest.fn(),
        toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      const wasmHashBytes = TEST_WASM_SHA256;
      const wasmReturnValue = xdr.ScVal.scvBytes(wasmHashBytes);
      const wrapperContractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      const wrapperScVal = new Address(wrapperContractId).toScVal();

      mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
      mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);
      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildDeployContractTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.buildInvokeTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);

      mockedTxBuilder.submitAndPoll
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 10,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 11,
          returnValue: sacScVal,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 12,
          returnValue: wasmReturnValue,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 13,
          returnValue: wrapperScVal,
        } as unknown as rpc.Api.GetSuccessfulTransactionResponse)
        .mockResolvedValueOnce({
          status: rpc.Api.GetTransactionStatus.FAILED,
          ledger: 14,
        } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-105",
      });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();
      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(
        client.deployFull({
          assetCode: "TMGUSD",
          assetIssuer: config.sourcePublicKey,
          wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          blockOperator: config.sourcePublicKey,
          unblockOperator: config.sourcePublicKey,
          pauser: config.sourcePublicKey,
          deployerKeypair: Keypair.random(),
        }),
      ).rejects.toThrow("set_admin failed");

      consoleSpy.mockRestore();
    });
  });
});
