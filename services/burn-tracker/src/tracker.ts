import { Asset, Horizon } from "@stellar/stellar-sdk";
import { Config } from "./config";
import { Reconciler } from "./reconciler";
import { Storage } from "./storage";
import { BurnRecord } from "./types";

/**
 * Converts a ledger sequence number into a Horizon paging_token cursor.
 * The token encodes (ledger * 2^32), placing the cursor just before any
 * operation in that ledger
 */
function ledgerToCursor(ledger: number): string {
  return String((BigInt(ledger) - 1n) * 4294967296n);
}

function isPaymentToIssuer(
  op: Horizon.ServerApi.PaymentOperationRecord,
  assetCode: string,
  assetIssuer: string,
): boolean {
  return (
    op.to === assetIssuer &&
    op.asset_type !== "native" &&
    op.asset_code === assetCode &&
    op.asset_issuer === assetIssuer
  );
}

function ledgerFromPagingToken(pagingToken: string): number {
  return Number(BigInt(pagingToken) / 4294967296n);
}

function toRecord(op: Horizon.ServerApi.PaymentOperationRecord): BurnRecord {
  return {
    id: op.id,
    txHash: op.transaction_hash,
    ledger: ledgerFromPagingToken(op.paging_token),
    timestamp: op.created_at,
    from: op.from,
    amount: op.amount,
    pagingToken: op.paging_token,
    reconciled: false,
  };
}

export class BurnTracker {
  private readonly horizon: Horizon.Server;
  private readonly asset: Asset;

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly reconciler: Reconciler,
  ) {
    this.horizon = new Horizon.Server(config.horizonUrl);
    this.asset = new Asset(config.assetCode, config.assetIssuer);
  }

  async run(): Promise<void> {
    const startCursor = this.storage.getCursor() || ledgerToCursor(this.config.startLedger);
    console.log(`[burn-tracker] Starting from cursor ${startCursor} (ledger ~${this.config.startLedger})`);
    console.log(`[burn-tracker] Asset: ${this.config.assetCode}:${this.config.assetIssuer}`);
    console.log(`[burn-tracker] Known burns so far: ${this.storage.getBurns().length}`);

    // Retry any burns that were tracked but not yet reconciled before last shutdown
    await this.reconciler.retryPending();

    await this.backfill(startCursor);
    await this.stream();
  }

  /** Paginate through historical payments to the issuer */
  private async backfill(startCursor: string): Promise<void> {
    console.log("[burn-tracker] Backfill: scanning historical payments...");
    let cursor = startCursor;
    let count = 0;

    while (true) {
      const page = await this.horizon
        .payments()
        .forAccount(this.config.assetIssuer)
        .limit(200)
        .cursor(cursor)
        .order("asc")
        .call();

      const ops = page.records.filter(
        (r): r is Horizon.ServerApi.PaymentOperationRecord => r.type === "payment",
      );

      if (ops.length === 0) break;

      for (const op of ops) {
        if (isPaymentToIssuer(op, this.config.assetCode, this.config.assetIssuer)) {
          const record = toRecord(op);
          this.storage.addBurn(record);
          count++;
          console.log(
            `[burn-tracker] Burn: ${record.amount} ${this.config.assetCode} from ${record.from} (ledger ${record.ledger}, tx ${record.txHash})`,
          );
          await this.reconciler.reconcile(record);
        } else {
          this.storage.advanceCursor(op.paging_token);
        }
        cursor = op.paging_token;
      }

      // reached the latest ledger
      if (ops.length < 200) break;
    }

    console.log(`[burn-tracker] Backfill complete — ${count} new burn(s) found.`);
  }

  /** Stream real-time payments to the issuer using Horizon */
  private stream(): Promise<void> {
    const cursor = this.storage.getCursor() || ledgerToCursor(this.config.startLedger);
    console.log(`[burn-tracker] Streaming from cursor ${cursor}...`);

    return new Promise((_resolve, reject) => {
      this.horizon
        .payments()
        .forAccount(this.config.assetIssuer)
        .cursor(cursor)
        .order("asc")
        .stream({
          onmessage: (op) => {
            if (op.type !== "payment") return;
            const payment = op as Horizon.ServerApi.PaymentOperationRecord;
            if (isPaymentToIssuer(payment, this.config.assetCode, this.config.assetIssuer)) {
              const record = toRecord(payment);
              this.storage.addBurn(record);
              console.log(
                `[burn-tracker] Burn detected: ${record.amount} ${this.config.assetCode} from ${record.from} (ledger ${record.ledger}, tx ${record.txHash})`,
              );
              this.reconciler.reconcile(record).catch((err) => {
                console.error("[burn-tracker] Unexpected reconcile error:", err);
              });
            } else {
              this.storage.advanceCursor(payment.paging_token);
            }
          },
          onerror: (err) => {
            console.error("[burn-tracker] Stream error:", err);
            if ((err as { status?: number }).status) {
              reject(new Error(`Stream fatal error: ${JSON.stringify(err)}`));
            }
          },
        });
    });
  }
}
