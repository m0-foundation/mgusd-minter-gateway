export const MAX_BATCH_SIZE = 20;

export interface MintParams {
  /** Contract ID (C...) */
  contractId: string;
  /** Caller address — must be minter or admin (G... or C...) */
  caller: string;
  /** Destination address to mint tokens to (G... or C...) */
  to: string;
  /** Amount to mint (as bigint for i128 safety) */
  amount: bigint;
}

export interface BurnParams {
  /** Contract ID (C...) */
  contractId: string;
  /** Caller address — must be minter or admin (G... or C...) */
  caller: string;
  /** Address to burn tokens from (G... or C...) */
  from: string;
  /** Amount to burn (as bigint for i128 safety) */
  amount: bigint;
}

export interface SetRateParams {
  /** Contract ID (C...) */
  contractId: string;
  /** Caller address — must be minter or admin (G... or C...) */
  caller: string;
  /** Interest rate in basis points (0–10000, where 10000 = 100%) */
  rateBps: number;
}

export interface SetMinterParams {
  /** Contract ID (C...) */
  contractId: string;
  /** New minter address (G... or C...) */
  newMinter: string;
}

export interface QueryParams {
  /** Contract ID (C...) */
  contractId: string;
}

export interface FreezeAccountParams {
  contractId: string;
  /** Caller address — must be admin or distributor */
  caller: string;
  /** Account to freeze */
  account: string;
}

export interface BatchFreezeAccountsParams {
  contractId: string;
  /** Caller address — must be admin or distributor */
  caller: string;
  /** Accounts to freeze (max 20) */
  accounts: string[];
}

export interface ForceTransferParams {
  contractId: string;
  /** Caller address — must be admin or forced_transfer_manager */
  caller: string;
  /** Source account */
  from: string;
  /** Destination account */
  to: string;
  /** Amount in stroops */
  amount: bigint;
}

export interface ReconcileBurnParams {
  contractId: string;
  /** Amount to reconcile in stroops */
  amount: bigint;
}

export interface ClaimYieldParams {
  contractId: string;
  /** Caller address — must be admin or yield_recipient */
  caller: string;
}

export interface DeployFullParams {
  /** Asset code (e.g., TMGUSD) */
  assetCode: string;
  /** Asset issuer address (G...) */
  assetIssuer: string;
  /** Compiled WASM bytecode */
  wasm: Buffer;
  /** Admin address for the wrapper contract (G... or C...) */
  admin: string;
  /** Minter address (G... or C...) */
  minter: string;
  /** Yield recipient manager address (G... or C...) */
  yieldRecipientManager: string;
  /** Yield recipient address (G... or C...) */
  yieldRecipient: string;
  /** Forced transfer manager address (G... or C...) */
  forcedTransferManager: string;
  /** Distributor address (G... or C...) */
  distributor: string;
  /** Pauser address (G... or C...) */
  pauser: string;
}

export interface DeployFullResult {
  /** SAC contract ID (C...) */
  sacContractId: string;
  /** SHA-256 hash of the uploaded WASM (hex) */
  wasmHash: string;
  /** Deployed wrapper contract ID (C...) */
  wrapperContractId: string;
}
