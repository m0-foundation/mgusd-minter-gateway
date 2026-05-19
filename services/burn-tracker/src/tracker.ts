import { Address, nativeToScVal, scValToNative, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { Config } from "./config";
import { Reconciler } from "./reconciler";
import { Storage } from "./storage";
import { BurnRecord } from "./types";

const SAC_POLL_INTERVAL_MS = 6_000;

function stroopsToAmount(stroops: bigint): string {
  const UNIT = 10_000_000n;
  const whole = stroops / UNIT;
  const frac = stroops % UNIT;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

export class BurnTracker {
  private readonly rpc: SorobanRpc.Server;
  private readonly burnTopicXdr: string;

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly reconciler: Reconciler,
  ) {
    this.rpc = new SorobanRpc.Server(config.sorobanRpcUrl);
    this.burnTopicXdr = nativeToScVal("burn", { type: "symbol" }).toXDR("base64");
  }

  async run(): Promise<void> {
    console.log(`[burn-tracker] Asset: ${this.config.assetCode}:${this.config.assetIssuer}`);
    console.log(`[burn-tracker] SAC:   ${this.config.sacContractId}`);
    console.log(`[burn-tracker] Known burns so far: ${(await this.storage.getBurns()).length}`);

    const { sequence: latestLedger } = await this.rpc.getLatestLedger();

    const loops = [
      this.backfillSacEvents(latestLedger),
      this.pollSacEvents(latestLedger),
    ];
    if (!this.config.dryRun) {
      loops.push(this.retryPendingLoop());
    }

    await Promise.all(loops);
  }

  private async retryPendingLoop(): Promise<void> {
    while (true) {
      try {
        await this.reconciler.retryPending();
      } catch (err) {
        console.error("[burn-tracker] retryPending error:", err);
      }
      await new Promise((r) => setTimeout(r, this.config.retryPendingIntervalMs));
    }
  }

  private async backfillSacEvents(latestLedger: number): Promise<void> {
    const probe = await this.rpc.getEvents({ filters: this.sacEventFilters(), startLedger: latestLedger, limit: 1 });
    const oldestLedger = probe.oldestLedger;
    const savedLedger = await this.storage.getSacLedger();
    const effectiveStart = Math.max(
      savedLedger > 0 ? savedLedger : this.config.startLedger,
      oldestLedger,
    );

    console.log(`[burn-tracker] Backfill SAC events from ledger ${effectiveStart} (RPC range: ${oldestLedger}-${latestLedger})...`);
    if (this.config.startLedger < oldestLedger) {
      console.log(`[burn-tracker] WARNING: START_LEDGER (${this.config.startLedger}) is before RPC retention window (${oldestLedger}), clamped.`);
    }

    let count = 0;
    let fromLedger = effectiveStart;

    while (fromLedger <= latestLedger) {
      const toLedger = Math.min(fromLedger + 999, latestLedger);
      let eventCursor: string | undefined;

      while (true) {
        const request: SorobanRpc.Api.GetEventsRequest = eventCursor
          ? { filters: this.sacEventFilters(), cursor: eventCursor, limit: 200 }
          : { filters: this.sacEventFilters(), startLedger: fromLedger, endLedger: toLedger, limit: 200 };

        const response = await this.rpc.getEvents(request);
        console.log(`[burn-tracker] SAC events ledger ${fromLedger}-${toLedger}: ${response.events.length} event(s)`);

        for (const event of this.extractDirectBurns(response.events)) {
          console.log(`[burn-tracker]   sac event ${event.id} ledger=${event.ledger} txHash=${event.txHash}`);
          const burn = this.sacEventToRecord(event);
          if (burn) {
            count++;
            console.log(`[burn-tracker] Burn: ${burn.amount} from ${burn.from} tx ${burn.txHash}`);
            await this.reconciler.reconcile(burn);
          }
        }

        if (response.events.length < 200) break;
        eventCursor = response.cursor;
      }

      await this.storage.advanceSacLedger(toLedger);
      fromLedger = toLedger + 1;
    }

    console.log(`[burn-tracker] Backfill SAC events complete — ${count} burn(s).`);
  }

  private async pollSacEvents(fromLedger: number): Promise<void> {
    console.log(`[burn-tracker] Polling SAC events from ledger ${fromLedger}...`);
    while (true) {
      await new Promise((r) => setTimeout(r, SAC_POLL_INTERVAL_MS));
      try {
        fromLedger = Math.max(await this.storage.getSacLedger() + 1, fromLedger);
        let eventCursor: string | undefined;

        while (true) {
          const request: SorobanRpc.Api.GetEventsRequest = eventCursor
            ? { filters: this.sacEventFilters(), cursor: eventCursor, limit: 200 }
            : { filters: this.sacEventFilters(), startLedger: fromLedger, limit: 200 };

          const response = await this.rpc.getEvents(request);

          if (response.events.length > 0) {
            console.log(`[burn-tracker] SAC poll: ${response.events.length} event(s) ledger ${fromLedger}-${response.latestLedger}`);
          }

          for (const event of this.extractDirectBurns(response.events)) {
            console.log(`[burn-tracker]   sac event ${event.id} ledger=${event.ledger} txHash=${event.txHash}`);
            const burn = this.sacEventToRecord(event);
            if (burn) {
              console.log(`[burn-tracker] Burn: ${burn.amount} from ${burn.from} tx ${burn.txHash}`);
              this.reconciler.reconcile(burn).catch((err) => {
                console.error("[burn-tracker] Reconcile error:", err);
              });
            }
          }

          await this.storage.advanceSacLedger(response.latestLedger);

          if (response.events.length < 200) break;
          eventCursor = response.cursor;
        }
      } catch (err) {
        console.error("[burn-tracker] SAC poll error:", err);
      }
    }
  }

  /**
   * We reconcile only SAC burns whose txHash has no corresponding wrapper burn.
   */
  private sacEventFilters(): SorobanRpc.Api.EventFilter[] {
    return [
      { type: "contract", contractIds: [this.config.sacContractId] },
      { type: "contract", contractIds: [this.config.contractId] },
    ];
  }

  private isBurnEvent(event: SorobanRpc.Api.EventResponse): boolean {
    try {
      return event.topic[0].toXDR("base64") === this.burnTopicXdr;
    } catch {
      return false;
    }
  }

  private extractDirectBurns(events: SorobanRpc.Api.EventResponse[]): SorobanRpc.Api.EventResponse[] {
    const wrapperBurnTxHashes = new Set(
      events
        .filter((e) => e.contractId?.toString() === this.config.contractId && this.isBurnEvent(e))
        .map((e) => e.txHash),
    );

    return events.filter(
      (e) =>
        e.contractId?.toString() === this.config.sacContractId &&
        this.isBurnEvent(e) &&
        !wrapperBurnTxHashes.has(e.txHash),
    );
  }

  private sacEventToRecord(event: SorobanRpc.Api.EventResponse): BurnRecord | null {
    try {
      const from = Address.fromScVal(event.topic[1]).toString();
      const amountRaw = scValToNative(event.value) as bigint;
      const amount = stroopsToAmount(amountRaw);

      return {
        operationId: event.id,
        txHash: event.txHash,
        operationIndex: event.operationIndex,
        ledger: event.ledger,
        timestamp: event.ledgerClosedAt,
        from,
        amount,
        reconciled: false,
      };
    } catch (err) {
      console.error("[burn-tracker] Failed to parse SAC event:", event.id, err);
      return null;
    }
  }
}
