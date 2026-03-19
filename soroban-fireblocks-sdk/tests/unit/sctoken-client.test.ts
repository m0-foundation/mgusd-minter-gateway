import { Address, Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import { SctokenFireblocksClient } from "../../src/sctoken-client";
import { SorobanFireblocksConfig } from "../../src/types";

// Mock all dependencies
jest.mock("../../src/soroban-tx-builder");
jest.mock("../../src/fireblocks-signer");

import * as txBuilder from "../../src/soroban-tx-builder";
import * as fbSigner from "../../src/fireblocks-signer";

const mockedTxBuilder = txBuilder as jest.Mocked<typeof txBuilder>;
const mockedFbSigner = fbSigner as jest.Mocked<typeof fbSigner>;

const CONTRACT_ID = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";

function makeConfig(): SorobanFireblocksConfig {
  return {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    fireblocksApiKey: "key",
    fireblocksSecretKey: "secret",
    fireblocksVaultAccountId: "0",
    fireblocksAssetId: "XLM_TEST",
    sourcePublicKey: Keypair.random().publicKey(),
  };
}

function setupMocks(returnValue?: xdr.ScVal): void {
  const fakeHash = Buffer.from("a".repeat(64), "hex");
  const mockTx = {
    hash: jest.fn().mockReturnValue(fakeHash),
    source: "GABC",
    operations: [],
    signatures: [],
    addSignature: jest.fn(),
  };

  mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
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
    it("decodes returned Address from returnValue", async () => {
      const adminKp = Keypair.random();
      const adminScVal = new Address(adminKp.publicKey()).toScVal();
      setupMocks(adminScVal);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.queryAdmin({ contractId: CONTRACT_ID });

      expect(result.address).toBe(adminKp.publicKey());
      expect(result.txHash).toBeDefined();
      expect(result.ledger).toBe(100);

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("admin");
      expect(params.args).toBeUndefined();
    });

    it("throws when returnValue is undefined", async () => {
      setupMocks(undefined);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(client.queryAdmin({ contractId: CONTRACT_ID })).rejects.toThrow(
        "queryAdmin returned no value",
      );
    });
  });

  describe("querySacToken", () => {
    it("decodes returned Address from returnValue", async () => {
      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      setupMocks(sacScVal);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.querySacToken({ contractId: CONTRACT_ID });

      expect(result.address).toBe(sacContractId);
      expect(result.txHash).toBeDefined();
      expect(result.ledger).toBe(100);

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("sac_token");
      expect(params.args).toBeUndefined();
    });

    it("throws when returnValue is undefined", async () => {
      setupMocks(undefined);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(client.querySacToken({ contractId: CONTRACT_ID })).rejects.toThrow(
        "querySacToken returned no value",
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

  describe("reconcileBurn", () => {
    it("calls invokeContract with method 'reconcile_burn' and correct args", async () => {
      setupMocks();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);
      const collateralTo = Keypair.random().publicKey();

      const result = await client.reconcileBurn({
        contractId: CONTRACT_ID,
        amount: 500_000_000n,
        collateralTo,
      });

      expect(result.status).toBe("SUCCESS");

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("reconcile_burn");
      expect(params.args).toHaveLength(2);

      // Verify first arg is an i128 ScVal
      const amountScVal = params.args![0];
      expect(amountScVal.switch().name).toBe("scvI128");

      // Verify second arg is the collateralTo Address ScVal
      const addrScVal = params.args![1];
      const decodedAddr = Address.fromScVal(addrScVal).toString();
      expect(decodedAddr).toBe(collateralTo);
    });
  });

  describe("setCollateralToken", () => {
    it("calls invokeContract with method 'set_collateral_token' and correct args", async () => {
      setupMocks();

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);
      const collateralToken = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";

      const result = await client.setCollateralToken({
        contractId: CONTRACT_ID,
        collateralToken,
      });

      expect(result.status).toBe("SUCCESS");

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("set_collateral_token");
      expect(params.args).toHaveLength(1);

      const addrScVal = params.args![0];
      const decodedAddr = Address.fromScVal(addrScVal).toString();
      expect(decodedAddr).toBe(collateralToken);
    });
  });

  describe("queryCollateralToken", () => {
    it("decodes returned Address from returnValue", async () => {
      const collateralToken = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const colScVal = new Address(collateralToken).toScVal();
      setupMocks(colScVal);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.queryCollateralToken({ contractId: CONTRACT_ID });

      expect(result.address).toBe(collateralToken);
      expect(result.txHash).toBeDefined();
      expect(result.ledger).toBe(100);

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("collateral_token");
      expect(params.args).toBeUndefined();
    });

    it("throws when returnValue is undefined", async () => {
      setupMocks(undefined);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(client.queryCollateralToken({ contractId: CONTRACT_ID })).rejects.toThrow(
        "queryCollateralToken returned no value",
      );
    });
  });

  describe("queryCollateralBalance", () => {
    it("decodes returned i128 from returnValue", async () => {
      const { nativeToScVal } = require("@stellar/stellar-sdk");
      const balanceScVal = nativeToScVal(5_000_000_000n, { type: "i128" });
      setupMocks(balanceScVal);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.queryCollateralBalance({ contractId: CONTRACT_ID });

      expect(result.value).toBe(5_000_000_000n);
      expect(result.txHash).toBeDefined();
      expect(result.ledger).toBe(100);

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("collateral_balance");
      expect(params.args).toBeUndefined();
    });

    it("throws when returnValue is undefined", async () => {
      setupMocks(undefined);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(client.queryCollateralBalance({ contractId: CONTRACT_ID })).rejects.toThrow(
        "queryCollateralBalance returned no value",
      );
    });
  });

  describe("queryCollateralDeficit", () => {
    it("decodes returned i128 from returnValue", async () => {
      const { nativeToScVal } = require("@stellar/stellar-sdk");
      const deficitScVal = nativeToScVal(1_000_000n, { type: "i128" });
      setupMocks(deficitScVal);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      const result = await client.queryCollateralDeficit({ contractId: CONTRACT_ID });

      expect(result.value).toBe(1_000_000n);
      expect(result.txHash).toBeDefined();
      expect(result.ledger).toBe(100);

      const buildCall = mockedTxBuilder.buildInvokeTransaction.mock.calls[0];
      const params = buildCall[2];
      expect(params.method).toBe("collateral_deficit");
      expect(params.args).toBeUndefined();
    });

    it("throws when returnValue is undefined", async () => {
      setupMocks(undefined);

      const config = makeConfig();
      const client = new SctokenFireblocksClient(config);

      await expect(client.queryCollateralDeficit({ contractId: CONTRACT_ID })).rejects.toThrow(
        "queryCollateralDeficit returned no value",
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
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      const wasmHashBytes = Buffer.alloc(32, 0xab);
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

      const customIssuer = Keypair.random().publicKey();
      const collateralToken = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      const result = await client.deployFull({
        assetCode: "TMGUSD",
        assetIssuer: customIssuer,
        wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
        collateralToken,
        admin: config.sourcePublicKey,
        minter: config.sourcePublicKey,
        yieldRecipientManager: config.sourcePublicKey,
        yieldRecipient: config.sourcePublicKey,
        forcedTransferManager: config.sourcePublicKey,
        distributor: config.sourcePublicKey,
      });

      expect(result.sacContractId).toBe(sacContractId);
      expect(result.wasmHash).toBe(wasmHashBytes.toString("hex"));
      expect(result.wrapperContractId).toBe(wrapperContractId);

      // Verify all 5 steps were called
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

      // 5 total sign + submit calls
      expect(mockedFbSigner.signHash).toHaveBeenCalledTimes(5);
      expect(mockedTxBuilder.submitAndPoll).toHaveBeenCalledTimes(5);

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
          collateralToken: CONTRACT_ID,
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          distributor: config.sourcePublicKey,
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
          collateralToken: CONTRACT_ID,
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          distributor: config.sourcePublicKey,
        }),
      ).rejects.toThrow("deploySac failed");

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
          collateralToken: CONTRACT_ID,
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          distributor: config.sourcePublicKey,
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
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      const wasmHashBytes = Buffer.alloc(32, 0xab);
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
          collateralToken: CONTRACT_ID,
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          distributor: config.sourcePublicKey,
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
      };

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const sacScVal = new Address(sacContractId).toScVal();
      const wasmHashBytes = Buffer.alloc(32, 0xab);
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
          collateralToken: CONTRACT_ID,
          admin: config.sourcePublicKey,
          minter: config.sourcePublicKey,
          yieldRecipientManager: config.sourcePublicKey,
          yieldRecipient: config.sourcePublicKey,
          forcedTransferManager: config.sourcePublicKey,
          distributor: config.sourcePublicKey,
        }),
      ).rejects.toThrow("set_admin failed");

      consoleSpy.mockRestore();
    });
  });
});
