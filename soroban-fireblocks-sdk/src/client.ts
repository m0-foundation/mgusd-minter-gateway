import { createHash } from "crypto";
import { Fireblocks } from "@fireblocks/ts-sdk";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { createFireblocksClient, signHash } from "./fireblocks-signer";
import { SimulationError, WasmHashMismatchError } from "./errors";
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
  // Undefined when constructed from a view-only config (no API creds). Signing
  // paths assert non-null at the callsite — the CLI never routes a view config
  // into a signing method.
  protected readonly fireblocks: Fireblocks | undefined;
  protected readonly config: SorobanFireblocksConfig;

  constructor(config: SorobanFireblocksConfig) {
    this.config = config;
    this.server = createRpcServer(config.sorobanRpcUrl);
    this.fireblocks =
      config.fireblocksApiKey && config.fireblocksSecretKey
        ? createFireblocksClient(config)
        : undefined;
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

    // Emit a copy-pasteable share-block so the submitter can hand off the
    // hash + envelope to approvers for independent verification. stderr so
    // --json stdout stays parseable.
    printShareBlock(hashHex, preparedTx.toEnvelope().toXDR("base64"));

    // 4. Sign hash via Fireblocks RAW (MPC_EDDSA_ED25519)
    const sigResult = await signHash(this.fireblocks!, this.config, hashHex, params.fireblocksNote);

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

    printShareBlock(hashHex, tx.toEnvelope().toXDR("base64"));

    // 3. Sign hash via Fireblocks RAW (MPC_EDDSA_ED25519)
    const note = `setupTrustline asset=${params.assetCode}:${params.assetIssuer} trustor=${this.config.sourcePublicKey}`;
    const sigResult = await signHash(this.fireblocks!, this.config, hashHex, note);

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
    printShareBlock(hashHex, tx.toEnvelope().toXDR("base64"));
    const note = `configureIssuer (set flags AUTH_REQUIRED + AUTH_REVOCABLE) on ${this.config.sourcePublicKey}`;
    const sigResult = await signHash(this.fireblocks!, this.config, hashHex, note);

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
    printShareBlock(hashHex, preparedTx.toEnvelope().toXDR("base64"));
    const note = `deploySac asset=${params.assetCode}:${params.assetIssuer ?? this.config.sourcePublicKey}`;
    const sigResult = await signHash(this.fireblocks!, this.config, hashHex, note);

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
    // Compute the expected WASM hash locally — never trust the RPC's returnValue
    // for this. A compromised or spoofed RPC can otherwise return the hash of
    // attacker-controlled bytecode already on-chain, which downstream
    // deployContract / set_admin would then deploy and grant SAC admin to.
    const expectedWasmHash = createHash("sha256").update(params.wasm).digest("hex");

    // Soroban op — needs simulation
    const rawTx = await buildUploadWasmTransaction(this.server, this.config, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.config.networkPassphrase);

    const hashHex = preparedTx.hash().toString("hex");
    printShareBlock(hashHex, preparedTx.toEnvelope().toXDR("base64"));
    const note = `uploadWasm sha256=${expectedWasmHash}`;
    const sigResult = await signHash(this.fireblocks!, this.config, hashHex, note);

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
    // Soroban op — needs simulation
    const rawTx = await buildDeployContractTransaction(this.server, this.config, params);
    const preparedTx = await simulateAndPrepare(this.server, rawTx, this.config.networkPassphrase);

    const hashHex = preparedTx.hash().toString("hex");
    printShareBlock(hashHex, preparedTx.toEnvelope().toXDR("base64"));
    const note = `deployContract wasmHash=${params.wasmHash}`;
    const sigResult = await signHash(this.fireblocks!, this.config, hashHex, note);

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

/**
 * Emits a copy-pasteable share-block to stderr so the submitter can hand the
 * hash + envelope XDR to approvers for independent verification (via
 * `npm run verify-envelope`). stderr keeps stdout (incl. --json) clean.
 */
function printShareBlock(hashHex: string, envelopeB64: string): void {
  console.error("[Verify] Share with approvers before they approve in Fireblocks:");
  console.error(`  hash:     ${hashHex}`);
  console.error(`  envelope: ${envelopeB64}`);
  console.error(`  decode:   npm run verify-envelope -- --xdr "${envelopeB64}"`);
}
