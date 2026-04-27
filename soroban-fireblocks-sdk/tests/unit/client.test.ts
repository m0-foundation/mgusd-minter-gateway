import { createHash } from "crypto";
import { Address, Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";
import { SorobanFireblocksClient } from "../../src/client";
import { WasmHashMismatchError } from "../../src/errors";
import { SorobanFireblocksConfig } from "../../src/types";

// Mock all dependencies
jest.mock("../../src/soroban-tx-builder");
jest.mock("../../src/fireblocks-signer");

import * as txBuilder from "../../src/soroban-tx-builder";
import * as fbSigner from "../../src/fireblocks-signer";

const mockedTxBuilder = txBuilder as jest.Mocked<typeof txBuilder>;
const mockedFbSigner = fbSigner as jest.Mocked<typeof fbSigner>;

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

describe("SorobanFireblocksClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
    mockedFbSigner.createFireblocksClient.mockReturnValue({} as never);
  });

  describe("invokeContract", () => {
    it("orchestrates the full pipeline and returns SUCCESS", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildInvokeTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 42,
        returnValue: undefined,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-001",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.invokeContract({
        contractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
        method: "increment",
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(42);

      expect(mockedTxBuilder.buildInvokeTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.simulateAndPrepare).toHaveBeenCalledTimes(1);
      expect(mockedFbSigner.signHash).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.addSignatureToTransaction).toHaveBeenCalledTimes(1);
      expect(mockedTxBuilder.submitAndPoll).toHaveBeenCalledTimes(1);
    });

    it("returns FAILED status when transaction fails", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildInvokeTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 43,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "c".repeat(128),
        fireblocksTransactionId: "fb-tx-002",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.invokeContract({
        contractId: "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW",
        method: "increment",
      });

      expect(result.status).toBe("FAILED");
      expect(result.ledger).toBe(43);
    });
  });

  describe("setupTrustline", () => {
    it("orchestrates classic changeTrust pipeline and returns SUCCESS", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildChangeTrustTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 45,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-005",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.setupTrustline({
        assetCode: "TMGUSD",
        assetIssuer: Keypair.random().publicKey(),
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(45);
      expect(mockedTxBuilder.buildChangeTrustTransaction).toHaveBeenCalledTimes(1);
      // No simulation for classic ops
      expect(mockedTxBuilder.simulateAndPrepare).not.toHaveBeenCalled();
    });

    it("returns FAILED status on failure", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildChangeTrustTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 46,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "c".repeat(128),
        fireblocksTransactionId: "fb-tx-006",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.setupTrustline({
        assetCode: "TMGUSD",
        assetIssuer: Keypair.random().publicKey(),
      });

      expect(result.status).toBe("FAILED");
      expect(result.ledger).toBe(46);
    });
  });

  describe("configureIssuer", () => {
    it("orchestrates classic setOptions pipeline and returns SUCCESS", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 50,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-010",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.configureIssuer();

      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(50);
      expect(mockedTxBuilder.buildConfigureIssuerTransaction).toHaveBeenCalledTimes(1);
      // No simulation for classic ops
      expect(mockedTxBuilder.simulateAndPrepare).not.toHaveBeenCalled();
    });

    it("returns FAILED status on failure", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildConfigureIssuerTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 51,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "c".repeat(128),
        fireblocksTransactionId: "fb-tx-011",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.configureIssuer();

      expect(result.status).toBe("FAILED");
    });
  });

  describe("deploySac", () => {
    it("orchestrates Soroban deploy SAC pipeline and extracts contract ID", async () => {
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

      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 60,
        returnValue: sacScVal,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-020",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.deploySac({
        assetCode: "TMGUSD",
        assetIssuer: config.sourcePublicKey,
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.sacContractId).toBe(sacContractId);
      expect(result.ledger).toBe(60);
      expect(mockedTxBuilder.simulateAndPrepare).toHaveBeenCalledTimes(1);
    });
  });

  describe("deploySac - FAILED", () => {
    it("returns FAILED status when transaction fails", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 61,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "c".repeat(128),
        fireblocksTransactionId: "fb-tx-021",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.deploySac({
        assetCode: "TMGUSD",
        assetIssuer: config.sourcePublicKey,
      });

      expect(result.status).toBe("FAILED");
      expect(result.sacContractId).toBeUndefined();
    });
  });

  describe("uploadWasm", () => {
    it("orchestrates Soroban upload WASM pipeline and returns the locally-derived sha256 hash", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      const localHashHex = createHash("sha256").update(wasm).digest("hex");
      const returnValue = xdr.ScVal.scvBytes(Buffer.from(localHashHex, "hex"));

      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 70,
        returnValue,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-030",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.uploadWasm({ wasm });

      expect(result.status).toBe("SUCCESS");
      expect(result.wasmHash).toBe(localHashHex);
      expect(result.ledger).toBe(70);
      expect(mockedTxBuilder.simulateAndPrepare).toHaveBeenCalledTimes(1);
    });

    it("throws WasmHashMismatchError when RPC returns a hash that differs from sha256(params.wasm)", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      const expectedHashHex = createHash("sha256").update(wasm).digest("hex");
      const attackerHashBytes = Buffer.alloc(32, 0xab);
      const spoofedReturnValue = xdr.ScVal.scvBytes(attackerHashBytes);

      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 70,
        returnValue: spoofedReturnValue,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-030",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      await expect(client.uploadWasm({ wasm })).rejects.toMatchObject({
        name: "WasmHashMismatchError",
        expectedHash: expectedHashHex,
        actualHash: attackerHashBytes.toString("hex"),
      });
      await expect(client.uploadWasm({ wasm })).rejects.toBeInstanceOf(WasmHashMismatchError);
    });

    it("throws WasmHashMismatchError when SUCCESS response is missing returnValue", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      const expectedHashHex = createHash("sha256").update(wasm).digest("hex");

      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 70,
        returnValue: undefined,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-030",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      await expect(client.uploadWasm({ wasm })).rejects.toMatchObject({
        name: "WasmHashMismatchError",
        expectedHash: expectedHashHex,
        actualHash: undefined,
      });
    });
  });

  describe("uploadWasm - FAILED", () => {
    it("returns FAILED status when transaction fails", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 71,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "c".repeat(128),
        fireblocksTransactionId: "fb-tx-031",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.uploadWasm({
        wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]),
      });

      expect(result.status).toBe("FAILED");
      expect(result.wasmHash).toBeUndefined();
    });
  });

  describe("deployContract", () => {
    it("orchestrates Soroban deploy contract pipeline and extracts contract ID", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      const contractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      const contractScVal = new Address(contractId).toScVal();

      mockedTxBuilder.buildDeployContractTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 80,
        returnValue: contractScVal,
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "b".repeat(128),
        fireblocksTransactionId: "fb-tx-040",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.deployContract({
        wasmHash: Buffer.alloc(32, 0xab),
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.contractId).toBe(contractId);
      expect(result.ledger).toBe(80);
      expect(mockedTxBuilder.simulateAndPrepare).toHaveBeenCalledTimes(1);
    });

    it("returns FAILED status when transaction fails", async () => {
      const fakeHash = Buffer.from("a".repeat(64), "hex");
      const mockTx = {
        hash: jest.fn().mockReturnValue(fakeHash),
        source: "GABC",
        operations: [],
        signatures: [],
        addSignature: jest.fn(),
      };

      mockedTxBuilder.buildDeployContractTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.addSignatureToTransaction.mockReturnValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 81,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      mockedFbSigner.signHash.mockResolvedValue({
        signatureHex: "c".repeat(128),
        fireblocksTransactionId: "fb-tx-041",
      });

      const config = makeConfig();
      const client = new SorobanFireblocksClient(config);

      const result = await client.deployContract({
        wasmHash: Buffer.alloc(32, 0xab),
      });

      expect(result.status).toBe("FAILED");
      expect(result.contractId).toBeUndefined();
    });
  });
});
