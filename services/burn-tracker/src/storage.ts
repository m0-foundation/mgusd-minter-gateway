import * as fs from "fs";
import { BurnRecord, StorageState } from "./types";

export class Storage {
  private state: StorageState;

  constructor(private readonly filePath: string) {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      this.state = JSON.parse(raw) as StorageState;
    } else {
      this.state = { cursor: "", burns: [] };
    }
  }

  getCursor(): string {
    return this.state.cursor;
  }

  addBurn(record: BurnRecord): void {
    this.state.burns.push(record);
    this.state.cursor = record.pagingToken;
    this.flush();
  }

  markReconciled(id: string, reconcileTxHash: string): void {
    const record = this.state.burns.find((b) => b.id === id);
    if (record) {
      record.reconciled = true;
      record.reconcileTxHash = reconcileTxHash;
      this.flush();
    }
  }

  getPendingReconciliation(): BurnRecord[] {
    return this.state.burns.filter((b) => !b.reconciled);
  }

  /** Advance cursor without adding a burn (for non-burn payments). */
  advanceCursor(pagingToken: string): void {
    this.state.cursor = pagingToken;
    this.flush();
  }

  getBurns(): BurnRecord[] {
    return this.state.burns;
  }

  private flush(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }
}
