import { SctokenFireblocksClient } from "soroban-fireblocks-sdk";
import { Config } from "./config";
import { notifyBurn } from "./slack";
import { Storage } from "./storage";
import { BurnRecord } from "./types";

const STROOPS_PER_UNIT = 10_000_000n;

function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fracPadded);
}

export class Reconciler {
  private readonly client: SctokenFireblocksClient | null;

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
  ) {
    if (config.dryRun) {
      this.client = null;
      console.log("[reconciler] DRY_RUN mode — burns will be stored but reconcile_burn will not be submitted");
    } else {
      this.client = new SctokenFireblocksClient({
        sorobanRpcUrl: config.sorobanRpcUrl,
        horizonUrl: config.horizonUrl,
        networkPassphrase: config.networkPassphrase,
        fireblocksApiKey: config.fireblocksApiKey,
        fireblocksSecretKey: config.fireblocksSecretKey,
        fireblocksVaultAccountId: config.fireblocksVaultAccountId,
        fireblocksAssetId: config.fireblocksAssetId,
        fireblocksBasePath: config.fireblocksBasePath,
        sourcePublicKey: config.adminPublicKey,
      });
    }
  }

  async retryPending(): Promise<void> {
    const pending = await this.storage.getPendingReconciliation();
    if (pending.length === 0) return;
    console.log(`[reconciler] Retrying ${pending.length} pending reconciliation(s)...`);
    for (const burn of pending) {
      await this.reconcileExisting(burn);
    }
  }

  async reconcile(burn: BurnRecord): Promise<void> {
    if (await this.storage.hasReconciledBurn(burn.txHash, burn.operationIndex)) {
      return;
    }

    if (this.config.slackWebhookUrl) {
      await notifyBurn(this.config.slackWebhookUrl, burn);
    }

    if (this.config.dryRun) {
      await this.storage.addBurn(burn);
      console.log(`[reconciler] DRY_RUN — stored burn ${burn.txHash} (reconcile_burn skipped)`);
      return;
    }

    const amount = toStroops(burn.amount);
    console.log(
      `[reconciler] Calling reconcile_burn: ${burn.amount} (${amount} stroops) — burn tx ${burn.txHash}`,
    );

    try {
      const result = await this.client!.reconcileBurn({
        contractId: this.config.contractId,
        amount,
      });

      if (result.status !== "SUCCESS") {
        throw new Error(`reconcile_burn tx ${result.txHash} landed with status ${result.status}`);
      }

      await this.storage.addBurn(burn, result.txHash);
      console.log(`[reconciler] reconcile_burn SUCCESS — tx ${result.txHash}`);
    } catch (err) {
      console.error(`[reconciler] reconcile_burn FAILED for burn ${burn.txHash}:`, err);
      await this.storage.addBurn(burn);
    }
  }

  private async reconcileExisting(burn: BurnRecord): Promise<void> {
    const amount = toStroops(burn.amount);
    console.log(
      `[reconciler] Retrying reconcile_burn: ${burn.amount} (${amount} stroops) — burn tx ${burn.txHash}`,
    );

    try {
      const result = await this.client!.reconcileBurn({
        contractId: this.config.contractId,
        amount,
      });

      if (result.status !== "SUCCESS") {
        throw new Error(`reconcile_burn tx ${result.txHash} landed with status ${result.status}`);
      }

      await this.storage.markReconciled(burn.txHash, burn.operationIndex, result.txHash);
      console.log(`[reconciler] reconcile_burn SUCCESS — tx ${result.txHash}`);
    } catch (err) {
      console.error(`[reconciler] reconcile_burn FAILED for burn ${burn.txHash}:`, err);
    }
  }
}
