import { Horizon } from "@stellar/stellar-sdk";
import { assertIssuerNotContaminated } from "../../src/deploy-checks";
import { IssuerContaminatedError } from "../../src/errors";

const ASSET_CODE = "MGUSD";
const ISSUER = "GABC2OAOZG5ZA47TY7AAYHC3DKFS6V5BJ7XNRAGJWZD5ZG5DKDXZQEXAMPLE";

interface AssetRecord {
  accounts: {
    authorized: number;
    authorized_to_maintain_liabilities: number;
    unauthorized: number;
  };
  num_claimable_balances: number;
  num_liquidity_pools: number;
  num_contracts: number;
}

function makeRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    accounts: {
      authorized: 0,
      authorized_to_maintain_liabilities: 0,
      unauthorized: 0,
      ...(overrides.accounts ?? {}),
    },
    num_claimable_balances: overrides.num_claimable_balances ?? 0,
    num_liquidity_pools: overrides.num_liquidity_pools ?? 0,
    num_contracts: overrides.num_contracts ?? 0,
  };
}

function makeHorizon(records: AssetRecord[]): Horizon.Server {
  const callBuilder = {
    forCode: jest.fn().mockReturnThis(),
    forIssuer: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records }),
  };
  return {
    assets: jest.fn().mockReturnValue(callBuilder),
  } as unknown as Horizon.Server;
}

describe("assertIssuerNotContaminated", () => {
  it("resolves cleanly when Horizon has no record for the asset", async () => {
    const horizon = makeHorizon([]);
    await expect(
      assertIssuerNotContaminated(horizon, ASSET_CODE, ISSUER),
    ).resolves.toBeUndefined();
  });

  it("resolves when all footprint counts are zero", async () => {
    const horizon = makeHorizon([makeRecord()]);
    await expect(
      assertIssuerNotContaminated(horizon, ASSET_CODE, ISSUER),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["authorized trustlines", makeRecord({ accounts: { authorized: 1, authorized_to_maintain_liabilities: 0, unauthorized: 0 } }), { trustlines: 1 }],
    ["authorized_to_maintain_liabilities trustlines", makeRecord({ accounts: { authorized: 0, authorized_to_maintain_liabilities: 2, unauthorized: 0 } }), { trustlines: 2 }],
    ["unauthorized trustlines", makeRecord({ accounts: { authorized: 0, authorized_to_maintain_liabilities: 0, unauthorized: 3 } }), { trustlines: 3 }],
    ["claimable balances", makeRecord({ num_claimable_balances: 4 }), { claimableBalances: 4 }],
    ["liquidity pools", makeRecord({ num_liquidity_pools: 5 }), { liquidityPools: 5 }],
    ["contract holders", makeRecord({ num_contracts: 6 }), { contracts: 6 }],
  ] as const)(
    "throws IssuerContaminatedError when issuer has %s",
    async (_label, record, expected) => {
      const horizon = makeHorizon([record]);
      await expect(
        assertIssuerNotContaminated(horizon, ASSET_CODE, ISSUER),
      ).rejects.toMatchObject({
        name: "IssuerContaminatedError",
        assetCode: ASSET_CODE,
        assetIssuer: ISSUER,
        counts: expect.objectContaining(expected),
      });
    },
  );

  it("aggregates counts across categories in the error", async () => {
    const horizon = makeHorizon([
      makeRecord({
        accounts: { authorized: 1, authorized_to_maintain_liabilities: 1, unauthorized: 1 },
        num_claimable_balances: 2,
        num_liquidity_pools: 3,
        num_contracts: 4,
      }),
    ]);

    await expect(
      assertIssuerNotContaminated(horizon, ASSET_CODE, ISSUER),
    ).rejects.toMatchObject({
      counts: {
        trustlines: 3,
        claimableBalances: 2,
        liquidityPools: 3,
        contracts: 4,
      },
    });
  });

  // Mirrors the audit's PoC scenario (STEL1-6): a single trustline opened
  // before AUTH_CLAWBACK_ENABLED is set is enough to permanently contaminate
  // the issuer. The check must refuse to deploy in that exact state — the
  // canonical case the audit reproduces on Stellar testnet.
  it("rejects the audit's PoC scenario: one pre-flag trustline on an otherwise-empty issuer", async () => {
    const horizon = makeHorizon([
      makeRecord({
        accounts: { authorized: 1, authorized_to_maintain_liabilities: 0, unauthorized: 0 },
      }),
    ]);

    let thrown: unknown;
    try {
      await assertIssuerNotContaminated(horizon, "POCASSET", ISSUER);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(IssuerContaminatedError);
    const err = thrown as IssuerContaminatedError;
    expect(err.assetCode).toBe("POCASSET");
    expect(err.assetIssuer).toBe(ISSUER);
    expect(err.counts).toEqual({
      trustlines: 1,
      claimableBalances: 0,
      liquidityPools: 0,
      contracts: 0,
    });
    expect(err.message).toMatch(/STEL1-6/);
    expect(err.message).toMatch(/AUTH_CLAWBACK_ENABLED/);
  });

  it("queries Horizon with the supplied asset_code and asset_issuer", async () => {
    const callBuilder = {
      forCode: jest.fn().mockReturnThis(),
      forIssuer: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({ records: [] }),
    };
    const horizon = {
      assets: jest.fn().mockReturnValue(callBuilder),
    } as unknown as Horizon.Server;

    await assertIssuerNotContaminated(horizon, ASSET_CODE, ISSUER);

    expect(horizon.assets).toHaveBeenCalledTimes(1);
    expect(callBuilder.forCode).toHaveBeenCalledWith(ASSET_CODE);
    expect(callBuilder.forIssuer).toHaveBeenCalledWith(ISSUER);
    expect(callBuilder.call).toHaveBeenCalledTimes(1);
  });
});
