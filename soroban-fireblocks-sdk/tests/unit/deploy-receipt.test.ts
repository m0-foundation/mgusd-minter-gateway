import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DeployReceipt,
  gitInfo,
  writeDeployReceipt,
} from "../../scripts/lib/deploy-receipt";

function makeReceipt(overrides: Partial<DeployReceipt> = {}): DeployReceipt {
  return {
    timestamp: "2026-05-22T20:00:00.000Z",
    network: {
      networkPassphrase: "Test SDF Network ; September 2015",
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
    },
    source: { commit: "abcd1234", branch: "main", repo: "git@example.com:org/repo.git", dirty: false },
    wasm: {
      path: "./mintergateway.wasm",
      sha256: "00".repeat(32),
      sizeBytes: 1234,
      attested: false,
    },
    issuer: { publicKey: "GAAAA", vaultAccountId: "0" },
    deployer: { publicKey: "GDEPL" },
    asset: { code: "TMGUSD", issuer: "GAAAA" },
    roles: {
      admin: "G1",
      minter: "G2",
      yieldRecipientManager: "G3",
      yieldRecipient: "G4",
      forcedTransferManager: "G5",
      pauser: "G6",
    },
    result: {
      sacContractId: "CAAAA",
      wasmHashOnChain: "00".repeat(32),
      wrapperContractId: "CBBBB",
    },
    ...overrides,
  };
}

describe("writeDeployReceipt", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-receipt-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a JSON file in the supplied output dir, named by timestamp", () => {
    const filepath = writeDeployReceipt(makeReceipt(), tempDir);
    expect(filepath).toContain(tempDir);
    expect(filepath).toMatch(/deploy-2026-05-22T20-00-00-000Z\.json$/);
    expect(fs.existsSync(filepath)).toBe(true);
  });

  it("serializes the receipt as pretty-printed JSON", () => {
    const receipt = makeReceipt();
    const filepath = writeDeployReceipt(receipt, tempDir);
    const onDisk = JSON.parse(fs.readFileSync(filepath, "utf8"));
    expect(onDisk).toEqual(receipt);
  });

  it("creates the output dir if it doesn't already exist", () => {
    const nested = path.join(tempDir, "a", "b", "c");
    expect(fs.existsSync(nested)).toBe(false);
    writeDeployReceipt(makeReceipt(), nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("round-trips wasm.attested, wasm.releaseTag, wasm.releaseRepo when present", () => {
    const receipt = makeReceipt({
      wasm: {
        path: "/tmp/x.wasm",
        sha256: "ab".repeat(32),
        sizeBytes: 4242,
        attested: true,
        releaseTag: "v1.2.3",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      },
    });
    const filepath = writeDeployReceipt(receipt, tempDir);
    const onDisk = JSON.parse(fs.readFileSync(filepath, "utf8"));
    expect(onDisk.wasm).toEqual(receipt.wasm);
  });
});

describe("gitInfo", () => {
  it("returns 'unknown' fields when called outside a git repo", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-info-"));
    try {
      const info = gitInfo(tempDir);
      expect(info.commit).toBe("unknown");
      expect(info.branch).toBe("unknown");
      expect(info.repo).toBe("unknown");
      expect(info.dirty).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns the current repo's commit + branch when run inside it", () => {
    // We're running tests inside the actual repo — gitInfo() should pick it up.
    const info = gitInfo();
    expect(info.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(info.branch).not.toBe("unknown");
  });
});
