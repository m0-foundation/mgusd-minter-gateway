import * as fs from "fs";
import {
  BasePath,
  Fireblocks,
  TransferPeerPathType,
  TransactionRequest,
  TransactionOperation,
  TransactionResponse,
  TransactionStateEnum,
} from "@fireblocks/ts-sdk";
import { ConfigError, FireblocksSigningError } from "./deploy";

/**
 * Note: the secret PEM file at `secretPath` is read lazily by
 * `createFireblocksClient`, never at config-load time. This means dry-run
 * mode (which never instantiates a Fireblocks client) doesn't require a
 * real secret file to be on disk.
 */
export interface FireblocksConfig {
  apiKey: string;
  secretPath: string;
  basePath?: string;
  vaultAccountId: string;
  assetId: string;
  pollTimeoutSeconds: number;
}

export interface SignatureResult {
  signatureHex: string;
  fireblocksTransactionId: string;
}

const POLL_INTERVAL_MS = 1000;

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

export function createFireblocksClient(config: FireblocksConfig): Fireblocks {
  const basePath = BASE_PATH_MAP[config.basePath ?? "sandbox"] ?? BasePath.Sandbox;
  let secretKey: string;
  try {
    secretKey = fs.readFileSync(config.secretPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to read Fireblocks secret at ${config.secretPath}: ${msg}`);
  }
  return new Fireblocks({
    apiKey: config.apiKey,
    secretKey,
    basePath,
  });
}

export async function signHash(
  fireblocks: Fireblocks,
  config: FireblocksConfig,
  hashHex: string,
): Promise<SignatureResult> {
  if (hashHex.length !== 64) {
    throw new FireblocksSigningError(
      `Expected 32-byte hash as 64-char hex string, got ${hashHex.length} chars`,
    );
  }

  const txRequest: TransactionRequest = {
    operation: TransactionOperation.Raw,
    assetId: config.assetId,
    source: {
      type: TransferPeerPathType.VaultAccount,
      id: config.vaultAccountId,
    },
    extraParameters: {
      rawMessageData: {
        messages: [{ content: hashHex }],
      },
    },
  };

  const createResponse = await fireblocks.transactions.createTransaction({
    transactionRequest: txRequest,
  });

  const fbTxId = createResponse.data?.id;
  if (!fbTxId) {
    throw new FireblocksSigningError(
      "Fireblocks createTransaction returned no transaction ID",
    );
  }

  const completedTx = await pollFireblocksTransaction(
    fireblocks,
    fbTxId,
    config.pollTimeoutSeconds,
  );

  return extractSignature(completedTx, fbTxId);
}

async function pollFireblocksTransaction(
  fireblocks: Fireblocks,
  txId: string,
  timeoutSeconds: number,
): Promise<TransactionResponse> {
  const maxAttempts = Math.max(1, Math.floor((timeoutSeconds * 1000) / POLL_INTERVAL_MS));

  for (let i = 0; i < maxAttempts; i++) {
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
    `Fireblocks transaction ${txId} not completed after ${maxAttempts} polls (${timeoutSeconds}s)`,
  );
}

function extractSignature(
  tx: TransactionResponse,
  fbTxId: string,
): SignatureResult {
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
