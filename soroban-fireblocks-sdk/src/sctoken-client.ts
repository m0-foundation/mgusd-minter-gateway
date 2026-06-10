import { createHash } from "crypto";
import { Address, Horizon, scValToNative } from "@stellar/stellar-sdk";
import { SorobanFireblocksClient } from "./client";
import { SorobanKeypairClient } from "./keypair-client";
import { WasmHashMismatchError } from "./errors";
import { assertIssuerNotContaminated } from "./deploy-checks";
import { buildFireblocksNote } from "./fireblocks-note";
import { addressToScVal, addressVecToScVal, bytesN32ToScVal, i128ToScVal, u32ToScVal } from "./scval-helpers";

const PROTOCOL = "mintergateway";
import {
  MAX_BATCH_SIZE,
  BatchBlockUsersParams,
  BatchOnboardUsersParams,
  BlockUserParams,
  BurnParams,
  ClaimYieldParams,
  DeployFullParams,
  DeployFullResult,
  ForceTransferParams,
  MintParams,
  OnboardUserParams,
  PauseParams,
  QueryParams,
  ReconcileBurnParams,
  SetAdminParams,
  SetForcedTransferManagerParams,
  SetMinterParams,
  SetPauserParams,
  SetRateParams,
  SetYieldRecipientManagerParams,
  SetYieldRecipientParams,
  TransferSacAdminParams,
  UpgradeParams,
} from "./sctoken-types";
import { InvokeContractResult } from "./types";

export class SctokenFireblocksClient extends SorobanFireblocksClient {
  private noteFor(
    method: string,
    contractId: string,
    args?: Record<string, string | number | bigint>,
  ): string {
    return buildFireblocksNote({
      protocol: PROTOCOL,
      method,
      contract: contractId,
      caller: this.config.sourcePublicKey,
      args,
    });
  }

