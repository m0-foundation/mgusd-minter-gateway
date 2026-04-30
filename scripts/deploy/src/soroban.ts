import {
  Address,
  Asset,
  AuthClawbackEnabledFlag,
  AuthFlag,
  AuthRequiredFlag,
  AuthRevocableFlag,
  Contract,
  Keypair,
  Operation,
  rpc,
  TransactionBuilder,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { SimulationError, SubmissionError } from "./deploy";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_FEE = "100";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60;

export interface SorobanContext {
  rpcUrl: string;
  networkPassphrase: string;
  sourcePublicKey: string;
}

export interface InvokeParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  timeoutSeconds?: number;
}

export interface DeploySacParams {
  assetCode: string;
  assetIssuer: string;
  timeoutSeconds?: number;
}

export interface UploadWasmParams {
  wasm: Buffer;
  timeoutSeconds?: number;
}

export interface DeployContractParams {
  wasmHash: Buffer;
  constructorArgs?: xdr.ScVal[];
  salt?: Buffer;
  timeoutSeconds?: number;
}

export interface ConfigureIssuerParams {
  timeoutSeconds?: number;
}

export function createRpcServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl);
}

export async function buildConfigureIssuerTransaction(
  server: rpc.Server,
  ctx: SorobanContext,
  params: ConfigureIssuerParams = {},
): Promise<Transaction> {
  const account = await server.getAccount(ctx.sourcePublicKey);
  return new TransactionBuilder(account, {
    fee: DEFAULT_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(
      Operation.setOptions({
        // AUTH_REQUIRED: trustlines must be explicitly authorized before holding the asset.
        // AUTH_REVOCABLE: admin can deauthorize holders post-creation (compliance freeze).
        // AUTH_CLAWBACK_ENABLED: required for the wrapper's burn/force_transfer paths
        //   that go through SAC clawback.
        setFlags: (AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag) as unknown as AuthFlag,
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
}

export async function buildDeploySacTransaction(
  server: rpc.Server,
  ctx: SorobanContext,
  params: DeploySacParams,
): Promise<Transaction> {
  const account = await server.getAccount(ctx.sourcePublicKey);
  return new TransactionBuilder(account, {
    fee: DEFAULT_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(
      Operation.createStellarAssetContract({
        asset: new Asset(params.assetCode, params.assetIssuer),
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
}

export async function buildUploadWasmTransaction(
  server: rpc.Server,
  ctx: SorobanContext,
  params: UploadWasmParams,
): Promise<Transaction> {
  const account = await server.getAccount(ctx.sourcePublicKey);
  return new TransactionBuilder(account, {
    fee: DEFAULT_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(Operation.uploadContractWasm({ wasm: params.wasm }))
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
}

export async function buildDeployContractTransaction(
  server: rpc.Server,
  ctx: SorobanContext,
  params: DeployContractParams,
): Promise<Transaction> {
  const account = await server.getAccount(ctx.sourcePublicKey);
  return new TransactionBuilder(account, {
    fee: DEFAULT_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(ctx.sourcePublicKey),
        wasmHash: params.wasmHash,
        constructorArgs: params.constructorArgs ?? [],
        salt: params.salt,
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
}

export async function buildInvokeTransaction(
  server: rpc.Server,
  ctx: SorobanContext,
  params: InvokeParams,
): Promise<Transaction> {
  const account = await server.getAccount(ctx.sourcePublicKey);
  const contract = new Contract(params.contractId);
  return new TransactionBuilder(account, {
    fee: DEFAULT_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(contract.call(params.method, ...(params.args ?? [])))
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();
}

export async function simulateAndPrepare(
  server: rpc.Server,
  tx: Transaction,
): Promise<Transaction> {
  const simResponse = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResponse)) {
    const errorMsg =
      "error" in simResponse ? String(simResponse.error) : "Unknown simulation error";
    throw new SimulationError(`Transaction simulation failed: ${errorMsg}`);
  }

  if (!rpc.Api.isSimulationSuccess(simResponse)) {
    throw new SimulationError("Transaction simulation did not return a success response");
  }

  return rpc.assembleTransaction(tx, simResponse).build();
}

export function addSignatureToTransaction(
  tx: Transaction,
  publicKey: string,
  signatureHex: string,
): Transaction {
  const keypair = Keypair.fromPublicKey(publicKey);
  const signature = Buffer.from(signatureHex, "hex");
  tx.addSignature(keypair.publicKey(), signature.toString("base64"));
  return tx;
}

export async function submitAndPoll(
  server: rpc.Server,
  tx: Transaction,
): Promise<rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse> {
  const sendResponse = await server.sendTransaction(tx);

  if (sendResponse.status === "ERROR") {
    throw new SubmissionError(
      `Transaction submission failed: ${sendResponse.errorResult?.toXDR("base64") ?? "unknown error"}`,
    );
  }

  const txHash = sendResponse.hash;

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);

    const getResponse = await server.getTransaction(txHash);

    if (getResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return getResponse as rpc.Api.GetSuccessfulTransactionResponse;
    }

    if (getResponse.status === rpc.Api.GetTransactionStatus.FAILED) {
      return getResponse as rpc.Api.GetFailedTransactionResponse;
    }
    // NOT_FOUND means still pending — keep polling
  }

  throw new SubmissionError(
    `Transaction ${txHash} not confirmed after ${MAX_POLL_ATTEMPTS} polls`,
    txHash,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
