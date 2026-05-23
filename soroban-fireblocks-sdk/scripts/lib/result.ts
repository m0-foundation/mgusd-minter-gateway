import type { InvokeContractResult } from "../../src/types";

export function printResult(result: InvokeContractResult): void {
  console.log(`Transaction ${result.status}:`);
  console.log(`  Hash:   ${result.txHash}`);
  console.log(`  Ledger: ${result.ledger}`);
}
