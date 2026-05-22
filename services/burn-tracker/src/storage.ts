import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { BurnRecord } from "./types";

export class Storage {
  private readonly client: DynamoDBDocumentClient;
  private readonly burnsTable: string;
  private readonly stateTable: string;

  constructor(region: string, burnsTable: string, stateTable: string) {
    const dynamo = new DynamoDBClient({ region });
    this.client = DynamoDBDocumentClient.from(dynamo);
    this.burnsTable = burnsTable;
    this.stateTable = stateTable;
  }

  async hasReconciledBurn(txHash: string, operationIndex: number): Promise<boolean> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.burnsTable,
        Key: { txHash, operationIndex },
        ProjectionExpression: "reconciled",
      }),
    );
    return result.Item?.reconciled === 1;
  }

  async addBurn(record: BurnRecord, reconcileTxHash?: string): Promise<void> {
    const item: Record<string, unknown> = {
      txHash: record.txHash,
      operationIndex: record.operationIndex,
      operation_id: record.operationId,
      ledger: record.ledger,
      timestamp: record.timestamp,
      from_address: record.from,
      amount: record.amount,
      reconciled: reconcileTxHash ? 1 : 0,
    };
    if (reconcileTxHash) item.reconcile_tx_hash = reconcileTxHash;

    try {
      await this.client.send(
        new PutCommand({
          TableName: this.burnsTable,
          Item: item,
          ConditionExpression: "attribute_not_exists(txHash)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return;
      throw err;
    }
  }

  async markReconciled(txHash: string, operationIndex: number, reconcileTxHash: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.burnsTable,
        Key: { txHash, operationIndex },
        UpdateExpression: "SET reconciled = :one, reconcile_tx_hash = :hash",
        ExpressionAttributeValues: { ":one": 1, ":hash": reconcileTxHash },
      }),
    );
  }

  async getPendingReconciliation(): Promise<BurnRecord[]> {
    const items = await this.scanAll({
      TableName: this.burnsTable,
      FilterExpression: "reconciled = :zero",
      ExpressionAttributeValues: { ":zero": 0 },
    });
    return items.map(toRecord).sort((a, b) => a.ledger - b.ledger);
  }

  async getSacLedger(): Promise<number> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.stateTable,
        Key: { id: "1" },
        ProjectionExpression: "sac_ledger",
      }),
    );
    return (result.Item?.sac_ledger as number | undefined) ?? 0;
  }

  async advanceSacLedger(ledger: number): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.stateTable,
          Key: { id: "1" },
          UpdateExpression: "SET sac_ledger = :new",
          ConditionExpression: "attribute_not_exists(sac_ledger) OR sac_ledger < :new",
          ExpressionAttributeValues: { ":new": ledger },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return;
      throw err;
    }
  }

  async getPendingAmount(): Promise<string> {
    const items = await this.scanAll({
      TableName: this.burnsTable,
      FilterExpression: "reconciled = :zero",
      ExpressionAttributeValues: { ":zero": 0 },
      ProjectionExpression: "amount",
    });
    const total = items.reduce((sum, item) => sum + parseFloat((item as { amount: string }).amount), 0);
    return total.toFixed(7);
  }

  async getBurns(): Promise<BurnRecord[]> {
    const items = await this.scanAll({ TableName: this.burnsTable });
    return items.map(toRecord).sort((a, b) => a.ledger - b.ledger);
  }

  private async scanAll(params: Parameters<typeof ScanCommand>[0]): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new ScanCommand({ ...params, ExclusiveStartKey: lastKey }),
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey !== undefined);
    return items;
  }
}

interface DbRow {
  txHash: string;
  operationIndex: number;
  operation_id: string;
  ledger: number;
  timestamp: string;
  from_address: string;
  amount: string;
  reconciled: number;
  reconcile_tx_hash?: string;
}

function toRecord(row: Record<string, unknown>): BurnRecord {
  const r = row as DbRow;
  return {
    txHash: r.txHash,
    operationId: r.operation_id,
    operationIndex: r.operationIndex,
    ledger: r.ledger,
    timestamp: r.timestamp,
    from: r.from_address,
    amount: r.amount,
    reconciled: r.reconciled === 1,
    reconcileTxHash: r.reconcile_tx_hash,
  };
}
