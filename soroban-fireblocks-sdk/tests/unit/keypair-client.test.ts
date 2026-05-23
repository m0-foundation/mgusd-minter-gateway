import { Address, Keypair, Networks, rpc, xdr } from "@stellar/stellar-sdk";

jest.mock("../../src/soroban-tx-builder");
import * as txBuilder from "../../src/soroban-tx-builder";
import { SorobanKeypairClient } from "../../src/keypair-client";
import { WasmHashMismatchError } from "../../src/errors";

const mockedTxBuilder = txBuilder as jest.Mocked<typeof txBuilder>;

function makeMockTx() {
  return {
    hash: jest.fn().mockReturnValue(Buffer.from("a".repeat(64), "hex")),
    source: "GDEPL",
    operations: [],
    signatures: [],
    addSignature: jest.fn(),
    sign: jest.fn(),
    toEnvelope: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue("FAKE_XDR_B64") }),
  };
}

describe("SorobanKeypairClient", () => {
  const keypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockedTxBuilder.createRpcServer.mockReturnValue({} as rpc.Server);
  });

  describe("deploySac", () => {
    it("builds, locally signs with the keypair, submits, and returns the SAC contract ID", async () => {
      const mockTx = makeMockTx();
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);

      const sacContractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 100,
        returnValue: new Address(sacContractId).toScVal(),
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      const client = new SorobanKeypairClient({
        sorobanRpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase: Networks.TESTNET,
        keypair,
      });

      const result = await client.deploySac({
        assetCode: "TMGUSD",
        assetIssuer: "GISSUER".padEnd(56, "A"),
      });

      expect(result.status).toBe("SUCCESS");
      expect(result.sacContractId).toBe(sacContractId);
      // The keypair signs locally — no Fireblocks involved.
      expect(mockTx.sign).toHaveBeenCalledWith(keypair);
    });

    it("returns FAILED status when the network rejects the tx", async () => {
      const mockTx = makeMockTx();
      mockedTxBuilder.buildDeploySacTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 100,
      } as unknown as rpc.Api.GetFailedTransactionResponse);

      const client = new SorobanKeypairClient({
        sorobanRpcUrl: "x",
        networkPassphrase: Networks.TESTNET,
        keypair,
      });

      const result = await client.deploySac({ assetCode: "X", assetIssuer: "GX".padEnd(56, "A") });
      expect(result.status).toBe("FAILED");
      expect(result.sacContractId).toBeUndefined();
    });
  });

  describe("uploadWasm", () => {
    it("rejects an RPC-returned hash that disagrees with sha256(params.wasm)", async () => {
      const mockTx = makeMockTx();
      mockedTxBuilder.buildUploadWasmTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);

      // RPC returns a hash that's not sha256 of our wasm bytes
      const attackerHash = Buffer.alloc(32, 0xab);
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 100,
        returnValue: xdr.ScVal.scvBytes(attackerHash),
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      const client = new SorobanKeypairClient({
        sorobanRpcUrl: "x",
        networkPassphrase: Networks.TESTNET,
        keypair,
      });

      await expect(
        client.uploadWasm({ wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]) }),
      ).rejects.toBeInstanceOf(WasmHashMismatchError);
    });
  });

  describe("deployContract", () => {
    it("locally signs and returns the deployed contract ID on success", async () => {
      const mockTx = makeMockTx();
      mockedTxBuilder.buildDeployContractTransaction.mockResolvedValue(mockTx as never);
      mockedTxBuilder.simulateAndPrepare.mockResolvedValue(mockTx as never);

      const wrapperContractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      mockedTxBuilder.submitAndPoll.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 100,
        returnValue: new Address(wrapperContractId).toScVal(),
      } as unknown as rpc.Api.GetSuccessfulTransactionResponse);

      const client = new SorobanKeypairClient({
        sorobanRpcUrl: "x",
        networkPassphrase: Networks.TESTNET,
        keypair,
      });

      const result = await client.deployContract({ wasmHash: Buffer.alloc(32, 0x11) });
      expect(result.contractId).toBe(wrapperContractId);
      expect(mockTx.sign).toHaveBeenCalledWith(keypair);
    });
  });

  it("publicKey() returns the keypair's pubkey", () => {
    const client = new SorobanKeypairClient({
      sorobanRpcUrl: "x",
      networkPassphrase: Networks.TESTNET,
      keypair,
    });
    expect(client.publicKey()).toBe(keypair.publicKey());
  });
});
