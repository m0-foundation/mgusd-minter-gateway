import * as fs from "fs";
import { SctokenFireblocksClient, readFireblocksSecret } from "soroban-fireblocks-sdk";
import { Config } from "./config";
import { Storage } from "./storage";
import { BurnRecord } from "./types";

const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Convert a Horizon amount string (decimal, 7 d.p.) to stroops as BigInt.
 * e.g. "1234.5678901" -> 12345678901n
 */
function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fracPadded);
}

export class Reconciler {
  private readonly client: SctokenFireblocksClient;

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
  ) {
    const fireblocksSecretKey = readFireblocksSecret(config.fireblocksSecretPath);
    this.client = new SctokenFireblocksClient({
      sorobanRpcUrl: config.sorobanRpcUrl,
      horizonUrl: config.horizonUrl,
      networkPassphrase: config.networkPassphrase,
      fireblocksApiKey: config.fireblocksApiKey,
      fireblocksSecretKey,
      fireblocksVaultAccountId: config.fireblocksVaultAccountId,
      fireblocksAssetId: config.fireblocksAssetId,
      fireblocksBasePath: config.fireblocksBasePath,
      sourcePublicKey: config.adminPublicKey,
    });
  }

  /** Retry any burns that were tracked but never reconciled (e.g. after a crash). */
  async retryPending(): Promise<void> {
    const pending = this.storage.getPendingReconciliation();
    if (pending.length === 0) return;
    console.log(`[reconciler] Retrying ${pending.length} pending reconciliation(s)...`);
    for (const burn of pending) {
      await this.reconcile(burn);
    }
  }

  async reconcile(burn: BurnRecord): Promise<void> {
    const amount = toStroops(burn.amount);
    console.log(
      `[reconciler] Calling reconcile_burn: ${burn.amount} (${amount} stroops) — burn tx ${burn.txHash}`,
    );

    try {
      const result = await this.client.reconcileBurn({
        contractId: this.config.contractId,
        amount,
      });

      if (result.status !== "SUCCESS") {
        throw new Error(`reconcile_burn tx ${result.txHash} landed with status ${result.status}`);
      }

      this.storage.markReconciled(burn.id, result.txHash);
      console.log(`[reconciler] reconcile_burn SUCCESS — tx ${result.txHash}`);
    } catch (err) {
      console.error(`[reconciler] reconcile_burn FAILED for burn ${burn.id}:`, err);
      // Leave reconciled=false so retryPending() picks it up on next start
    }
  }
}
