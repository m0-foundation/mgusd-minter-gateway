/**
 * Approver-side verification tool — given a Fireblocks transaction ID, fetch
 * the pending RAW signing request, verify the stashed envelope XDR matches
 * the hash Fireblocks will sign, and print the decoded on-chain call.
 *
 * Cryptographic chain (all done locally by this script):
 *   1. Fetch tx via Fireblocks API.
 *   2. Read extraParameters.sorobanEnvelopeXdr      → XDR (claimed by submitter)
 *      Read extraParameters.rawMessageData.messages[0].content → hash B (what FB signs)
 *   3. Decode XDR + compute its canonical Stellar tx hash → hash A.
 *   4. If A == B: print the decoded call. Approve in FB if it matches what
 *      the submitter said they were doing.
 *   5. If A != B: refuse to print the decoded call (it would be a lie about
 *      what's being signed) — print TAMPER DETECTED. REJECT in FB.
 *
 * The `note` field is shown but flagged as advisory — it's submitter-controlled
 * metadata, NOT cryptographically bound to the signed payload.
 *
 * Requires in .env:
 *   FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_PATH, FIREBLOCKS_BASE_PATH (optional),
 *   SOROBAN_NETWORK_PASSPHRASE (the network the tx targets).
 *
 * Usage:
 *   npm run fb-tx-inspect -- <fireblocks-tx-id>
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import { BasePath, Fireblocks } from "@fireblocks/ts-sdk";
import { decodeEnvelope, describeNetwork } from "./lib/decode-envelope";

dotenv.config();

const BASE_PATH_MAP: Record<string, BasePath> = {
  sandbox: BasePath.Sandbox,
  us: BasePath.US,
  eu: BasePath.EU,
  eu2: BasePath.EU2,
};

async function main(): Promise<void> {
  const txId = process.argv[2];
  if (!txId) {
    console.error("Usage: npm run fb-tx-inspect -- <fireblocks-tx-id>");
    process.exit(1);
  }

  const apiKey = requireEnv("FIREBLOCKS_API_KEY");
  const secretPath = requireEnv("FIREBLOCKS_SECRET_PATH");
  const passphrase = requireEnv("SOROBAN_NETWORK_PASSPHRASE");
  const secret = fs.readFileSync(secretPath, "utf8");
  const basePathName = process.env.FIREBLOCKS_BASE_PATH ?? "sandbox";
  const basePath = BASE_PATH_MAP[basePathName] ?? BasePath.Sandbox;

  const fireblocks = new Fireblocks({ apiKey, secretKey: secret, basePath });

  const response = await fireblocks.transactions.getTransaction({ txId });
  const tx = response.data;
  if (!tx) {
    console.error(`No transaction found with ID ${txId}`);
    process.exit(1);
  }

  const extra = tx.extraParameters as Record<string, unknown> | undefined;
  const rawMessageData = extra?.rawMessageData as
    | { messages?: Array<{ content?: string }> }
    | undefined;
  const hashB = rawMessageData?.messages?.[0]?.content;
  const envelopeB64 = extra?.sorobanEnvelopeXdr as string | undefined;

  console.log("=== Fireblocks transaction ===");
  console.log(`  ID:         ${tx.id}`);
  console.log(`  Operation:  ${tx.operation ?? "?"}`);
  console.log(`  Status:     ${tx.status ?? "?"}`);
  if (tx.subStatus) console.log(`  Sub-status: ${tx.subStatus}`);
  if (tx.createdAt) console.log(`  Created:    ${new Date(tx.createdAt).toISOString()}`);
  console.log(`  Network:    ${describeNetwork(passphrase)}`);
  console.log();

  if (!hashB) {
    console.log("✗ No rawMessageData.messages[0].content found — not a RAW signing tx?");
    process.exit(1);
  }

  if (!envelopeB64) {
    // Older tx submitted before sorobanEnvelopeXdr stashing was wired in.
    console.log("─── Limited info — this tx predates inline XDR stashing ───");
    console.log(`  hash Fireblocks will sign:  ${hashB}`);
    console.log(`  note (advisory, NOT bound): ${tx.note ?? "(none)"}`);
    console.log();
    console.log("To verify, get the envelope XDR out-of-band from the submitter and run:");
    console.log(`  npm run verify-envelope -- --xdr "<XDR>"`);
    console.log(`Then compare its hash output to: ${hashB}`);
    return;
  }

  // Verify: decode the stashed XDR + compare its canonical hash to what FB will sign.
  let decoded;
  try {
    decoded = decodeEnvelope(envelopeB64, passphrase);
  } catch (err) {
    console.error(`✗ Failed to parse sorobanEnvelopeXdr: ${err instanceof Error ? err.message : err}`);
    console.error("REJECT — XDR is malformed and cannot be verified.");
    process.exit(1);
  }

  if (decoded.hashHex !== hashB) {
    console.log("✗ TAMPER DETECTED");
    console.log(`  Hash from XDR:                 ${decoded.hashHex}`);
    console.log(`  Hash Fireblocks will sign:     ${hashB}`);
    console.log();
    console.log("The envelope XDR stashed in this tx does NOT produce the hash Fireblocks will");
    console.log("sign. Approving this transaction would sign something different from what the");
    console.log("XDR claims to represent. REJECT in Fireblocks.");
    process.exit(1);
  }

  // Hashes agree → safe to display decoded operation.
  console.log("✓ Verified — Fireblocks will sign the call below.");
  console.log(`  hash:     ${decoded.hashHex}`);
  console.log();
  console.log("=== Decoded on-chain call ===");
  console.log(`  source:   ${decoded.source}`);
  console.log(`  sequence: ${decoded.sequence}`);
  console.log(`  fee:      ${decoded.fee} stroops`);
  if (decoded.maxTime) console.log(`  maxTime:  ${decoded.maxTime}`);
  console.log();
  console.log(`Operations (${decoded.operations.length}):`);
  decoded.operations.forEach((op) => {
    console.log(op.split("\n").map((line) => "  " + line).join("\n"));
  });
  console.log();
  console.log("─── Advisory (submitter-set, NOT bound to signature) ───");
  console.log(`  note: ${tx.note ?? "(none)"}`);
  console.log();
  console.log("If the decoded call matches the intent the submitter described, approve in Fireblocks.");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
