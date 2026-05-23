// Local-keypair signing for the protocol-permissionless deploy ops
// (SAC deploy, WASM upload, contract create). Mirrors the DEPLOYER identity
// in scripts/deploy-pipeline.sh. Intentionally narrow — issuer-authority ops
// (configureIssuer, set_admin) go through the Fireblocks client.

import { createHash } from "crypto";
import { Address, Keypair, rpc } from "@stellar/stellar-sdk";
import { WasmHashMismatchError } from "./errors";
import {
  buildDeployContractTransaction,
  buildDeploySacTransaction,
  buildUploadWasmTransaction,
  createRpcServer,
  simulateAndPrepare,
  submitAndPoll,
} from "./soroban-tx-builder";
import {
  DeployContractParams,
  DeployContractResult,
  DeploySacParams,
  DeploySacResult,
  UploadWasmParams,
  UploadWasmResult,
} from "./types";

export interface SorobanKeypairConfig {
  sorobanRpcUrl: string;
  networkPassphrase: string;
  keypair: Keypair;
}

export class SorobanKeypairClient {
  private readonly server: rpc.Server;
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly txBuilderConfig: { sourcePublicKey: string; networkPassphrase: string };

  constructor(config: SorobanKeypairConfig) {
    this.server = createRpcServer(config.sorobanRpcUrl);
    this.keypair = config.keypair;
    this.networkPassphrase = config.networkPassphrase;
    this.txBuilderConfig = {
      sourcePublicKey: config.keypair.publicKey(),
      networkPassphrase: config.networkPassphrase,
    };
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  async deploySac(params: DeploySacParams): Promise<DeploySacResult> {
    const rawTx = await buildDeploySacTransaction(this.server, this.txBuilderConfig, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.networkPassphrase);
    preparedTx.sign(this.keypair);

    const result = await submitAndPoll(this.server, preparedTx);
    const txHash = preparedTx.hash().toString("hex");

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successResult = result as rpc.Api.GetSuccessfulTransactionResponse;
      let sacContractId: string | undefined;
      if (successResult.returnValue) {
        sacContractId = Address.fromScVal(successResult.returnValue).toString();
      }
      return { txHash, status: "SUCCESS", sacContractId, ledger: successResult.ledger };
    }

    return { txHash, status: "FAILED", ledger: result.ledger };
  }

  async uploadWasm(params: UploadWasmParams): Promise<UploadWasmResult> {
    // Local-hash defense-in-depth: refuse a spoofed RPC-returned hash that doesn't match params.wasm.
    const expectedWasmHash = createHash("sha256").update(params.wasm).digest("hex");

    const rawTx = await buildUploadWasmTransaction(this.server, this.txBuilderConfig, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.networkPassphrase);
    preparedTx.sign(this.keypair);

    const result = await submitAndPoll(this.server, preparedTx);
    const txHash = preparedTx.hash().toString("hex");

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successResult = result as rpc.Api.GetSuccessfulTransactionResponse;
      const actualWasmHash = successResult.returnValue
        ? successResult.returnValue.bytes().toString("hex")
        : undefined;

      if (actualWasmHash !== expectedWasmHash) {
        throw new WasmHashMismatchError(
          `uploadWasm hash mismatch: expected sha256(params.wasm)=${expectedWasmHash}, RPC returned ${actualWasmHash ?? "no returnValue"}`,
          expectedWasmHash,
          actualWasmHash,
          txHash,
        );
      }

      return { txHash, status: "SUCCESS", wasmHash: expectedWasmHash, ledger: successResult.ledger };
    }

    return { txHash, status: "FAILED", ledger: result.ledger };
  }

  async deployContract(params: DeployContractParams): Promise<DeployContractResult> {
    const rawTx = await buildDeployContractTransaction(this.server, this.txBuilderConfig, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.networkPassphrase);
    preparedTx.sign(this.keypair);

    const result = await submitAndPoll(this.server, preparedTx);
    const txHash = preparedTx.hash().toString("hex");

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successResult = result as rpc.Api.GetSuccessfulTransactionResponse;
      let contractId: string | undefined;
      if (successResult.returnValue) {
        contractId = Address.fromScVal(successResult.returnValue).toString();
      }
      return { txHash, status: "SUCCESS", contractId, ledger: successResult.ledger };
    }

    return { txHash, status: "FAILED", ledger: result.ledger };
  }
}
