export interface BurnRecord {
  /** Horizon operation ID */
  id: string;
  /** Transaction hash */
  txHash: string;
  /** Ledger sequence number */
  ledger: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Account that sent tokens to the issuer */
  from: string;
  /** Amount burned as returned by Horizon (decimal string, 7 d.p.) */
  amount: string;
  /** Horizon paging_token — used to resume from this point */
  pagingToken: string;
  /** Whether reconcile_burn was successfully submitted for this burn */
  reconciled: boolean;
  /** Transaction hash of the reconcile_burn call, set once reconciled */
  reconcileTxHash?: string;
}

export interface StorageState {
  /** Last processed Horizon paging_token */
  cursor: string;
  burns: BurnRecord[];
}
