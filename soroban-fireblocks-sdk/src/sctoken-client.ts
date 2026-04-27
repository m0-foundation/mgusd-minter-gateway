import { Address, Horizon, scValToNative } from "@stellar/stellar-sdk";
import { SorobanFireblocksClient } from "./client";
import { assertIssuerNotContaminated } from "./deploy-checks";
import { addressToScVal, addressVecToScVal, i128ToScVal, u32ToScVal } from "./scval-helpers";
import {
  MAX_BATCH_SIZE,
  BatchBlockUsersParams,
  BlockUserParams,
  BurnParams,
  ClaimYieldParams,
  DeployFullParams,
  DeployFullResult,
  ForceTransferParams,
  MintParams,
  QueryParams,
  ReconcileBurnParams,
  SetMinterParams,
  SetRateParams,
} from "./sctoken-types";
import { InvokeContractResult } from "./types";

export class SctokenFireblocksClient extends SorobanFireblocksClient {
  async mint(params: MintParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "mint",
      args: [addressToScVal(params.caller), addressToScVal(params.to), i128ToScVal(params.amount)],
    });
  }

  async burn(params: BurnParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "burn",
      args: [addressToScVal(params.caller), addressToScVal(params.from), i128ToScVal(params.amount)],
    });
  }

  async setRate(params: SetRateParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_rate",
      args: [addressToScVal(params.caller), u32ToScVal(params.rateBps)],
    });
  }

  async setMinter(params: SetMinterParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_minter",
      args: [addressToScVal(params.newMinter)],
    });
  }

  async blockUser(params: BlockUserParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "block_user",
      args: [addressToScVal(params.user), addressToScVal(params.operator)],
    });
  }

  async unblockUser(params: BlockUserParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "unblock_user",
      args: [addressToScVal(params.user), addressToScVal(params.operator)],
    });
  }

  async batchBlockUsers(params: BatchBlockUsersParams): Promise<InvokeContractResult> {
    if (params.users.length === 0) {
      throw new Error("batchBlockUsers: users array must not be empty");
    }
    if (params.users.length > MAX_BATCH_SIZE) {
      throw new Error(`batchBlockUsers: users array exceeds MAX_BATCH_SIZE (${MAX_BATCH_SIZE})`);
    }
    return this.invokeContract({
      contractId: params.contractId,
      method: "batch_block_users",
      args: [addressVecToScVal(params.users), addressToScVal(params.operator)],
    });
  }

  async batchUnblockUsers(params: BatchBlockUsersParams): Promise<InvokeContractResult> {
    if (params.users.length === 0) {
      throw new Error("batchUnblockUsers: users array must not be empty");
    }
    if (params.users.length > MAX_BATCH_SIZE) {
      throw new Error(`batchUnblockUsers: users array exceeds MAX_BATCH_SIZE (${MAX_BATCH_SIZE})`);
    }
    return this.invokeContract({
      contractId: params.contractId,
      method: "batch_unblock_users",
      args: [addressVecToScVal(params.users), addressToScVal(params.operator)],
    });
  }

  async forceTransfer(params: ForceTransferParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "force_transfer",
      args: [
        addressToScVal(params.caller),
        addressToScVal(params.from),
        addressToScVal(params.to),
        i128ToScVal(params.amount),
      ],
    });
  }

  async reconcileBurn(params: ReconcileBurnParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "reconcile_burn",
      args: [i128ToScVal(params.amount)],
    });
  }

  async claimYield(params: ClaimYieldParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "claim_yield",
      args: [addressToScVal(params.caller)],
    });
  }

  // View functions — read-only, executed via simulation (no signing required)

  async queryAdmin(params: QueryParams): Promise<string> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "admin" });
    if (!retval) throw new Error("admin returned no value");
    return Address.fromScVal(retval).toString();
  }

  async querySacToken(params: QueryParams): Promise<string> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "sac_token" });
    if (!retval) throw new Error("sac_token returned no value");
    return Address.fromScVal(retval).toString();
  }

  async queryMinter(params: QueryParams): Promise<string> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "minter" });
    if (!retval) throw new Error("minter returned no value");
    return Address.fromScVal(retval).toString();
  }

  async queryYieldRecipient(params: QueryParams): Promise<string> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "yield_recipient" });
    if (!retval) throw new Error("yield_recipient returned no value");
    return Address.fromScVal(retval).toString();
  }

  async queryYieldRecipientManager(params: QueryParams): Promise<string> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "yield_recipient_manager" });
    if (!retval) throw new Error("yield_recipient_manager returned no value");
    return Address.fromScVal(retval).toString();
  }

  async queryForcedTransferManager(params: QueryParams): Promise<string> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "forced_transfer_manager" });
    if (!retval) throw new Error("forced_transfer_manager returned no value");
    return Address.fromScVal(retval).toString();
  }

  async queryIsBlocker(params: QueryParams & { account: string }): Promise<boolean> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "is_blocker",
      args: [addressToScVal(params.account)],
    });
    if (!retval) throw new Error("is_blocker returned no value");
    return scValToNative(retval) as boolean;
  }

  async addBlocker(params: QueryParams & { newBlocker: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "add_blocker",
      args: [addressToScVal(params.newBlocker)],
    });
  }

  async removeBlocker(params: QueryParams & { blocker: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "remove_blocker",
      args: [addressToScVal(params.blocker)],
    });
  }

  async queryBlocked(params: QueryParams & { account: string }): Promise<boolean> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "blocked",
      args: [addressToScVal(params.account)],
    });
    if (!retval) throw new Error("blocked returned no value");
    return scValToNative(retval) as boolean;
  }

  async queryBalance(params: QueryParams & { id: string }): Promise<bigint> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "balance",
      args: [addressToScVal(params.id)],
    });
    if (!retval) throw new Error("balance returned no value");
    return scValToNative(retval) as bigint;
  }

  async queryTotalSupply(params: QueryParams): Promise<bigint> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "total_supply" });
    if (!retval) throw new Error("total_supply returned no value");
    return scValToNative(retval) as bigint;
  }

  async queryTotalPrincipal(params: QueryParams): Promise<bigint> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "total_principal" });
    if (!retval) throw new Error("total_principal returned no value");
    return scValToNative(retval) as bigint;
  }

  async queryAccruedYield(params: QueryParams): Promise<bigint> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "accrued_yield" });
    if (!retval) throw new Error("accrued_yield returned no value");
    return scValToNative(retval) as bigint;
  }

  async queryCurrentIndex(params: QueryParams): Promise<bigint> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "current_index" });
    if (!retval) throw new Error("current_index returned no value");
    return scValToNative(retval) as bigint;
  }

  async queryLatestIndex(params: QueryParams): Promise<bigint> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "latest_index" });
    if (!retval) throw new Error("latest_index returned no value");
    return scValToNative(retval) as bigint;
  }

  async queryInterestRate(params: QueryParams): Promise<number> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "interest_rate" });
    if (!retval) throw new Error("interest_rate returned no value");
    return scValToNative(retval) as number;
  }

  async deployFull(params: DeployFullParams): Promise<DeployFullResult> {
    // Step 0: Refuse to deploy if any pre-flag trustline exists on the
    // issuer for this asset. Anything observed here is pre-flag by
    // definition (the AUTH_CLAWBACK_ENABLED flag is set in step 1, below)
    // and would be permanently unclawbackable. See audit STEL1-6.
    console.log("Step 0/5: Checking issuer for pre-flag trustline contamination...");
    const horizon = new Horizon.Server(this.config.horizonUrl);
    await assertIssuerNotContaminated(horizon, params.assetCode, params.assetIssuer);
    console.log("  Issuer is clean — no pre-existing trustlines or claimable balances");

    // Step 1: Configure issuer flags (AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED — clawback enabled is required for burn)
    console.log("Step 1/5: Configuring issuer flags...");
    const issuerResult = await this.configureIssuer();
    if (issuerResult.status !== "SUCCESS") {
      throw new Error(`configureIssuer failed (tx: ${issuerResult.txHash})`);
    }
    console.log(`  Issuer configured (ledger: ${issuerResult.ledger})`);

    // Step 2: Deploy SAC (Stellar Asset Contract)
    console.log("Step 2/5: Deploying SAC...");
    const sacResult = await this.deploySac({
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
    });
    if (sacResult.status !== "SUCCESS" || !sacResult.sacContractId) {
      throw new Error(`deploySac failed (tx: ${sacResult.txHash})`);
    }
    console.log(`  SAC deployed: ${sacResult.sacContractId}`);

    // Step 3: Upload WASM
    console.log("Step 3/5: Uploading WASM...");
    const wasmResult = await this.uploadWasm({ wasm: params.wasm });
    if (wasmResult.status !== "SUCCESS" || !wasmResult.wasmHash) {
      throw new Error(`uploadWasm failed (tx: ${wasmResult.txHash})`);
    }
    console.log(`  WASM uploaded: ${wasmResult.wasmHash}`);

    // Step 4: Deploy wrapper contract with all 7 constructor args
    console.log("Step 4/5: Deploying wrapper contract...");
    const deployResult = await this.deployContract({
      wasmHash: Buffer.from(wasmResult.wasmHash, "hex"),
      constructorArgs: [
        addressToScVal(sacResult.sacContractId),
        addressToScVal(params.admin),
        addressToScVal(params.minter),
        addressToScVal(params.yieldRecipientManager),
        addressToScVal(params.yieldRecipient),
        addressToScVal(params.forcedTransferManager),
        addressToScVal(params.blocker),
        addressToScVal(params.pauser),
      ],
    });
    if (deployResult.status !== "SUCCESS" || !deployResult.contractId) {
      throw new Error(`deployContract failed (tx: ${deployResult.txHash})`);
    }
    console.log(`  Wrapper deployed: ${deployResult.contractId}`);

    // Step 5: Transfer SAC admin to the wrapper contract
    console.log("Step 5/5: Transferring SAC admin to wrapper...");
    const setAdminResult = await this.invokeContract({
      contractId: sacResult.sacContractId,
      method: "set_admin",
      args: [addressToScVal(deployResult.contractId)],
    });
    if (setAdminResult.status !== "SUCCESS") {
      throw new Error(`set_admin failed (tx: ${setAdminResult.txHash})`);
    }
    console.log(`  SAC admin transferred to wrapper`);

    return {
      sacContractId: sacResult.sacContractId,
      wasmHash: wasmResult.wasmHash,
      wrapperContractId: deployResult.contractId,
    };
  }
}
