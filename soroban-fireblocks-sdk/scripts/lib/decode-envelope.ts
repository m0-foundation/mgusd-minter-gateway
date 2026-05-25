/**
 * Decode a Stellar transaction envelope XDR into a human-readable operation
 * description. Shared between `verify-envelope.ts` (offline XDR decoder) and
 * `fb-tx-inspect.ts` (Fireblocks-side approver verification).
 *
 * Pure function: takes XDR + passphrase, returns the decoded transaction object
 * with `hash()` already verified by stellar-sdk parsing. Caller is responsible
 * for printing.
 */

import { Address, Networks, Operation, TransactionBuilder, scValToNative, xdr } from "@stellar/stellar-sdk";

export interface DecodedEnvelope {
  /** Human-readable network name */
  network: string;
  /** G... source account */
  source: string;
  sequence: string;
  fee: string;
  /** ISO timestamp or "never" or null if no timeBounds */
  maxTime: string | null;
  /** Canonical 32-byte tx hash, hex-encoded */
  hashHex: string;
  /** Decoded operations, pretty-printed multi-line strings */
  operations: string[];
}

export function decodeEnvelope(envelopeB64: string, passphrase: string): DecodedEnvelope {
  let tx = TransactionBuilder.fromXDR(envelopeB64, passphrase);
  if ("innerTransaction" in tx) {
    tx = tx.innerTransaction;
  }

  let maxTime: string | null = null;
  if (tx.timeBounds) {
    const max = parseInt(tx.timeBounds.maxTime, 10);
    maxTime = max === 0 ? "never" : new Date(max * 1000).toISOString();
  }

  const operations = tx.operations.map((op: Operation, i: number) => formatOperation(op, i));

  return {
    network: describeNetwork(passphrase),
    source: tx.source,
    sequence: tx.sequence,
    fee: tx.fee.toString(),
    maxTime,
    hashHex: tx.hash().toString("hex"),
    operations,
  };
}

type AnyOp = Operation & Record<string, unknown>;

function formatOperation(opIn: Operation, i: number): string {
  const op = opIn as AnyOp;
  const lines: string[] = [`[${i}] ${op.type}`];

  switch (op.type) {
    case "invokeHostFunction":
      lines.push(...formatInvokeHostFunction(op as unknown as InvokeHostFunctionOp));
      break;
    case "changeTrust": {
      const line = op.line as { code?: string; issuer?: string } | undefined;
      lines.push(`    asset:  ${line?.code ?? "?"}:${line?.issuer ?? "?"}`);
      lines.push(`    limit:  ${(op.limit as string | undefined) ?? "unlimited"}`);
      break;
    }
    case "setOptions":
      if (op.setFlags !== undefined) lines.push(`    setFlags:   ${op.setFlags}`);
      if (op.clearFlags !== undefined) lines.push(`    clearFlags: ${op.clearFlags}`);
      if (op.homeDomain) lines.push(`    homeDomain: ${op.homeDomain}`);
      break;
    case "payment":
      lines.push(`    destination: ${op.destination}`);
      lines.push(`    asset:       ${describeAsset(op.asset as { code?: string; issuer?: string })}`);
      lines.push(`    amount:      ${op.amount}`);
      break;
    default:
      lines.push(`    (no decoder for op type "${op.type}" — raw fields):`);
      for (const [k, v] of Object.entries(op)) {
        if (k === "type" || k === "source") continue;
        lines.push(`    ${k}: ${truncate(JSON.stringify(v), 200)}`);
      }
  }
  return lines.join("\n");
}

interface InvokeHostFunctionOp {
  type: "invokeHostFunction";
  func: xdr.HostFunction;
}

function formatInvokeHostFunction(op: InvokeHostFunctionOp): string[] {
  const func = op.func;
  const switchValue = func.switch();
  const lines: string[] = [];

  if (switchValue === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    const invoke = func.invokeContract();
    const contractAddr = Address.fromScAddress(invoke.contractAddress()).toString();
    const methodName = invoke.functionName().toString();
    const argScVals = invoke.args();
    lines.push(`    contract: ${contractAddr}`);
    lines.push(`    method:   ${methodName}`);
    lines.push(`    args (${argScVals.length}):`);
    argScVals.forEach((scval, i) => {
      lines.push(`      [${i}] ${formatScVal(scval)}`);
    });
    return lines;
  }
  if (switchValue === xdr.HostFunctionType.hostFunctionTypeCreateContract()) {
    lines.push(`    (createContract — see raw XDR for details)`);
    return lines;
  }
  if (switchValue === xdr.HostFunctionType.hostFunctionTypeUploadContractWasm()) {
    const wasmBytes = func.wasm();
    lines.push(`    uploadContractWasm: ${wasmBytes.length} bytes`);
    return lines;
  }
  lines.push(`    (unknown host function type: ${switchValue.name})`);
  return lines;
}

function formatScVal(scval: xdr.ScVal): string {
  try {
    const switchValue = scval.switch();
    if (switchValue === xdr.ScValType.scvAddress()) {
      return `address(${Address.fromScVal(scval).toString()})`;
    }
    if (switchValue === xdr.ScValType.scvBytes()) {
      const b = scval.bytes();
      return `bytes(${b.length}B, 0x${b.toString("hex")})`;
    }
    const native = scValToNative(scval);
    if (typeof native === "bigint") return `i128/u128(${native.toString()})`;
    if (typeof native === "number") return `${switchValue.name}(${native})`;
    if (typeof native === "string") return `${switchValue.name}("${native}")`;
    if (typeof native === "boolean") return `bool(${native})`;
    return `${switchValue.name}(${JSON.stringify(native)})`;
  } catch {
    return `(${scval.switch().name} — could not decode)`;
  }
}

function describeAsset(asset: { code?: string; issuer?: string } | undefined): string {
  if (!asset) return "?";
  return `${asset.code ?? "?"}:${asset.issuer ?? "?"}`;
}

export function describeNetwork(passphrase: string): string {
  if (passphrase === Networks.PUBLIC) return "PUBLIC (mainnet)";
  if (passphrase === Networks.TESTNET) return "TESTNET";
  if (passphrase === Networks.FUTURENET) return "FUTURENET";
  return passphrase;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}
