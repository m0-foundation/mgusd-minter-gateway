import { Horizon } from "@stellar/stellar-sdk";
import { IssuerContaminatedError } from "./errors";

/**
 * Pre-deploy check: refuses to proceed if the (assetCode, assetIssuer) pair
 * already has any prior on-chain footprint — trustlines, claimable
 * balances, liquidity pools, or contract holders. See audit STEL1-6:
 * trustlines created before `AUTH_CLAWBACK_ENABLED` is set on the issuer
 * are permanently unclawbackable. The flag is set in step 1 of
 * `deployFull`, so any footprint observed here is pre-flag by definition.
 *
 * Operators who hit this should provision a fresh issuer keypair (the
 * cleanest fix); rotating an already-contaminated issuer requires
 * redeploying the asset and migrating supply.
 *
 * @param horizon  Horizon server (must match the network the issuer lives on).
 * @param assetCode  Stellar asset code (e.g. "MGUSD").
 * @param assetIssuer  Issuer pubkey (G...).
 *
 * @throws IssuerContaminatedError if any prior footprint is found.
 */
export async function assertIssuerNotContaminated(
  horizon: Horizon.Server,
  assetCode: string,
  assetIssuer: string,
): Promise<void> {
  const result = await horizon
    .assets()
    .forCode(assetCode)
    .forIssuer(assetIssuer)
    .call();

  const record = result.records[0];
  if (!record) {
    // Asset is unknown to Horizon — nobody has ever opened a trustline.
    return;
  }

  const accounts = record.accounts;
  const counts = {
    trustlines:
      accounts.authorized +
      accounts.authorized_to_maintain_liabilities +
      accounts.unauthorized,
    claimableBalances: record.num_claimable_balances,
    liquidityPools: record.num_liquidity_pools,
    contracts: record.num_contracts,
  };

  const total =
    counts.trustlines + counts.claimableBalances + counts.liquidityPools + counts.contracts;

  if (total > 0) {
    throw new IssuerContaminatedError(
      `Issuer ${assetIssuer} has prior on-chain footprint for asset ${assetCode}: ` +
        `${counts.trustlines} trustline(s), ${counts.claimableBalances} claimable balance(s), ` +
        `${counts.liquidityPools} liquidity pool(s), ${counts.contracts} contract holder(s). ` +
        `Trustlines opened before AUTH_CLAWBACK_ENABLED is set are permanently ` +
        `unclawbackable (audit STEL1-6). Provision a fresh issuer keypair before deploy.`,
      assetCode,
      assetIssuer,
      counts,
    );
  }
}
