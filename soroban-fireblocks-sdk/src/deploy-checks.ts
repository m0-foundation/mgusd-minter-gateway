import { Horizon } from "@stellar/stellar-sdk";
import { IssuerContaminatedError } from "./errors";

/**
 * Pre-deploy contamination check — mitigates audit finding **STEL1-6**.
 *
 * # The bug this prevents
 *
 * Stellar binds clawback eligibility to a trustline at *trustline-creation
 * time*, not at the time of clawback. When a trustline is opened, the
 * trustline's own `TRUSTLINE_CLAWBACK_ENABLED_FLAG` is set if and only if
 * the issuer has `AUTH_CLAWBACK_ENABLED` set right then. The flag is
 * sticky from that point — flipping the issuer's flag later does NOT
 * retroactively make existing trustlines clawback-eligible.
 *
 * `deployFull` only sets `AUTH_CLAWBACK_ENABLED` in step 1
 * (`configureIssuer`). Anyone who can guess (or learn) the
 * `(asset_code, issuer_pubkey)` pair before step 1 runs can submit
 * `Operation.changeTrust` and end up holding a permanently-unclawbackable
 * trustline. They need only:
 *   - the issuer pubkey (`G...`)
 *   - the asset code (typically a public ticker like `"MGUSD"`)
 * No SAC, no wrapper, no prior `setOptions` on the issuer is required.
 *
 * Pre-flag trustlines are also pre-`AUTH_REQUIRED`, so they're
 * auto-authorized at creation. The wrapper's `blocked` view returns
 * `false` for these addresses *without* `unblock_user` ever being called.
 * If such an address is ever later minted to (e.g. through normal
 * onboarding using a poisoned destination), the wrapper's `burn`,
 * `force_transfer`, and freeze paths all fail with
 * `op_not_clawback_enabled` for that holder forever. There is no on-chain
 * recovery — the only fix is to rotate to a fresh issuer (deploy a new
 * asset, migrate supply, abandon the contaminated issuer).
 *
 * # What this check does
 *
 * Queries Horizon's `/assets` endpoint for any prior on-chain footprint
 * on the `(assetCode, assetIssuer)` pair — trustlines (across all auth
 * states), claimable balances, liquidity pool participations, contract
 * holders. Any non-zero count means the issuer was touched before deploy
 * time, which is by definition pre-flag (we haven't run step 1 yet).
 * Throws `IssuerContaminatedError` and aborts `deployFull`.
 *
 * # Why this has to be a *pre-deploy* check
 *
 * No on-chain mitigation can repair an already-contaminated trustline.
 * Stellar's protocol does not expose a way to retroactively add
 * `TRUSTLINE_CLAWBACK_ENABLED_FLAG` to an existing trustline. So the
 * mitigation has to live before the issuer flag is set: refuse to
 * proceed if any prior footprint exists.
 *
 * Operationally the strongest pairing with this check is also keeping
 * the issuer pubkey secret until the moment `deployFull` runs (generate
 * keypair → fund → immediately deploy), so the contamination window is
 * effectively zero seconds.
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
