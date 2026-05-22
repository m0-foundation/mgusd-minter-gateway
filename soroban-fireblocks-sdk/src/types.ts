import { xdr } from "@stellar/stellar-sdk";

export interface SorobanFireblocksConfig {
  /** Soroban RPC endpoint URL */
  sorobanRpcUrl: string;
  /** Horizon endpoint URL (used by `deployFull` for the pre-deploy
   *  trustline-contamination check — see audit STEL1-6) */
  horizonUrl: string;
  /** Stellar network passphrase */
  networkPassphrase: string;
  /** Fireblocks API key */
  fireblocksApiKey: string;
  /** Fireblocks API secret (PEM string) */
  fireblocksSecretKey: string;
  /** Fireblocks vault account ID */
  fireblocksVaultAccountId: string;
  /** Fireblocks asset ID (e.g., XLM_TEST, XLM) */
  fireblocksAssetId: string;
  /** Fireblocks base path (sandbox, us, eu, eu2) — defaults to sandbox */
  fireblocksBasePath?: string;
  /** Stellar source account public key (G...) */
  sourcePublicKey: string;
}

export interface InvokeContractParams {
  /** Contract ID (C...) */
  contractId: string;
  /** Contract method name */
  method: string;
  /** Contract method arguments as xdr.ScVal[] */
  args?: xdr.ScVal[];
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
  /**
   * Optional human-readable note attached to the Fireblocks RAW signing
   * request. Shown to approvers in the Fireblocks console + mobile app
   * alongside the (otherwise opaque) 32-byte hash. Keep ≤ 250 chars.
   */
  fireblocksNote?: string;
}

export interface InvokeContractResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction status (SUCCESS or FAILED) */
  status: string;
  /** Return value from the contract invocation */
  returnValue?: xdr.ScVal;
  /** Ledger the transaction was included in */
  ledger: number;
}

export interface FireblocksSignatureResult {
  /** 64-byte Ed25519 signature as hex string */
  signatureHex: string;
  /** Fireblocks transaction ID */
  fireblocksTransactionId: string;
}

export interface SetupTrustlineParams {
  /** Asset code (e.g., TMGUSD) */
  assetCode: string;
  /** Asset issuer address (G...) */
  assetIssuer: string;
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
}

export interface SetupTrustlineResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction status (SUCCESS or FAILED) */
  status: string;
  /** Ledger the transaction was included in */
  ledger: number;
}

export interface ConfigureIssuerParams {
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
}

export interface ConfigureIssuerResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction status (SUCCESS or FAILED) */
  status: string;
  /** Ledger the transaction was included in */
  ledger: number;
}

export interface DeploySacParams {
  /** Asset code (e.g., TMGUSD) */
  assetCode: string;
  /** Asset issuer address (G...) */
  assetIssuer: string;
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
}

export interface DeploySacResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction status (SUCCESS or FAILED) */
  status: string;
  /** SAC contract ID (C...) */
  sacContractId?: string;
  /** Ledger the transaction was included in */
  ledger: number;
}

export interface UploadWasmParams {
  /** Compiled WASM bytecode */
  wasm: Buffer;
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
}

export interface UploadWasmResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction status (SUCCESS or FAILED) */
  status: string;
  /** SHA-256 hash of the uploaded WASM (hex) */
  wasmHash?: string;
  /** Ledger the transaction was included in */
  ledger: number;
}

export interface DeployContractParams {
  /** WASM hash (32 bytes) */
  wasmHash: Buffer;
  /** Constructor arguments as xdr.ScVal[] */
  constructorArgs?: xdr.ScVal[];
  /** Optional salt for deterministic contract ID (32 bytes) */
  salt?: Buffer;
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
}

export interface DeployContractResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction status (SUCCESS or FAILED) */
  status: string;
  /** Deployed contract ID (C...) */
  contractId?: string;
  /** Ledger the transaction was included in */
  ledger: number;
}
