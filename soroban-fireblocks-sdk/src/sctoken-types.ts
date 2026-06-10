export const MAX_BATCH_SIZE = 40;

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

export interface SetAdminParams {
  /** Contract ID (C...) */
  contractId: string;
  /** New admin address (G... or C...) */
  newAdmin: string;
}

export interface SetYieldRecipientManagerParams {
  /** Contract ID (C...) */
  contractId: string;
  /** New yield recipient manager address (G... or C...) */
  newYieldRecipientManager: string;
}

export interface SetForcedTransferManagerParams {
  /** Contract ID (C...) */
  contractId: string;
  /** New forced transfer manager address (G... or C...) */
  newForcedTransferManager: string;
}

export interface SetPauserParams {
  /** Contract ID (C...) */
  contractId: string;
  /** New pauser address (G... or C...) */
  newPauser: string;
}

export interface SetYieldRecipientParams {
  /** Contract ID (C...) */
  contractId: string;
  /** Caller address — must be the configured yield_recipient_manager */
  caller: string;
  /** New yield recipient address (G... or C...) */
  newYieldRecipient: string;
}

export interface TransferSacAdminParams {
  /** Contract ID (C...) */
  contractId: string;
  /**
   * New SAC admin (G... or C...).
   * WARNING: irreversible. After this call the wrapper contract no longer
   * holds SAC admin and can no longer mint, burn, clawback, or authorize.
   */
  newSacAdmin: string;
}

export interface UpgradeParams {
  /** Contract ID (C...) */
  contractId: string;
  /** SHA-256 hash of the new WASM (32 bytes). Accepts a Buffer or a 64-char hex string. */
  newWasmHash: Buffer | string;
}

export interface PauseParams {
  /** Contract ID (C...) */
  contractId: string;
  /** Caller address — must hold the pauser role */
  caller: string;
}

export interface QueryParams {
  /** Contract ID (C...) */
  contractId: string;
}

export interface SetAuthorizedBlockerParams {
  contractId: string;
  /** Block source name (e.g. "bridge_compliance", "moneygram_onboarding") */
  source: string;
  /** Address authorized to block/unblock under this source */
  blocker: string;
}

export interface RemoveAuthorizedBlockerParams {
  contractId: string;
  /** Block source to remove (along with its registered blocker) */
  source: string;
}

export interface BlockUserParams {
  contractId: string;
  /** Caller address - must be the registered blocker for `source` */
  caller: string;
  /** User (account) to block or unblock */
  user: string;
  /** Block source the caller is authorized for */
  source: string;
}

export interface BatchBlockUsersParams {
  contractId: string;
  /** Caller address - must be the registered blocker for `source` */
  caller: string;
  /** Users (accounts) to block or unblock (max 40) */
  users: string[];
  /** Block source the caller is authorized for */
  source: string;
}

export interface ForceTransferParams {
  contractId: string;
  /** Caller address — must be the configured forced_transfer_manager (admin alone cannot force-transfer) */
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
  /**
   * Caller address — must be the configured yield_recipient_manager.
   * The yield_recipient is the *destination* of the minted SAC tokens
   * (passive); it does not call this method. Admin alone cannot claim
   * yield without first granting itself the manager role.
   */
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
  /** Pauser address (G... or C...) */
  pauser: string;
  /** Local Keypair that signs the protocol-permissionless deploy ops (SAC deploy, WASM upload, contract create). Throwaway. */
  deployerKeypair: import("@stellar/stellar-sdk").Keypair;
  /** Optional `home_domain` bound to the issuer in step 1 (≤32 bytes, no scheme). Enables SEP-1 metadata discovery. */
  homeDomain?: string;
}

export interface DeployFullResult {
  /** SAC contract ID (C...) */
  sacContractId: string;
  /** SHA-256 hash of the uploaded WASM (hex) */
  wasmHash: string;
  /** Deployed wrapper contract ID (C...) */
  wrapperContractId: string;
}
