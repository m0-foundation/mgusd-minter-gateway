// Tests for `scripts/lib/attestation.ts` — the TS port of the bash
// attestation flow in `scripts/deploy-pipeline.sh` (PR #80). Mocks
// `child_process.execFileSync` so no real `gh` / `git` / `stellar` calls
// happen.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type ExecFileSyncFn = (...args: unknown[]) => Buffer | string;

interface ExecCall {
  cmd: string;
  args: string[];
  options?: Record<string, unknown>;
}

/**
 * Loads the attestation module under a fresh module cache with a mocked
 * `child_process.execFileSync`. The handler decides per (cmd, args) what
 * to return (or throw). Returns the module + the call log + a synthetic
 * `execFileSync` mock so tests can assert argv shape.
 */
function loadAttestation(
  handler: (cmd: string, args: string[], options?: Record<string, unknown>) => string | Buffer,
): { mod: typeof import("../../scripts/lib/attestation"); calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  jest.resetModules();
  jest.doMock("child_process", () => {
    const actual = jest.requireActual("child_process") as object;
    return {
      ...actual,
      execFileSync: jest.fn((cmd: string, args: string[], options?: Record<string, unknown>) => {
        calls.push({ cmd, args: [...args], options });
        return handler(cmd, args, options);
      }),
    };
  });
  const mod = require("../../scripts/lib/attestation") as typeof import("../../scripts/lib/attestation");
  return { mod, calls };
}

