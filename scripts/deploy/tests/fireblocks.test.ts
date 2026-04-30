import { Fireblocks, TransactionStateEnum } from "@fireblocks/ts-sdk";
import { signHash, FireblocksConfig } from "../src/fireblocks";
import { FireblocksSigningError } from "../src/deploy";

function makeConfig(): FireblocksConfig {
  return {
    apiKey: "key",
    secretPath: "/dev/null", // never read — tests mock the Fireblocks client directly
    basePath: "sandbox",
    vaultAccountId: "0",
    assetId: "XLM_TEST",
    pollTimeoutSeconds: 2, // short for tests; max attempts = 2
  };
}

function mockFireblocks(overrides: Record<string, unknown> = {}): Fireblocks {
  return {
    transactions: {
      createTransaction: jest.fn().mockResolvedValue({
        data: { id: "fb-tx-123" },
      }),
      getTransaction: jest.fn().mockResolvedValue({
        data: {
          status: TransactionStateEnum.Completed,
          signedMessages: [{ signature: { fullSig: "a".repeat(128) } }],
        },
      }),
      ...overrides,
    },
  } as unknown as Fireblocks;
}

const VALID_HASH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

describe("signHash", () => {
  it("rejects invalid hash length", async () => {
    const fb = mockFireblocks();
    await expect(signHash(fb, makeConfig(), "tooshort")).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, makeConfig(), "tooshort")).rejects.toThrow("Expected 32-byte hash");
  });

  it("signs a valid hash and returns 64-byte signature", async () => {
    const fb = mockFireblocks();
    const result = await signHash(fb, makeConfig(), VALID_HASH);
    expect(result.signatureHex).toBe("a".repeat(128));
    expect(result.fireblocksTransactionId).toBe("fb-tx-123");
  });

  it("throws when createTransaction returns no ID", async () => {
    const fb = mockFireblocks({
      createTransaction: jest.fn().mockResolvedValue({ data: {} }),
    });
    await expect(signHash(fb, makeConfig(), VALID_HASH)).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, makeConfig(), VALID_HASH)).rejects.toThrow(
      "returned no transaction ID",
    );
  });

  it("throws when Fireblocks tx reaches FAILED state", async () => {
    const fb = mockFireblocks({
      createTransaction: jest.fn().mockResolvedValue({ data: { id: "fb-tx-456" } }),
      getTransaction: jest.fn().mockResolvedValue({
        data: {
          status: TransactionStateEnum.Failed,
          subStatus: "REJECTED_BY_USER",
          note: "user rejected",
        },
      }),
    });
    await expect(signHash(fb, makeConfig(), VALID_HASH)).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, makeConfig(), VALID_HASH)).rejects.toThrow("FAILED");
  });

  it("throws when completed tx has no signed messages", async () => {
    const fb = mockFireblocks({
      getTransaction: jest.fn().mockResolvedValue({
        data: { status: TransactionStateEnum.Completed, signedMessages: [] },
      }),
    });
    await expect(signHash(fb, makeConfig(), VALID_HASH)).rejects.toThrow("no signed messages");
  });

  it("throws when signature is not 64 bytes", async () => {
    const fb = mockFireblocks({
      getTransaction: jest.fn().mockResolvedValue({
        data: {
          status: TransactionStateEnum.Completed,
          signedMessages: [{ signature: { fullSig: "abcd" } }],
        },
      }),
    });
    await expect(signHash(fb, makeConfig(), VALID_HASH)).rejects.toThrow("64-byte Ed25519");
  });

  it("polls through PENDING states until COMPLETED", async () => {
    let pollCount = 0;
    const fb = mockFireblocks({
      getTransaction: jest.fn().mockImplementation(() => {
        pollCount++;
        if (pollCount === 1) {
          return Promise.resolve({
            data: { status: TransactionStateEnum.PendingSignature },
          });
        }
        return Promise.resolve({
          data: {
            status: TransactionStateEnum.Completed,
            signedMessages: [{ signature: { fullSig: "b".repeat(128) } }],
          },
        });
      }),
    });
    const cfg = { ...makeConfig(), pollTimeoutSeconds: 5 };
    const result = await signHash(fb, cfg, VALID_HASH);
    expect(result.signatureHex).toBe("b".repeat(128));
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it("respects configurable poll timeout (errors out after configured seconds)", async () => {
    const fb = mockFireblocks({
      getTransaction: jest.fn().mockResolvedValue({
        data: { status: TransactionStateEnum.PendingSignature },
      }),
    });
    const cfg = { ...makeConfig(), pollTimeoutSeconds: 2 };
    await expect(signHash(fb, cfg, VALID_HASH)).rejects.toThrow("not completed after");
  });
});
