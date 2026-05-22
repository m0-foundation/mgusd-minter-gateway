/**
 * Offline decoder for Stellar transaction envelope XDR.
 *
 * Approver workflow: the submitter shares the base64 envelope (printed to
 * stderr by every signing path in this SDK). The approver runs
 * `npm run cli -- verify-envelope --xdr "..."` on their own machine to
 * see (a) what the tx actually does and (b) the hash Fireblocks should
 * present to them. If the printed hash matches what their phone shows,
 * they know they're approving the same thing the submitter built.
 *
 * Fully offline — no RPC, no Horizon, no Fireblocks. Network passphrase
 * is required to re-derive the hash (Stellar hashes are network-scoped);
 * we read it from SOROBAN_NETWORK_PASSPHRASE or the --network flag.
 */

import { Address, Networks, Operation, TransactionBuilder, scValToNative, xdr } from "@stellar/stellar-sdk";

interface VerifyArgs {
  xdr: string;
  network?: string;
}

export function runVerifyEnvelopeCommand(flags: Record<string, string | boolean>): void {
  const args = parseFlags(flags);
  const passphrase = resolveNetwork(args.network);

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(args.xdr, passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse envelope XDR: ${msg}`);
    process.exit(1);
  }

  if ("innerTransaction" in tx) {
    // Fee-bump wrappers are uncommon for our SDK; surface and unwrap.
    console.log("(fee-bump wrapper — decoding inner transaction)");
    tx = tx.innerTransaction;
  }

  console.log("=== Transaction envelope ===");
  console.log(`  network:    ${describeNetwork(passphrase)}`);
  console.log(`  source:     ${tx.source}`);
  console.log(`  sequence:   ${tx.sequence}`);
  console.log(`  fee:        ${tx.fee} stroops`);
  if (tx.timeBounds) {
    const max = parseInt(tx.timeBounds.maxTime, 10);
    const maxStr = max === 0 ? "never" : new Date(max * 1000).toISOString();
    console.log(`  maxTime:    ${maxStr}`);
  }
  console.log(`  hash:       ${tx.hash().toString("hex")}`);
  console.log(`              ^ this must match the hash on the approver's Fireblocks screen`);
  console.log();

  console.log(`=== Operations (${tx.operations.length}) ===`);
  tx.operations.forEach((op: Operation, i: number) => {
    console.log(`\n[${i}] ${op.type}`);
    describeOperation(op);
  });
}

// Operation is a discriminated union in stellar-sdk; we widen to a record so
// we can fish out fields by name from variants we don't have a dedicated
// printer for. Approver still gets the truthful op type from `op.type`.
type AnyOp = Operation & Record<string, unknown>;

function describeOperation(opIn: Operation): void {
  const op = opIn as AnyOp;
  switch (op.type) {
    case "invokeHostFunction":
      describeInvokeHostFunction(op as unknown as InvokeHostFunctionOp);
      return;
    case "changeTrust": {
      const line = op.line as { code?: string; issuer?: string } | undefined;
      console.log(`    asset:  ${line?.code ?? "?"}:${line?.issuer ?? "?"}`);
      console.log(`    limit:  ${(op.limit as string | undefined) ?? "unlimited"}`);
      return;
    }
    case "setOptions":
      if (op.setFlags !== undefined) console.log(`    setFlags:   ${op.setFlags}`);
      if (op.clearFlags !== undefined) console.log(`    clearFlags: ${op.clearFlags}`);
      if (op.homeDomain) console.log(`    homeDomain: ${op.homeDomain}`);
      return;
    case "payment":
      console.log(`    destination: ${op.destination}`);
      console.log(`    asset:       ${describeAsset(op.asset as { code?: string; issuer?: string })}`);
      console.log(`    amount:      ${op.amount}`);
      return;
    default:
      console.log(`    (no decoder for op type "${op.type}" — raw fields):`);
      for (const [k, v] of Object.entries(op)) {
        if (k === "type" || k === "source") continue;
        console.log(`    ${k}: ${truncate(JSON.stringify(v), 200)}`);
      }
  }
}

interface InvokeHostFunctionOp {
  type: "invokeHostFunction";
  func: xdr.HostFunction;
}

function describeInvokeHostFunction(op: InvokeHostFunctionOp): void {
  const func = op.func;
  const switchValue = func.switch();

  if (switchValue === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    const invoke = func.invokeContract();
    const contractAddr = Address.fromScAddress(invoke.contractAddress()).toString();
    const methodName = invoke.functionName().toString();
    const argScVals = invoke.args();

    console.log(`    contract: ${contractAddr}`);
    console.log(`    method:   ${methodName}`);
    console.log(`    args (${argScVals.length}):`);
    argScVals.forEach((scval, i) => {
      console.log(`      [${i}] ${formatScVal(scval)}`);
    });
    return;
  }

  if (switchValue === xdr.HostFunctionType.hostFunctionTypeCreateContract()) {
    console.log(`    (createContract — see raw XDR for details)`);
    return;
  }

  if (switchValue === xdr.HostFunctionType.hostFunctionTypeUploadContractWasm()) {
    const wasmBytes = func.wasm();
    console.log(`    uploadContractWasm: ${wasmBytes.length} bytes`);
    return;
  }

  console.log(`    (unknown host function type: ${switchValue.name})`);
}

/** Best-effort ScVal pretty-printer. Falls back to type tag for exotic cases. */
function formatScVal(scval: xdr.ScVal): string {
  try {
    const switchValue = scval.switch();
    // Address values are easiest to read as G.../C... strings.
    if (
      switchValue === xdr.ScValType.scvAddress()
    ) {
      return `address(${Address.fromScVal(scval).toString()})`;
    }
    // Bytes — show as hex with length.
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

function describeNetwork(passphrase: string): string {
  if (passphrase === Networks.PUBLIC) return "PUBLIC (mainnet)";
  if (passphrase === Networks.TESTNET) return "TESTNET";
  if (passphrase === Networks.FUTURENET) return "FUTURENET";
  return passphrase;
}

function parseFlags(flags: Record<string, string | boolean>): VerifyArgs {
  const xdrFlag = flags.xdr;
  if (typeof xdrFlag !== "string" || xdrFlag.length === 0) {
    console.error("verify-envelope: --xdr <base64> is required");
    process.exit(1);
  }
  const network = typeof flags.network === "string" ? flags.network : undefined;
  return { xdr: xdrFlag, network };
}

function resolveNetwork(flagValue?: string): string {
  if (flagValue === "mainnet" || flagValue === "public") return Networks.PUBLIC;
  if (flagValue === "testnet") return Networks.TESTNET;
  if (flagValue === "futurenet") return Networks.FUTURENET;
  if (flagValue) return flagValue; // assume raw passphrase

  const fromEnv = process.env.SOROBAN_NETWORK_PASSPHRASE;
  if (fromEnv) return fromEnv;
  console.error(
    "verify-envelope: pass --network (mainnet|testnet|<passphrase>) or set SOROBAN_NETWORK_PASSPHRASE",
  );
  process.exit(1);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}
