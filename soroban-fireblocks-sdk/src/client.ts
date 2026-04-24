import { Fireblocks } from "@fireblocks/ts-sdk";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { createFireblocksClient, signHash } from "./fireblocks-signer";
import { SimulationError } from "./errors";
import {
  addSignatureToTransaction,
  buildChangeTrustTransaction,
  buildConfigureIssuerTransaction,
  buildDeployContractTransaction,
  buildDeploySacTransaction,
  buildInvokeTransaction,
  buildUploadWasmTransaction,
  createRpcServer,
  simulateAndPrepare,
  submitAndPoll,
} from "./soroban-tx-builder";
import {
  ConfigureIssuerParams,
  ConfigureIssuerResult,
  DeployContractParams,
  DeployContractResult,
  DeploySacParams,
  DeploySacResult,
  InvokeContractParams,
  InvokeContractResult,
  SetupTrustlineParams,
  SetupTrustlineResult,
  SorobanFireblocksConfig,
  UploadWasmParams,
  UploadWasmResult,
} from "./types";

export class SorobanFireblocksClient {
  protected readonly server: rpc.Server;
  protected readonly fireblocks: Fireblocks;
  protected readonly config: SorobanFireblocksConfig;

  constructor(config: SorobanFireblocksConfig) {
    this.config = config;
    this.server = createRpcServer(config.sorobanRpcUrl);
    this.fireblocks = createFireblocksClient(config);
  }

  protected async simulateView(params: InvokeContractParams): Promise<xdr.ScVal | undefined> {
    const tx = await buildInvokeTransaction(this.server, this.config, params);
    const simResponse = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResponse)) {
      const errorMsg = "error" in simResponse ? String(simResponse.error) : "Unknown simulation error";
      throw new SimulationError(`View simulation failed: ${errorMsg}`);
    }

    if (!rpc.Api.isSimulationSuccess(simResponse)) {
      throw new SimulationError("View simulation did not return a success response");
    }

    return simResponse.result?.retval;
  }

  async invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    // 1. Build the invoke transaction
    const rawTx = await buildInvokeTransaction(this.server, this.config, params);

    // 2. Simulate and assemble (attaches resource fees + auth)
    const preparedTx = await simulateAndPrepare(
      this.server,
      rawTx,
      this.config.networkPassphrase,
    );

    // 3. Hash the assembled transaction (32-byte SHA-256)
    const txHash = preparedTx.hash();
    const hashHex = txHash.toString("hex");

    // 4. Sign hash via Fireblocks RAW (MPC_EDDSA_ED25519)
    const sigResult = await signHash(this.fireblocks, this.config, hashHex);

    // 5. Attach signature to transaction envelope
    const signedTx = addSignatureToTransaction(
      preparedTx,
      this.config.sourcePublicKey,
      sigResult.signatureHex,
      this.config.networkPassphrase,
    );

    // 6. Submit and poll until terminal
    const result = await submitAndPoll(this.server, signedTx);

    const txHashStr = preparedTx.hash().toString("hex");

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successResult = result as rpc.Api.GetSuccessfulTransactionResponse;
      return {
        txHash: txHashStr,
        status: "SUCCESS",
        returnValue: successResult.returnValue,
        ledger: successResult.ledger,
      };
    }

    return {
      txHash: txHashStr,
      status: "FAILED",
      ledger: result.ledger,
    };
  }

  async setupTrustline(params: SetupTrustlineParams): Promise<SetupTrustlineResult> {
    // 1. Build the changeTrust transaction (classic op — no simulation needed)
    const tx = await buildChangeTrustTransaction(this.server, this.config, params);

    // 2. Hash the transaction (32-byte SHA-256)
    const hashHex = tx.hash().toString("hex");

    // 3. Sign hash via Fireblocks RAW (MPC_EDDSA_ED25519)
    const sigResult = await signHash(this.fireblocks, this.config, hashHex);

    // 4. Attach signature to transaction envelope
    const signedTx = addSignatureToTransaction(
      tx,
      this.config.sourcePublicKey,
      sigResult.signatureHex,
      this.config.networkPassphrase,
    );

    // 5. Submit and poll until terminal
    const result = await submitAndPoll(this.server, signedTx);

    const txHash = tx.hash().toString("hex");

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        txHash,
        status: "SUCCESS",
        ledger: result.ledger,
      };
    }

    return {
      txHash,
      status: "FAILED",
      ledger: result.ledger,
    };
  }

  async configureIssuer(params: ConfigureIssuerParams = {}): Promise<ConfigureIssuerResult> {
    // Classic setOptions — no simulation needed
    const tx = await buildConfigureIssuerTransaction(this.server, this.config, params);

    const hashHex = tx.hash().toString("hex");
    const sigResult = await signHash(this.fireblocks, this.config, hashHex);

    const signedTx = addSignatureToTransaction(
      tx,
      this.config.sourcePublicKey,
      sigResult.signatureHex,
      this.config.networkPassphrase,
    );

    const result = await submitAndPoll(this.server, signedTx);
    const txHash = tx.hash().toString("hex");

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { txHash, status: "SUCCESS", ledger: result.ledger };
    }

    return { txHash, status: "FAILED", ledger: result.ledger };
  }

  async deploySac(params: DeploySacParams): Promise<DeploySacResult> {
    // Soroban op — needs simulation
    const rawTx = await buildDeploySacTransaction(this.server, this.config, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.config.networkPassphrase);

    const hashHex = preparedTx.hash().toString("hex");
    const sigResult = await signHash(this.fireblocks, this.config, hashHex);

    const signedTx = addSignatureToTransaction(
      preparedTx,
      this.config.sourcePublicKey,
      sigResult.signatureHex,
      this.config.networkPassphrase,
    );

    const result = await submitAndPoll(this.server, signedTx);
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
    // Soroban op — needs simulation
    const rawTx = await buildUploadWasmTransaction(this.server, this.config, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.config.networkPassphrase);

    const hashHex = preparedTx.hash().toString("hex");
    const sigResult = await signHash(this.fireblocks, this.config, hashHex);

    const signedTx = addSignatureToTransaction(
      preparedTx,
      this.config.sourcePublicKey,
      sigResult.signatureHex,
      this.config.networkPassphrase,
    );

    const result = await submitAndPoll(this.server, signedTx);
    const txHash = preparedTx.hash().toString("hex");

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const successResult = result as rpc.Api.GetSuccessfulTransactionResponse;
      let wasmHash: string | undefined;
      if (successResult.returnValue) {
        // returnValue is ScVal bytes — extract the raw 32-byte hash
        wasmHash = successResult.returnValue.bytes().toString("hex");
      }
      return { txHash, status: "SUCCESS", wasmHash, ledger: successResult.ledger };
    }

    return { txHash, status: "FAILED", ledger: result.ledger };
  }

  async deployContract(params: DeployContractParams): Promise<DeployContractResult> {
    // Soroban op — needs simulation
    const rawTx = await buildDeployContractTransaction(this.server, this.config, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.config.networkPassphrase);

    const hashHex = preparedTx.hash().toString("hex");
    const sigResult = await signHash(this.fireblocks, this.config, hashHex);

    const signedTx = addSignatureToTransaction(
      preparedTx,
      this.config.sourcePublicKey,
      sigResult.signatureHex,
      this.config.networkPassphrase,
    );

    const result = await submitAndPoll(this.server, signedTx);
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
