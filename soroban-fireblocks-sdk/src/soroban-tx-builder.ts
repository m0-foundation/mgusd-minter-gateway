import {
  Account,
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
} from "@stellar/stellar-sdk";
import { SimulationError, SubmissionError } from "./errors";
import {
  ConfigureIssuerParams,
  DeployContractParams,
  DeploySacParams,
  InvokeContractParams,
  SetupTrustlineParams,
  SorobanFireblocksConfig,
  UploadWasmParams,
} from "./types";

const DEFAULT_TIMEOUT_SECONDS = 30;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60;


export function createRpcServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl);
}

export async function buildInvokeTransaction(
  server: rpc.Server,
  config: SorobanFireblocksConfig,
  params: InvokeContractParams,
): Promise<Transaction> {
  const account = await server.getAccount(config.sourcePublicKey);
  const contract = new Contract(params.contractId);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(params.method, ...(params.args ?? [])))
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();

  return tx;
}

export async function simulateAndPrepare(
  server: rpc.Server,
  tx: Transaction,
  networkPassphrase: string,
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

  const assembled = rpc.assembleTransaction(tx, simResponse);
  return assembled.build();
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

  throw new SubmissionError(`Transaction ${txHash} not confirmed after ${MAX_POLL_ATTEMPTS} polls`, txHash);
}

export function addSignatureToTransaction(
  tx: Transaction,
  publicKey: string,
  signatureHex: string,
  networkPassphrase: string,
): Transaction {
  const keypair = Keypair.fromPublicKey(publicKey);
  const signature = Buffer.from(signatureHex, "hex");

  tx.addSignature(keypair.publicKey(), signature.toString("base64"));
  return tx;
}

export async function buildChangeTrustTransaction(
  server: rpc.Server,
  config: SorobanFireblocksConfig,
  params: SetupTrustlineParams,
): Promise<Transaction> {
  const account = await server.getAccount(config.sourcePublicKey);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.changeTrust({
        asset: new Asset(params.assetCode, params.assetIssuer),
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();

  return tx;
}

export async function buildConfigureIssuerTransaction(
  server: rpc.Server,
  config: SorobanFireblocksConfig,
  params: ConfigureIssuerParams,
): Promise<Transaction> {
  const account = await server.getAccount(config.sourcePublicKey);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.setOptions({
        setFlags: (AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag) as unknown as AuthFlag,
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();

  return tx;
}

export async function buildDeploySacTransaction(
  server: rpc.Server,
  config: SorobanFireblocksConfig,
  params: DeploySacParams,
): Promise<Transaction> {
  const account = await server.getAccount(config.sourcePublicKey);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.createStellarAssetContract({
        asset: new Asset(params.assetCode, params.assetIssuer),
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();

  return tx;
}

export async function buildUploadWasmTransaction(
  server: rpc.Server,
  config: SorobanFireblocksConfig,
  params: UploadWasmParams,
): Promise<Transaction> {
  const account = await server.getAccount(config.sourcePublicKey);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.uploadContractWasm({
        wasm: params.wasm,
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();

  return tx;
}

export async function buildDeployContractTransaction(
  server: rpc.Server,
  config: SorobanFireblocksConfig,
  params: DeployContractParams,
): Promise<Transaction> {
  const account = await server.getAccount(config.sourcePublicKey);

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(config.sourcePublicKey),
        wasmHash: params.wasmHash,
        constructorArgs: params.constructorArgs ?? [],
        salt: params.salt,
      }),
    )
    .setTimeout(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    .build();

  return tx;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
