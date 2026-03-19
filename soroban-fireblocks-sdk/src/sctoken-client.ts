import { Address } from "@stellar/stellar-sdk";
import { SorobanFireblocksClient } from "./client";
import { addressToScVal, i128ToScVal, scValToI128, u32ToScVal } from "./scval-helpers";
import {
  BurnParams,
  DeployFullParams,
  DeployFullResult,
  MintParams,
  QueryAddressResult,
  QueryI128Result,
  QueryParams,
  ReconcileBurnParams,
  SetCollateralTokenParams,
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

  async queryAdmin(params: QueryParams): Promise<QueryAddressResult> {
    const result = await this.invokeContract({
      contractId: params.contractId,
      method: "admin",
    });

    if (!result.returnValue) {
      throw new Error(`queryAdmin returned no value (tx status: ${result.status})`);
    }

    const address = Address.fromScVal(result.returnValue).toString();

    return {
      address,
      txHash: result.txHash,
      ledger: result.ledger,
    };
  }

  async querySacToken(params: QueryParams): Promise<QueryAddressResult> {
    const result = await this.invokeContract({
      contractId: params.contractId,
      method: "sac_token",
    });

    if (!result.returnValue) {
      throw new Error(`querySacToken returned no value (tx status: ${result.status})`);
    }

    const address = Address.fromScVal(result.returnValue).toString();

    return {
      address,
      txHash: result.txHash,
      ledger: result.ledger,
    };
  }

  async reconcileBurn(params: ReconcileBurnParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "reconcile_burn",
      args: [i128ToScVal(params.amount), addressToScVal(params.collateralTo)],
    });
  }

  async setCollateralToken(params: SetCollateralTokenParams): Promise<InvokeContractResult> {
    return this.invokeContract({
      contractId: params.contractId,
      method: "set_collateral_token",
      args: [addressToScVal(params.collateralToken)],
    });
  }

  async queryCollateralToken(params: QueryParams): Promise<QueryAddressResult> {
    const result = await this.invokeContract({
      contractId: params.contractId,
      method: "collateral_token",
    });

    if (!result.returnValue) {
      throw new Error(`queryCollateralToken returned no value (tx status: ${result.status})`);
    }

    const address = Address.fromScVal(result.returnValue).toString();

    return {
      address,
      txHash: result.txHash,
      ledger: result.ledger,
    };
  }

  async queryCollateralBalance(params: QueryParams): Promise<QueryI128Result> {
    const result = await this.invokeContract({
      contractId: params.contractId,
      method: "collateral_balance",
    });

    if (!result.returnValue) {
      throw new Error(`queryCollateralBalance returned no value (tx status: ${result.status})`);
    }

    return {
      value: scValToI128(result.returnValue),
      txHash: result.txHash,
      ledger: result.ledger,
    };
  }

  async queryCollateralDeficit(params: QueryParams): Promise<QueryI128Result> {
    const result = await this.invokeContract({
      contractId: params.contractId,
      method: "collateral_deficit",
    });

    if (!result.returnValue) {
      throw new Error(`queryCollateralDeficit returned no value (tx status: ${result.status})`);
    }

    return {
      value: scValToI128(result.returnValue),
      txHash: result.txHash,
      ledger: result.ledger,
    };
  }

  async deployFull(params: DeployFullParams): Promise<DeployFullResult> {
    // Step 1: Configure issuer flags (AUTH_REVOCABLE + AUTH_CLAWBACK_ENABLED — clawback enabled is required for burn)
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

    // Step 4: Deploy wrapper contract with all 8 constructor args
    console.log("Step 4/5: Deploying wrapper contract...");
    const deployResult = await this.deployContract({
      wasmHash: Buffer.from(wasmResult.wasmHash, "hex"),
      constructorArgs: [
        addressToScVal(sacResult.sacContractId),
        addressToScVal(params.collateralToken),
        addressToScVal(params.admin),
        addressToScVal(params.minter),
        addressToScVal(params.yieldRecipientManager),
        addressToScVal(params.yieldRecipient),
        addressToScVal(params.forcedTransferManager),
        addressToScVal(params.distributor),
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
