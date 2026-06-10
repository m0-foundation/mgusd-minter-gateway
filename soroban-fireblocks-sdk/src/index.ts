// Base SDK
export { SorobanFireblocksClient } from "./client";
export { SorobanKeypairClient } from "./keypair-client";
export type { SorobanKeypairConfig } from "./keypair-client";
export {
  loadConfigFromEnv,
  loadIssuerConfigFromEnv,
  loadMinterConfigFromEnv,
  validateConfig,
  readFireblocksSecret,
} from "./config";
export { ConfigError, SimulationError, FireblocksSigningError, SubmissionError, IssuerContaminatedError, IssuerContaminationCounts, WasmHashMismatchError } from "./errors";
export {
  assertIssuerNotContaminated,
  assertIssuerSufficientlyFunded,
  assertVaultMatchesPubkey,
  assertIssuerFlagsClean,
  assertDeployerSufficientlyFunded,
} from "./deploy-checks";
export { createFireblocksClient, signHash } from "./fireblocks-signer";
export {
  createRpcServer,
  buildInvokeTransaction,
  buildChangeTrustTransaction,
  buildConfigureIssuerTransaction,
  buildAddIssuerSignerTransaction,
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
  AddIssuerSignerParams,
  AddIssuerSignerResult,
  DeploySacParams,
  DeploySacResult,
  UploadWasmParams,
  UploadWasmResult,
  DeployContractParams,
  DeployContractResult,
} from "./types";

// SCToken extensions
export { SctokenFireblocksClient } from "./sctoken-client";
export { addressToScVal, addressVecToScVal, bytesN32ToScVal, i128ToScVal, symbolToScVal, u32ToScVal } from "./scval-helpers";
export { MAX_BATCH_SIZE } from "./sctoken-types";
export type {
  MintParams,
  BurnParams,
  SetRateParams,
  SetMinterParams,
  SetAdminParams,
  SetYieldRecipientManagerParams,
  SetForcedTransferManagerParams,
  SetPauserParams,
  SetYieldRecipientParams,
  TransferSacAdminParams,
  UpgradeParams,
  PauseParams,
  SetAuthorizedBlockerParams,
  RemoveAuthorizedBlockerParams,
  BlockUserParams,
  BatchBlockUsersParams,
  ForceTransferParams,
  ReconcileBurnParams,
  ClaimYieldParams,
  QueryParams,
  DeployFullParams,
  DeployFullResult,
} from "./sctoken-types";
