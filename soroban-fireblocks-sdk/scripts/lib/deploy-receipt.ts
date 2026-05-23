// Deploy receipt schema + writer. Captures source commit, WASM identity,
// both signers, role addresses, and final contract IDs.

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface DeployReceiptRoles {
  admin: string;
  minter: string;
  yieldRecipientManager: string;
  yieldRecipient: string;
  forcedTransferManager: string;
  blockOperator: string;
  unblockOperator: string;
  pauser: string;
}

export interface DeployReceipt {
  timestamp: string;
  network: {
    networkPassphrase: string;
    sorobanRpcUrl: string;
    horizonUrl: string;
  };
  source: {
    commit: string;
    branch: string;
    repo: string;
    dirty: boolean;
  };
  wasm: {
    path: string;
    sha256: string;
    sizeBytes: number;
  };
  issuer: {
    publicKey: string;
    vaultAccountId: string;
  };
  deployer: {
    publicKey: string;
  };
  asset: {
    code: string;
    issuer: string;
    homeDomain?: string;
  };
  roles: DeployReceiptRoles;
  result: {
    sacContractId: string;
    wasmHashOnChain: string;
    wrapperContractId: string;
  };
}

export function writeDeployReceipt(receipt: DeployReceipt, outputDir: string): string {
  const safeTs = receipt.timestamp.replace(/[:.]/g, "-");
  const filename = `deploy-${safeTs}.json`;
  const filepath = path.resolve(outputDir, filename);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(receipt, null, 2) + "\n");
  return filepath;
}

// Falls back to "unknown" per-field on failure; never throws.
export function gitInfo(cwd: string = process.cwd()): DeployReceipt["source"] {
  const run = (cmd: string): string => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  let commit = "unknown";
  let branch = "unknown";
  let repo = "unknown";
  let dirty = false;
  try { commit = run("git rev-parse HEAD"); } catch { /* not a git repo */ }
  try { branch = run("git rev-parse --abbrev-ref HEAD"); } catch { /* detached HEAD or missing */ }
  try { repo = run("git config --get remote.origin.url"); } catch { /* no remote */ }
  try { dirty = run("git status --porcelain").length > 0; } catch { /* not a git repo */ }
  return { commit, branch, repo, dirty };
}