function makeEnoent(cmd: string): NodeJS.ErrnoException {
  const err = new Error(`spawnSync ${cmd} ENOENT`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function makeExitErr(stderr = "", status = 1): Error {
  const err = new Error("Command failed") as Error & { status: number; stderr: Buffer | string };
  err.status = status;
  err.stderr = stderr;
  return err;
}

describe("attestation: requireGhCli", () => {
  it("returns silently when `gh --version` succeeds", () => {
    const { mod } = loadAttestation((cmd) => {
      if (cmd === "gh") return "gh version 2.49.0\n";
      throw new Error(`unexpected ${cmd}`);
    });
    expect(() => mod.requireGhCli()).not.toThrow();
  });

  it("throws an install-hint error when gh is missing (ENOENT)", () => {
    const { mod } = loadAttestation((cmd) => {
      if (cmd === "gh") throw makeEnoent("gh");
      throw new Error(`unexpected ${cmd}`);
    });
    expect(() => mod.requireGhCli()).toThrow(/gh CLI/);
    // Hint should point operators to install + auth.
    expect(() => mod.requireGhCli()).toThrow(/cli\.github\.com|gh auth login/);
  });
});

describe("attestation: fetchAttestedWasm", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-fetch-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("invokes `gh release download` with the exact expected argv", () => {
    // Simulate gh writing the WASM into outDir.
    const wasmName = "mintergateway_v1.0.0.wasm";
    const { mod, calls } = loadAttestation((cmd, args) => {
      if (cmd === "gh" && args[0] === "release" && args[1] === "download") {
        fs.writeFileSync(path.join(tempDir, wasmName), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
        return "";
      }
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    });

    const out = mod.fetchAttestedWasm({
      releaseTag: "v1.0.0",
      releaseRepo: "m0-foundation/mgusd-minter-gateway",
      outDir: tempDir,
      pattern: "mintergateway_v*.wasm",
    });

    expect(out).toBe(path.join(tempDir, wasmName));
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual([
      "release",
      "download",
      "v1.0.0",
      "--repo",
      "m0-foundation/mgusd-minter-gateway",
      "--pattern",
      "mintergateway_v*.wasm",
      "--dir",
      tempDir,
      "--clobber",
    ]);
  });

  it("throws when gh release download exits non-zero (wraps with 'confirm the release exists')", () => {
    const { mod } = loadAttestation((cmd, args) => {
      if (cmd === "gh" && args[0] === "release") {
        throw makeExitErr("release not found");
      }
      throw new Error(`unexpected`);
    });

    expect(() =>
      mod.fetchAttestedWasm({
        releaseTag: "v9.9.9",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
        outDir: tempDir,
        pattern: "mintergateway_v*.wasm",
      }),
    ).toThrow(/confirm the release exists/i);
  });

  it("throws when no asset in outDir matches the pattern after download", () => {
    // Download "succeeds" but writes a non-matching file.
    const { mod } = loadAttestation(() => {
      fs.writeFileSync(path.join(tempDir, "README.md"), "not a wasm");
      return "";
    });
    expect(() =>
      mod.fetchAttestedWasm({
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
        outDir: tempDir,
        pattern: "mintergateway_v*.wasm",
      }),
    ).toThrow(/no .*\.wasm.*found/i);
  });

  it("picks the first match lexicographically AND warns when multiple match", () => {
    const { mod } = loadAttestation(() => {
      fs.writeFileSync(path.join(tempDir, "mintergateway_v1.0.0-debug.wasm"), Buffer.from([0x00]));
      fs.writeFileSync(path.join(tempDir, "mintergateway_v1.0.0.wasm"), Buffer.from([0x01]));
      return "";
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const out = mod.fetchAttestedWasm({
      releaseTag: "v1.0.0",
      releaseRepo: "m0-foundation/mgusd-minter-gateway",
      outDir: tempDir,
      pattern: "mintergateway_v*.wasm",
    });

    // Lexicographic sort puts "-debug" before "" (since "-" < "."): "v1.0.0-debug.wasm" < "v1.0.0.wasm".
    expect(path.basename(out)).toBe("mintergateway_v1.0.0-debug.wasm");
    expect(warnSpy).toHaveBeenCalled();
    const warning = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warning).toMatch(/multiple/i);
    expect(warning).toContain("mintergateway_v1.0.0-debug.wasm");
    expect(warning).toContain("mintergateway_v1.0.0.wasm");

    warnSpy.mockRestore();
  });
});

describe("attestation: verifyAttestation", () => {
  it("invokes `gh attestation verify <wasm> --repo <repo>` with stdio: 'inherit'", () => {
    const { mod, calls } = loadAttestation(() => "");
    mod.verifyAttestation({
      wasmPath: "/tmp/x.wasm",
      releaseRepo: "m0-foundation/mgusd-minter-gateway",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual([
      "attestation",
      "verify",
      "/tmp/x.wasm",
      "--repo",
      "m0-foundation/mgusd-minter-gateway",
    ]);
    expect(calls[0].options).toMatchObject({ stdio: "inherit" });
  });

  it("throws 'Refusing to deploy unverified bytes' on non-zero exit", () => {
    const { mod } = loadAttestation(() => {
      throw makeExitErr("signature invalid");
    });
    expect(() =>
      mod.verifyAttestation({
        wasmPath: "/tmp/x.wasm",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/Refusing to deploy unverified bytes/);
  });
});

describe("attestation: resolveReleaseCommit", () => {
  it("invokes `gh api repos/<repo>/tags --paginate --jq <filter>` and returns the trimmed stdout", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const { mod, calls } = loadAttestation(() => `${sha}\n`);

    const out = mod.resolveReleaseCommit({
      releaseTag: "v1.0.0",
      releaseRepo: "m0-foundation/mgusd-minter-gateway",
    });
    expect(out).toBe(sha);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args[0]).toBe("api");
    expect(calls[0].args).toContain("repos/m0-foundation/mgusd-minter-gateway/tags");
    expect(calls[0].args).toContain("--paginate");
    expect(calls[0].args).toContain("--jq");
    // The jq filter must be a single argv element (injection-safe).
    const jqIdx = calls[0].args.indexOf("--jq");
    expect(calls[0].args[jqIdx + 1]).toContain("v1.0.0");
    expect(calls[0].args[jqIdx + 1]).toContain("commit.sha");
  });

  it("throws when stdout is empty (tag not found)", () => {
    const { mod } = loadAttestation(() => "");
    expect(() =>
      mod.resolveReleaseCommit({
        releaseTag: "v9.9.9",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/could not resolve commit SHA/i);
  });

  it("takes only the first line when stdout has multiple", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const { mod } = loadAttestation(() => `${sha}\nextra-noise\n`);
    expect(
      mod.resolveReleaseCommit({
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toBe(sha);
  });
});

describe("attestation: crossVerifyLocalBuild", () => {
  let tempDir: string;
  let downloadedWasmPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-xverify-"));
    downloadedWasmPath = path.join(tempDir, "downloaded.wasm");
    fs.writeFileSync(downloadedWasmPath, Buffer.from([0xaa, 0xbb, 0xcc]));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sha = "abcdef0123456789abcdef0123456789abcdef01";

  it("hard-errors when `stellar` CLI is missing", () => {
    const { mod } = loadAttestation((cmd) => {
      if (cmd === "stellar") throw makeEnoent("stellar");
      if (cmd === "cargo") return "cargo 1.80.0";
      if (cmd === "git") return sha + "\n";
      if (cmd === "gh") return sha + "\n";
      throw new Error(`unexpected ${cmd}`);
    });

    expect(() =>
      mod.crossVerifyLocalBuild({
        wasmPath: downloadedWasmPath,
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/stellar/);
    expect(() =>
      mod.crossVerifyLocalBuild({
        wasmPath: downloadedWasmPath,
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/brew install stellar-cli|CROSS_VERIFY_LOCAL_BUILD=0/);
  });

  it("hard-errors when `cargo` is missing", () => {
    const { mod } = loadAttestation((cmd) => {
      if (cmd === "cargo") throw makeEnoent("cargo");
      if (cmd === "stellar") return "stellar 25.2.0";
      if (cmd === "git") return sha + "\n";
      if (cmd === "gh") return sha + "\n";
      throw new Error(`unexpected ${cmd}`);
    });

    expect(() =>
      mod.crossVerifyLocalBuild({
        wasmPath: downloadedWasmPath,
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/cargo/);
    expect(() =>
      mod.crossVerifyLocalBuild({
        wasmPath: downloadedWasmPath,
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/Rust toolchain|CROSS_VERIFY_LOCAL_BUILD=0/);
  });

  it("hard-errors when `git` is missing", () => {
    const { mod } = loadAttestation((cmd) => {
      if (cmd === "git") throw makeEnoent("git");
      if (cmd === "stellar") return "stellar 25.2.0";
      if (cmd === "cargo") return "cargo 1.80.0";
      throw new Error(`unexpected ${cmd}`);
    });

    expect(() =>
      mod.crossVerifyLocalBuild({
        wasmPath: downloadedWasmPath,
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/git/);
  });

  it("hard-errors when HEAD does not match the release commit", () => {
    const headSha = "1111111111111111111111111111111111111111";
    const releaseSha = "2222222222222222222222222222222222222222";

    const { mod } = loadAttestation((cmd, args) => {
      if (cmd === "stellar" && args[0] === "--version") return "stellar 25.2.0";
      if (cmd === "cargo" && args[0] === "--version") return "cargo 1.80.0";
      if (cmd === "git" && args[0] === "--version") return "git 2.40.0";
      if (cmd === "git" && args[0] === "rev-parse") return headSha + "\n";
      if (cmd === "gh" && args[0] === "api") return releaseSha + "\n";
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    });

    expect(() =>
      mod.crossVerifyLocalBuild({
        wasmPath: downloadedWasmPath,
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      }),
    ).toThrow(/HEAD does not.*release commit|Checkout/i);

    // Error message must name both SHAs so operator can act on it.
    try {
      mod.crossVerifyLocalBuild({
        wasmPath: downloadedWasmPath,
        releaseTag: "v1.0.0",
        releaseRepo: "m0-foundation/mgusd-minter-gateway",
      });
      fail("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain(headSha);
      expect((e as Error).message).toContain(releaseSha);
    }
  });

  it("hard-errors when local build hash differs from downloaded (includes macOS↔Linux note)", () => {
    const sameSha = "3333333333333333333333333333333333333333";
    const localBuildDir = path.resolve("./dist/local-build");

    const { mod } = loadAttestation((cmd, args) => {
      if (cmd === "stellar" && args[0] === "--version") return "stellar 25.2.0";
      if (cmd === "cargo" && args[0] === "--version") return "cargo 1.80.0";
      if (cmd === "git" && args[0] === "--version") return "git 2.40.0";
      if (cmd === "git" && args[0] === "rev-parse") return sameSha + "\n";
      if (cmd === "gh" && args[0] === "api") return sameSha + "\n";
      if (cmd === "stellar" && args[0] === "contract" && args[1] === "build") {
        // Simulate the build producing a WASM with different bytes.
        fs.mkdirSync(localBuildDir, { recursive: true });
        fs.writeFileSync(path.join(localBuildDir, "mintergateway.wasm"), Buffer.from([0xff, 0xee, 0xdd]));
        return "";
      }
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    });

    try {
      expect(() =>
        mod.crossVerifyLocalBuild({
          wasmPath: downloadedWasmPath,
          releaseTag: "v1.0.0",
          releaseRepo: "m0-foundation/mgusd-minter-gateway",
        }),
      ).toThrow(/REFUSING TO DEPLOY|local build does not reproduce/i);

      try {
        mod.crossVerifyLocalBuild({
          wasmPath: downloadedWasmPath,
          releaseTag: "v1.0.0",
          releaseRepo: "m0-foundation/mgusd-minter-gateway",
        });
        fail("expected throw");
      } catch (e) {
        expect((e as Error).message).toMatch(/macOS|Linux|build-path/i);
      }
    } finally {
      fs.rmSync(localBuildDir, { recursive: true, force: true });
    }
  });

  it("returns silently when local build hash matches downloaded", () => {
    const sameSha = "4444444444444444444444444444444444444444";
    const localBuildDir = path.resolve("./dist/local-build");
    const downloadedBytes = fs.readFileSync(downloadedWasmPath);

    const { mod, calls } = loadAttestation((cmd, args) => {
      if (cmd === "stellar" && args[0] === "--version") return "stellar 25.2.0";
      if (cmd === "cargo" && args[0] === "--version") return "cargo 1.80.0";
      if (cmd === "git" && args[0] === "--version") return "git 2.40.0";
      if (cmd === "git" && args[0] === "rev-parse") return sameSha + "\n";
      if (cmd === "gh" && args[0] === "api") return sameSha + "\n";
      if (cmd === "stellar" && args[0] === "contract" && args[1] === "build") {
        fs.mkdirSync(localBuildDir, { recursive: true });
        // Reproduce the exact downloaded bytes.
        fs.writeFileSync(path.join(localBuildDir, "mintergateway.wasm"), downloadedBytes);
        return "";
      }
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    });

    try {
      expect(() =>
        mod.crossVerifyLocalBuild({
          wasmPath: downloadedWasmPath,
          releaseTag: "v1.0.0",
          releaseRepo: "m0-foundation/mgusd-minter-gateway",
        }),
      ).not.toThrow();

      // Sanity: build was invoked with the parity flags from bash.
      const buildCall = calls.find(
        (c) => c.cmd === "stellar" && c.args[0] === "contract" && c.args[1] === "build",
      );
      expect(buildCall).toBeDefined();
      expect(buildCall!.args).toContain("--package");
      expect(buildCall!.args).toContain("mintergateway");
      expect(buildCall!.args).toContain("--locked");
      expect(buildCall!.args).toContain("--optimize");
    } finally {
      fs.rmSync(localBuildDir, { recursive: true, force: true });
    }
  });
});
