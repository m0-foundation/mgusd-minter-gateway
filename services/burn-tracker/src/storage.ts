import Database from "better-sqlite3";
import { BurnRecord } from "./types";

export class Storage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        sac_ledger  INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO state (id, sac_ledger) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS burns (
        tx_hash           TEXT NOT NULL,
        operation_id      TEXT NOT NULL,
        operation_index   INTEGER NOT NULL,
        ledger            INTEGER NOT NULL,
        timestamp         TEXT NOT NULL,
        from_address      TEXT NOT NULL,
        amount            TEXT NOT NULL,
        reconciled        INTEGER NOT NULL DEFAULT 0,
        reconcile_tx_hash TEXT,
        PRIMARY KEY (tx_hash, operation_index)
      );
    `);
  }

  hasReconciledBurn(txHash: string, operationIndex: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM burns WHERE tx_hash = ? AND operation_index = ? AND reconciled = 1")
      .get(txHash, operationIndex);
    return row !== undefined;
  }

  /** Inserts burn record. If reconcileTxHash provided — stores as reconciled=1, otherwise reconciled=0. */
  addBurn(record: BurnRecord, reconcileTxHash?: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO burns
           (tx_hash, operation_id, operation_index, ledger, timestamp, from_address, amount, reconciled, reconcile_tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.txHash,
        record.operationId,
        record.operationIndex,
        record.ledger,
        record.timestamp,
        record.from,
        record.amount,
        reconcileTxHash ? 1 : 0,
        reconcileTxHash ?? null,
      );
  }

  markReconciled(txHash: string, operationIndex: number, reconcileTxHash: string): void {
    this.db
      .prepare("UPDATE burns SET reconciled = 1, reconcile_tx_hash = ? WHERE tx_hash = ? AND operation_index = ?")
      .run(reconcileTxHash, txHash, operationIndex);
  }

  getPendingReconciliation(): BurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM burns WHERE reconciled = 0 ORDER BY ledger ASC")
      .all() as DbRow[];
    return rows.map(toRecord);
  }

  getSacLedger(): number {
    const row = this.db.prepare("SELECT sac_ledger FROM state WHERE id = 1").get() as
      | { sac_ledger: number }
      | undefined;
    return row?.sac_ledger ?? 0;
  }

  advanceSacLedger(ledger: number): void {
    this.db.prepare("UPDATE state SET sac_ledger = MAX(sac_ledger, ?) WHERE id = 1").run(ledger);
  }

  getPendingAmount(): string {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM burns WHERE reconciled = 0")
      .get() as { total: number };
    return row.total.toFixed(7);
  }

  getBurns(): BurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM burns ORDER BY ledger ASC")
      .all() as DbRow[];
    return rows.map(toRecord);
  }
}

interface DbRow {
  tx_hash: string;
  operation_id: string;
  operation_index: number;
  ledger: number;
  timestamp: string;
  from_address: string;
  amount: string;
  reconciled: number;
  reconcile_tx_hash: string | null;
}

function toRecord(row: DbRow): BurnRecord {
  return {
    txHash: row.tx_hash,
    operationId: row.operation_id,
    operationIndex: row.operation_index,
    ledger: row.ledger,
    timestamp: row.timestamp,
    from: row.from_address,
    amount: row.amount,
    reconciled: row.reconciled === 1,
    reconcileTxHash: row.reconcile_tx_hash ?? undefined,
  };
}
