import {
  BasePath,
  Fireblocks,
  TransferPeerPathType,
  TransactionRequest,
  TransactionOperation,
  TransactionResponse,
  TransactionStateEnum,
} from "@fireblocks/ts-sdk";
import { FireblocksSigningError } from "./errors";
import { FireblocksSignatureResult, SorobanFireblocksConfig } from "./types";

const POLL_INTERVAL_MS = 1000;
// 10 minutes — covers the tx envelope's 5-min maxTime plus mobile-approval
// latency. Keeping the poll window strictly longer than the tx envelope's
// validity guarantees the SDK fails first (clear error) instead of returning
// a signature that's already useless to submit.
const MAX_POLL_ATTEMPTS = 600;

const TERMINAL_STATES: Set<string> = new Set([
  TransactionStateEnum.Completed,
  TransactionStateEnum.Failed,
  TransactionStateEnum.Cancelled,
  TransactionStateEnum.Rejected,
  TransactionStateEnum.Blocked,
]);

const BASE_PATH_MAP: Record<string, BasePath> = {
  sandbox: BasePath.Sandbox,
  us: BasePath.US,
  eu: BasePath.EU,
  eu2: BasePath.EU2,
};

export function createFireblocksClient(config: SorobanFireblocksConfig): Fireblocks {
  const basePath = BASE_PATH_MAP[config.fireblocksBasePath ?? "sandbox"] ?? BasePath.Sandbox;
  return new Fireblocks({
    apiKey: config.fireblocksApiKey,
    secretKey: config.fireblocksSecretKey,
    basePath,
  });
}

export async function signHash(
  fireblocks: Fireblocks,
  config: SorobanFireblocksConfig,
  hashHex: string,
  note?: string,
): Promise<FireblocksSignatureResult> {
  if (hashHex.length !== 64) {
    throw new FireblocksSigningError(
      `Expected 32-byte hash as 64-char hex string, got ${hashHex.length} chars`,
    );
  }

  const txRequest: TransactionRequest = {
    operation: TransactionOperation.Raw,
    assetId: config.fireblocksAssetId,
    source: {
      type: TransferPeerPathType.VaultAccount,
      id: config.fireblocksVaultAccountId,
    },
    // Fireblocks shows `note` to approvers on mobile + console next to the
    // (otherwise opaque) raw hash. This is the only signal they have about
    // what they're signing — keep it accurate and concise.
    ...(note ? { note } : {}),
    extraParameters: {
      rawMessageData: {
        messages: [
          {
            content: hashHex,
          },
        ],
      },
    },
  };

  const createResponse = await fireblocks.transactions.createTransaction({
    transactionRequest: txRequest,
  });

  const fbTxId = createResponse.data?.id;
  if (!fbTxId) {
    throw new FireblocksSigningError("Fireblocks createTransaction returned no transaction ID");
  }

  // stderr so --json stdout stays clean for downstream parsers.
  console.error(
    `[Fireblocks] tx ${fbTxId} submitted for RAW signing. ` +
      `Awaiting approval from designated signers (poll budget ${MAX_POLL_ATTEMPTS}s)...`,
  );

  const completedTx = await pollFireblocksTransaction(fireblocks, fbTxId);

  console.error(`[Fireblocks] tx ${fbTxId} approved + signed. Submitting to Stellar...`);

  return extractSignature(completedTx, fbTxId);
}

async function pollFireblocksTransaction(
  fireblocks: Fireblocks,
  txId: string,
): Promise<TransactionResponse> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);

    const response = await fireblocks.transactions.getTransaction({ txId });
    const tx = response.data;

    if (!tx || !tx.status) {
      continue;
    }

    if (tx.status === TransactionStateEnum.Completed) {
      return tx;
    }

    if (TERMINAL_STATES.has(tx.status) && tx.status !== TransactionStateEnum.Completed) {
      const subStatus = tx.subStatus ?? "unknown";
      const note = tx.note ?? "";
      throw new FireblocksSigningError(
        `Fireblocks transaction ${txId} reached terminal state: ${tx.status} (subStatus: ${subStatus}, note: ${note})`,
      );
    }
  }

  throw new FireblocksSigningError(
    `Fireblocks transaction ${txId} not completed after ${MAX_POLL_ATTEMPTS} polls`,
  );
}

function extractSignature(
  tx: TransactionResponse,
  fbTxId: string,
): FireblocksSignatureResult {
  const signedMessages = tx.signedMessages;

  if (!signedMessages || signedMessages.length === 0) {
    throw new FireblocksSigningError(
      `Fireblocks transaction ${fbTxId} completed but has no signed messages`,
    );
  }

  const fullSig = signedMessages[0].signature?.fullSig;

  if (!fullSig) {
    throw new FireblocksSigningError(
      `Fireblocks transaction ${fbTxId} has no fullSig in signed message`,
    );
  }

  // Ed25519 signatures are exactly 64 bytes (128 hex chars)
  if (fullSig.length !== 128) {
    throw new FireblocksSigningError(
      `Expected 64-byte Ed25519 signature (128 hex chars), got ${fullSig.length} chars`,
    );
  }

  return {
    signatureHex: fullSig,
    fireblocksTransactionId: fbTxId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
