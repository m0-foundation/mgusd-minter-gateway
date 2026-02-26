import { Fireblocks, TransactionStateEnum } from "@fireblocks/ts-sdk";
import { signHash } from "../../src/fireblocks-signer";
import { FireblocksSigningError } from "../../src/errors";
import { SorobanFireblocksConfig } from "../../src/types";

function makeConfig(): SorobanFireblocksConfig {
  return {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    fireblocksApiKey: "key",
    fireblocksSecretKey: "secret",
    fireblocksVaultAccountId: "0",
    fireblocksAssetId: "XLM_TEST",
    sourcePublicKey: "GABC123456789",
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
          signedMessages: [
            {
              signature: {
                fullSig: "a".repeat(128), // 64 bytes as hex
              },
            },
          ],
        },
      }),
      ...overrides,
    },
  } as unknown as Fireblocks;
}

// Valid 32-byte hash as 64-char hex
const VALID_HASH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

describe("signHash", () => {
  it("rejects invalid hash length", async () => {
    const fb = mockFireblocks();
    const config = makeConfig();

    await expect(signHash(fb, config, "tooshort")).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, config, "tooshort")).rejects.toThrow("Expected 32-byte hash");
  });

  it("signs a valid hash and returns 64-byte signature", async () => {
    const fb = mockFireblocks();
    const config = makeConfig();

    const result = await signHash(fb, config, VALID_HASH);

    expect(result.signatureHex).toBe("a".repeat(128));
    expect(result.fireblocksTransactionId).toBe("fb-tx-123");
  });

  it("throws when createTransaction returns no ID", async () => {
    const fb = mockFireblocks({
      createTransaction: jest.fn().mockResolvedValue({ data: {} }),
    });
    const config = makeConfig();

    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow("returned no transaction ID");
  });

  it("throws when Fireblocks tx reaches FAILED state", async () => {
    const fb = mockFireblocks({
      createTransaction: jest.fn().mockResolvedValue({
        data: { id: "fb-tx-456" },
      }),
      getTransaction: jest.fn().mockResolvedValue({
        data: {
          status: TransactionStateEnum.Failed,
        },
      }),
    });
    const config = makeConfig();

    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow("terminal state");
  });

  it("throws when completed tx has no signed messages", async () => {
    const fb = mockFireblocks({
      getTransaction: jest.fn().mockResolvedValue({
        data: {
          status: TransactionStateEnum.Completed,
          signedMessages: [],
        },
      }),
    });
    const config = makeConfig();

    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow("no signed messages");
  });

  it("throws when signature is not 64 bytes", async () => {
    const fb = mockFireblocks({
      getTransaction: jest.fn().mockResolvedValue({
        data: {
          status: TransactionStateEnum.Completed,
          signedMessages: [
            {
              signature: {
                fullSig: "aabb", // too short
              },
            },
          ],
        },
      }),
    });
    const config = makeConfig();

    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow(FireblocksSigningError);
    await expect(signHash(fb, config, VALID_HASH)).rejects.toThrow("Expected 64-byte Ed25519 signature");
  });

  it("polls through PENDING states until COMPLETED", async () => {
    const getTransaction = jest
      .fn()
      .mockResolvedValueOnce({
        data: { status: TransactionStateEnum.PendingSignature },
      })
      .mockResolvedValueOnce({
        data: { status: TransactionStateEnum.Broadcasting },
      })
      .mockResolvedValueOnce({
        data: {
          status: TransactionStateEnum.Completed,
          signedMessages: [
            {
              signature: {
                fullSig: "b".repeat(128),
              },
            },
          ],
        },
      });

    const fb = mockFireblocks({ getTransaction });
    const config = makeConfig();

    const result = await signHash(fb, config, VALID_HASH);
    expect(result.signatureHex).toBe("b".repeat(128));
    expect(getTransaction).toHaveBeenCalledTimes(3);
  }, 15_000);
});
