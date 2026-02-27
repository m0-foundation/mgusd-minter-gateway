/**
 * Integration test: requires real Fireblocks sandbox credentials.
 *
 * To run:
 *   1. Copy .env.example to .env and fill in real credentials
 *   2. npm run test:integration
 *
 * This test is skipped by default — remove the .skip to run with real credentials.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { SctokenFireblocksClient, loadMinterConfigFromEnv } from "../../src";

describe("Integration: SCToken contract", () => {
  let client: SctokenFireblocksClient;

  beforeAll(() => {
    const config = loadMinterConfigFromEnv();
    client = new SctokenFireblocksClient(config);
  });

  it("queries the admin address", async () => {
    const contractId = process.env.CONTRACT_ID;
    if (!contractId) {
      throw new Error("CONTRACT_ID env var required for integration test");
    }

    const result = await client.queryAdmin({ contractId });

    expect(result.address).toMatch(/^[GC]/);
    expect(result.txHash).toBeDefined();
    expect(result.ledger).toBeGreaterThan(0);
    console.log("queryAdmin result:", result);
  }, 120_000);

  it("queries the SAC token address", async () => {
    const contractId = process.env.CONTRACT_ID;
    if (!contractId) {
      throw new Error("CONTRACT_ID env var required for integration test");
    }

    const result = await client.querySacToken({ contractId });

    expect(result.address).toMatch(/^C/);
    expect(result.txHash).toBeDefined();
    expect(result.ledger).toBeGreaterThan(0);
    console.log("querySacToken result:", result);
  }, 120_000);

  it("mints tokens", async () => {
    const contractId = process.env.CONTRACT_ID;
    const mintTo = process.env.MINT_TO;
    const mintAmount = process.env.MINT_AMOUNT;

    if (!contractId || !mintTo || !mintAmount) {
      throw new Error("CONTRACT_ID, MINT_TO, MINT_AMOUNT env vars required");
    }

    const config = loadMinterConfigFromEnv();

    const result = await client.mint({
      contractId,
      caller: config.sourcePublicKey,
      to: mintTo,
      amount: BigInt(mintAmount),
    });

    expect(result.status).toBe("SUCCESS");
    expect(result.txHash).toBeDefined();
    expect(result.ledger).toBeGreaterThan(0);
    console.log("mint result:", result);
  }, 120_000);

  it("burns tokens", async () => {
    const contractId = process.env.CONTRACT_ID;
    const burnAmount = process.env.BURN_AMOUNT;

    if (!contractId || !burnAmount) {
      throw new Error("CONTRACT_ID, BURN_AMOUNT env vars required");
    }

    const config = loadMinterConfigFromEnv();

    const result = await client.burn({
      contractId,
      caller: config.sourcePublicKey,
      from: config.sourcePublicKey,
      amount: BigInt(burnAmount),
    });

    expect(result.status).toBe("SUCCESS");
    expect(result.txHash).toBeDefined();
    expect(result.ledger).toBeGreaterThan(0);
    console.log("burn result:", result);
  }, 120_000);
});
