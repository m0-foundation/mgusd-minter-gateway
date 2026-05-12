export interface BurnRecord {
  /** SAC event ID */
  operationId: string;
  /** Transaction hash — primary key */
  txHash: string;
  /** Index of the operation within the transaction */
  operationIndex: number;
  /** Ledger sequence number */
  ledger: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Account that sent tokens to the issuer */
  from: string;
  /** Amount burned as returned by Horizon (decimal string, 7 d.p.) */
  amount: string;
  /** Whether reconcile_burn was successfully submitted for this burn */
  reconciled: boolean;
  /** Transaction hash of the reconcile_burn call, set once reconciled */
  reconcileTxHash?: string;
}
