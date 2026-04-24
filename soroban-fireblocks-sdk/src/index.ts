// Base SDK
export { SorobanFireblocksClient } from "./client";
export { loadConfigFromEnv, loadIssuerConfigFromEnv, loadMinterConfigFromEnv, validateConfig, readFireblocksSecret } from "./config";
export { ConfigError, SimulationError, FireblocksSigningError, SubmissionError } from "./errors";
export { createFireblocksClient, signHash } from "./fireblocks-signer";
export {
  createRpcServer,
  buildInvokeTransaction,
  buildChangeTrustTransaction,
  buildConfigureIssuerTransaction,
  buildDeploySacTransaction,
  buildUploadWasmTransaction,
  buildDeployContractTransaction,
  simulateAndPrepare,
  submitAndPoll,
  addSignatureToTransaction,
} from "./soroban-tx-builder";
export type {
  SorobanFireblocksConfig,
  InvokeContractParams,
  InvokeContractResult,
  FireblocksSignatureResult,
  SetupTrustlineParams,
  SetupTrustlineResult,
  ConfigureIssuerParams,
  ConfigureIssuerResult,
  DeploySacParams,
  DeploySacResult,
  UploadWasmParams,
  UploadWasmResult,
  DeployContractParams,
  DeployContractResult,
} from "./types";

// SCToken extensions
export { SctokenFireblocksClient } from "./sctoken-client";
export { addressToScVal, i128ToScVal, u32ToScVal } from "./scval-helpers";
export { MAX_BATCH_SIZE } from "./sctoken-types";
export type {
  MintParams,
  BurnParams,
  SetRateParams,
  SetMinterParams,
  BlockUserParams,
  BatchBlockUsersParams,
  ForceTransferParams,
  ReconcileBurnParams,
  ClaimYieldParams,
  QueryParams,
  DeployFullParams,
  DeployFullResult,
} from "./sctoken-types";
export { addressVecToScVal } from "./scval-helpers";