  async mint(params: MintParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "mint",
      args: [addressToScVal(params.caller), addressToScVal(params.to), i128ToScVal(params.amount)],
      fireblocksNote: this.noteFor("mint", params.contractId, { to: params.to, amount: params.amount }),
    });
  }

  async burn(params: BurnParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "burn",
      args: [addressToScVal(params.caller), addressToScVal(params.from), i128ToScVal(params.amount)],
      fireblocksNote: this.noteFor("burn", params.contractId, { from: params.from, amount: params.amount }),
    });
  }

  async setRate(params: SetRateParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_rate",
      args: [addressToScVal(params.caller), u32ToScVal(params.rateBps)],
      fireblocksNote: this.noteFor("set_rate", params.contractId, { rate_bps: params.rateBps }),
    });
  }

  async setMinter(params: SetMinterParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_minter",
      args: [addressToScVal(params.newMinter)],
      fireblocksNote: this.noteFor("set_minter", params.contractId, { new_minter: params.newMinter }),
    });
  }

  async setAdmin(params: SetAdminParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_admin",
      args: [addressToScVal(params.newAdmin)],
      fireblocksNote: this.noteFor("set_admin", params.contractId, { new_admin: params.newAdmin }),
    });
  }

  async setYieldRecipientManager(params: SetYieldRecipientManagerParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_yield_recipient_manager",
      args: [addressToScVal(params.newYieldRecipientManager)],
      fireblocksNote: this.noteFor("set_yield_recipient_manager", params.contractId, {
        new_yrm: params.newYieldRecipientManager,
      }),
    });
  }

  async setForcedTransferManager(params: SetForcedTransferManagerParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_forced_transfer_manager",
      args: [addressToScVal(params.newForcedTransferManager)],
      fireblocksNote: this.noteFor("set_forced_transfer_manager", params.contractId, {
        new_ftm: params.newForcedTransferManager,
      }),
    });
  }

  async setPauser(params: SetPauserParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_pauser",
      args: [addressToScVal(params.newPauser)],
      fireblocksNote: this.noteFor("set_pauser", params.contractId, { new_pauser: params.newPauser }),
    });
  }

  async setYieldRecipient(params: SetYieldRecipientParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_yield_recipient",
      args: [addressToScVal(params.caller), addressToScVal(params.newYieldRecipient)],
      fireblocksNote: this.noteFor("set_yield_recipient", params.contractId, {
        new_yield_recipient: params.newYieldRecipient,
      }),
    });
  }

  /**
   * WARNING: irreversible. After this call the wrapper contract is no longer
   * SAC admin and can no longer mint, burn, clawback, or authorize accounts.
   */
  async transferSacAdmin(params: TransferSacAdminParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "transfer_sac_admin",
      args: [addressToScVal(params.newSacAdmin)],
      fireblocksNote: this.noteFor("transfer_sac_admin", params.contractId, {
        new_sac_admin: params.newSacAdmin,
      }),
    });
  }

  async upgrade(params: UpgradeParams): Promise<InvokeContractResult> {
    const hash =
      typeof params.newWasmHash === "string" ? Buffer.from(params.newWasmHash, "hex") : params.newWasmHash;
    return this.invokeContract({
      contractId: params.contractId,
      method: "upgrade",
      args: [bytesN32ToScVal(hash)],
      fireblocksNote: this.noteFor("upgrade", params.contractId, { new_wasm_hash: hash.toString("hex") }),
    });
  }

  async pause(params: PauseParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "pause",
      args: [addressToScVal(params.caller)],
      fireblocksNote: this.noteFor("pause", params.contractId),
    });
  }

  async unpause(params: PauseParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "unpause",
      args: [addressToScVal(params.caller)],
      fireblocksNote: this.noteFor("unpause", params.contractId),
    });
  }

  async blockUser(params: BlockUserParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "block_user",
      args: [addressToScVal(params.user), addressToScVal(params.operator)],
      fireblocksNote: this.noteFor("block_user", params.contractId, { user: params.user }),
    });
  }

  async unblockUser(params: BlockUserParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "unblock_user",
      args: [addressToScVal(params.user), addressToScVal(params.operator)],
      fireblocksNote: this.noteFor("unblock_user", params.contractId, { user: params.user }),
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
      // The full address list won't fit in a Fireblocks note. Summarize as
      // count + the first/last address so approvers can sanity-check the batch.
      fireblocksNote: this.noteFor("batch_block_users", params.contractId, {
        users_count: params.users.length,
        first: params.users[0],
        last: params.users[params.users.length - 1],
      }),
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
      fireblocksNote: this.noteFor("batch_unblock_users", params.contractId, {
        users_count: params.users.length,
        first: params.users[0],
        last: params.users[params.users.length - 1],
      }),
    });
  }

  async onboardUser(params: OnboardUserParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "onboard_user",
      args: [addressToScVal(params.user), addressToScVal(params.operator)],
      fireblocksNote: this.noteFor("onboard_user", params.contractId, { user: params.user }),
    });
  }

  async batchOnboardUsers(params: BatchOnboardUsersParams): Promise<InvokeContractResult> {
    if (params.users.length === 0) {
      throw new Error("batchOnboardUsers: users array must not be empty");
    }
    if (params.users.length > MAX_BATCH_SIZE) {
      throw new Error(`batchOnboardUsers: users array exceeds MAX_BATCH_SIZE (${MAX_BATCH_SIZE})`);
    }
    return this.invokeContract({
      contractId: params.contractId,
      method: "batch_onboard_users",
      args: [addressVecToScVal(params.users), addressToScVal(params.operator)],
      fireblocksNote: this.noteFor("batch_onboard_users", params.contractId, {
        users_count: params.users.length,
        first: params.users[0],
        last: params.users[params.users.length - 1],
      }),
    });
  }

  async addOnboarder(params: QueryParams & { addr: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "add_onboarder",
      args: [addressToScVal(params.addr)],
      fireblocksNote: this.noteFor("add_onboarder", params.contractId, { addr: params.addr }),
    });
  }

  async removeOnboarder(params: QueryParams & { addr: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "remove_onboarder",
      args: [addressToScVal(params.addr)],
      fireblocksNote: this.noteFor("remove_onboarder", params.contractId, { addr: params.addr }),
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
      fireblocksNote: this.noteFor("force_transfer", params.contractId, {
        from: params.from,
        to: params.to,
        amount: params.amount,
      }),
    });
  }

  async reconcileBurn(params: ReconcileBurnParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "reconcile_burn",
      args: [i128ToScVal(params.amount)],
      fireblocksNote: this.noteFor("reconcile_burn", params.contractId, { amount: params.amount }),
    });
  }

  async claimYield(params: ClaimYieldParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "claim_yield",
      args: [addressToScVal(params.caller)],
      fireblocksNote: this.noteFor("claim_yield", params.contractId),
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

  async queryIsBlockOperator(params: QueryParams & { account: string }): Promise<boolean> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "is_block_operator",
      args: [addressToScVal(params.account)],
    });
    if (!retval) throw new Error("is_block_operator returned no value");
    return scValToNative(retval) as boolean;
  }

  async queryIsUnblockOperator(params: QueryParams & { account: string }): Promise<boolean> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "is_unblock_operator",
      args: [addressToScVal(params.account)],
    });
    if (!retval) throw new Error("is_unblock_operator returned no value");
    return scValToNative(retval) as boolean;
  }

  async addBlockOperator(params: QueryParams & { addr: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "add_block_operator",
      args: [addressToScVal(params.addr)],
      fireblocksNote: this.noteFor("add_block_operator", params.contractId, { addr: params.addr }),
    });
  }

  async removeBlockOperator(params: QueryParams & { addr: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "remove_block_operator",
      args: [addressToScVal(params.addr)],
      fireblocksNote: this.noteFor("remove_block_operator", params.contractId, { addr: params.addr }),
    });
  }

  async addUnblockOperator(params: QueryParams & { addr: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "add_unblock_operator",
      args: [addressToScVal(params.addr)],
      fireblocksNote: this.noteFor("add_unblock_operator", params.contractId, { addr: params.addr }),
    });
  }

  async removeUnblockOperator(params: QueryParams & { addr: string }): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "remove_unblock_operator",
      args: [addressToScVal(params.addr)],
      fireblocksNote: this.noteFor("remove_unblock_operator", params.contractId, { addr: params.addr }),
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

  async queryIsOnBlockList(params: QueryParams & { account: string }): Promise<boolean> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "is_on_block_list",
      args: [addressToScVal(params.account)],
    });
    if (!retval) throw new Error("is_on_block_list returned no value");
    return scValToNative(retval) as boolean;
  }

  async queryIsOnboarded(params: QueryParams & { account: string }): Promise<boolean> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "is_onboarded",
      args: [addressToScVal(params.account)],
    });
    if (!retval) throw new Error("is_onboarded returned no value");
    return scValToNative(retval) as boolean;
  }

  async queryIsOnboarder(params: QueryParams & { account: string }): Promise<boolean> {
    const retval = await this.simulateView({
      contractId: params.contractId,
      method: "is_onboarder",
      args: [addressToScVal(params.account)],
    });
    if (!retval) throw new Error("is_onboarder returned no value");
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

  async queryPaused(params: QueryParams): Promise<boolean> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "paused" });
    if (!retval) throw new Error("paused returned no value");
    return scValToNative(retval) as boolean;
  }

  async queryPauser(params: QueryParams): Promise<string> {
    const retval = await this.simulateView({ contractId: params.contractId, method: "pauser" });
    if (!retval) throw new Error("pauser returned no value");
    return Address.fromScVal(retval).toString();
  }

  async deployFull(params: DeployFullParams): Promise<DeployFullResult> {
    // Build the local-deployer signing client up front. The deployer signs
    // steps 2-4 (protocol-permissionless ops); this client (the issuer
    // Fireblocks vault) signs steps 1 + 5 (the ops that actually need
    // issuer authority). Mirrors the bash deploy-pipeline.sh signing split.
    const deployerClient = new SorobanKeypairClient({
      sorobanRpcUrl: this.config.sorobanRpcUrl,
      networkPassphrase: this.config.networkPassphrase,
      keypair: params.deployerKeypair,
    });

    // Step 0: Refuse to deploy if the issuer has any prior on-chain
    // footprint for this asset (trustlines, claimable balances, pools,
    // contract holders). Stellar binds clawback eligibility at trustline-
    // creation time, so anything that exists right now — before step 1
    // sets AUTH_CLAWBACK_ENABLED — is pre-flag and permanently
    // unclawbackable. The wrapper's burn / force_transfer / freeze paths
    // all delegate to SAC clawback, so a single pre-flag holder that ever
    // gets minted to is an irreversible compliance hole. See audit
    // STEL1-6 and the long-form rationale in `assertIssuerNotContaminated`.
    console.log("Step 0/5: Checking issuer for pre-flag trustline contamination...");
    const horizon = new Horizon.Server(this.config.horizonUrl);
    await assertIssuerNotContaminated(horizon, params.assetCode, params.assetIssuer);
    console.log("  Issuer is clean — no pre-existing trustlines or claimable balances");

    // Step 1: [ISSUER] Configure issuer flags (AUTH_REQUIRED + AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED).
    // Signed by the issuer Fireblocks vault — requires issuer authority. Also
    // sets `home_domain` (when supplied) in the same setOptions op, so SEP-1
    // metadata at https://<home_domain>/.well-known/stellar.toml is reachable
    // immediately after step 1 lands.
    console.log("Step 1/5: [ISSUER] Configuring issuer flags...");
    const issuerResult = await this.configureIssuer({ homeDomain: params.homeDomain });
    if (issuerResult.status !== "SUCCESS") {
      throw new Error(`configureIssuer failed (tx: ${issuerResult.txHash})`);
    }
    console.log(`  Issuer configured (ledger: ${issuerResult.ledger})${params.homeDomain ? `, home_domain=${params.homeDomain}` : ""}`);

    // Step 2: [DEPLOYER] Deploy SAC. Protocol-permissionless — signed by
    // the local deployer keypair, no Fireblocks round-trip.
    console.log("Step 2/5: [DEPLOYER] Deploying SAC...");
    const sacResult = await deployerClient.deploySac({
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
    });
    if (sacResult.status !== "SUCCESS" || !sacResult.sacContractId) {
      throw new Error(`deploySac failed (tx: ${sacResult.txHash})`);
    }
    console.log(`  SAC deployed: ${sacResult.sacContractId}`);

    // Step 3: [DEPLOYER] Upload WASM. Protocol-permissionless.
    console.log("Step 3/5: [DEPLOYER] Uploading WASM...");
    const wasmResult = await deployerClient.uploadWasm({ wasm: params.wasm });
    if (wasmResult.status !== "SUCCESS" || !wasmResult.wasmHash) {
      throw new Error(`uploadWasm failed (tx: ${wasmResult.txHash})`);
    }
    console.log(`  WASM uploaded: ${wasmResult.wasmHash}`);

    // Defense-in-depth: re-derive the expected hash from local bytes and refuse
    // to feed anything else into step 4. uploadWasm already enforces this, but
    // pinning it again here keeps the data flow into createCustomContract
    // self-evident on inspection.
    const localWasmHash = createHash("sha256").update(params.wasm).digest();
    if (wasmResult.wasmHash !== localWasmHash.toString("hex")) {
      throw new WasmHashMismatchError(
        `deployFull refusing to deploy: uploadWasm returned hash ${wasmResult.wasmHash} but sha256(params.wasm)=${localWasmHash.toString("hex")}`,
        localWasmHash.toString("hex"),
        wasmResult.wasmHash,
        wasmResult.txHash,
      );
    }

    // Step 4: [DEPLOYER] Deploy wrapper — SAC + eight role addresses (constructor).
    // The deployer holds the contract for one ledger before step 5 hands SAC
    // admin over; it never holds any role on the wrapper itself (constructor
    // wires admin/minter/etc. to the operator-supplied role pubkeys).
    console.log("Step 4/5: [DEPLOYER] Deploying wrapper contract...");
    const deployResult = await deployerClient.deployContract({
      wasmHash: localWasmHash,
      constructorArgs: [
        addressToScVal(sacResult.sacContractId),
        addressToScVal(params.admin),
        addressToScVal(params.minter),
        addressToScVal(params.yieldRecipientManager),
        addressToScVal(params.yieldRecipient),
        addressToScVal(params.forcedTransferManager),
        addressToScVal(params.blockOperator),
        addressToScVal(params.unblockOperator),
        addressToScVal(params.pauser),
        addressToScVal(params.onboarder),
      ],
    });
    if (deployResult.status !== "SUCCESS" || !deployResult.contractId) {
      throw new Error(`deployContract failed (tx: ${deployResult.txHash})`);
    }
    console.log(`  Wrapper deployed: ${deployResult.contractId}`);

    // Step 5: [ISSUER] Transfer SAC admin to the wrapper contract.
    // Signed by the issuer Fireblocks vault — the issuer is the initial SAC
    // admin (from step 2's SAC deploy under issuer auth), and only the
    // current SAC admin can call set_admin.
    console.log("Step 5/5: [ISSUER] Transferring SAC admin to wrapper...");
    const setAdminResult = await this.invokeContract({
      contractId: sacResult.sacContractId,
      method: "set_admin",
      args: [addressToScVal(deployResult.contractId)],
      fireblocksNote: buildFireblocksNote({
        protocol: "sac",
        method: "set_admin",
        contract: sacResult.sacContractId,
        caller: this.config.sourcePublicKey,
        args: { new_admin: deployResult.contractId },
      }),
    });
    if (setAdminResult.status !== "SUCCESS") {
      throw new Error(`set_admin failed (tx: ${setAdminResult.txHash})`);
    }
    console.log(`  SAC admin transferred to wrapper`);

    // Post-deploy smoke test: read wrapper.admin() back and assert it equals
    // the admin pubkey we passed into the constructor. Mirrors the bash
    // deploy-pipeline.sh `smoke_test_wrapper_admin` — catches "deploy txs
    // all succeeded, but the constructor argument that landed on-chain was
    // different from what we passed" (corrupt RPC, wrong WASM, ABI drift).
    // Read-only / free; uses simulateView under the hood.
    console.log("Smoke: Verifying wrapper.admin() matches configured admin...");
    const onChainAdmin = await this.queryAdmin({ contractId: deployResult.contractId });
    if (onChainAdmin !== params.admin) {
      throw new Error(
        `Smoke test failed: wrapper.admin() = ${onChainAdmin}, ` +
          `expected ${params.admin}. The deploy txs landed but the contract ` +
          `was not initialized with the expected admin. Investigate before using.`,
      );
    }
    console.log(`  wrapper.admin() = ${onChainAdmin} ✓`);

    return {
      sacContractId: sacResult.sacContractId,
      wasmHash: wasmResult.wasmHash,
      wrapperContractId: deployResult.contractId,
    };
  }
}
