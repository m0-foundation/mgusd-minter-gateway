// GitHub release attestation verification for the Fireblocks-signed deploy.
// Mirrors the bash flow (scripts/deploy-pipeline.sh): pull a
// WASM from a tagged GitHub release, verify the Sigstore build-provenance
// attestation, and (opt-in) reproduce the bytes locally to prove the local
// toolchain matches what CI built.
//
// All shell-outs use `execFileSync` with argv-as-array — never `shell: true`
// — so operator-controlled values (RELEASE_TAG, RELEASE_REPO) cannot inject
// shell metacharacters.

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface FetchAttestedWasmParams {
  releaseTag: string;
  releaseRepo: string;
  outDir: string;
  pattern: string;
}

export interface VerifyAttestationParams {
  wasmPath: string;
  releaseRepo: string;
}

export interface ResolveReleaseCommitParams {
  releaseTag: string;
  releaseRepo: string;
}

export interface CrossVerifyLocalBuildParams {
  wasmPath: string;
  releaseTag: string;
  releaseRepo: string;
}

const GH_INSTALL_HINT =
  "Install: https://cli.github.com/  (then `gh auth login`)";

export function requireGhCli(): void {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      `gh CLI required but not found.\n  ${GH_INSTALL_HINT}`,
    );
  }
}

export function fetchAttestedWasm(params: FetchAttestedWasmParams): string {
  const { releaseTag, releaseRepo, outDir, pattern } = params;

  fs.mkdirSync(outDir, { recursive: true });

  try {
    execFileSync(
      "gh",
      [
        "release",
        "download",
        releaseTag,
        "--repo",
        releaseRepo,
        "--pattern",
        pattern,
        "--dir",
        outDir,
        "--clobber",
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    throw new Error(
      `gh release download failed for ${releaseRepo}@${releaseTag}. ` +
        `Confirm the release exists and you have access. ` +
        `Underlying: ${(err as Error).message}`,
    );
  }

  // Match the bash glob by translating `*` to a regex. The pattern is small
  // and operator-supplied, so no need for a glob library.
  const re = patternToRegex(pattern);
  const matches = fs
    .readdirSync(outDir)
    .filter((f) => re.test(f))
    .filter((f) => fs.statSync(path.join(outDir, f)).isFile())
    .sort();

  if (matches.length === 0) {
    throw new Error(
      `No asset matching ${pattern} found in ${releaseRepo}@${releaseTag} ` +
        `(downloaded to ${outDir}).`,
    );
  }

  if (matches.length > 1) {
    console.warn(
      `WARNING: multiple assets matched ${pattern} in ${releaseRepo}@${releaseTag}; ` +
        `using the first lexicographically. Matches: ${matches.join(", ")}`,
    );
  }

  return path.join(outDir, matches[0]);
}

export function verifyAttestation(params: VerifyAttestationParams): void {
  const { wasmPath, releaseRepo } = params;
  try {
    execFileSync(
      "gh",
      ["attestation", "verify", wasmPath, "--repo", releaseRepo],
      { stdio: "inherit" },
    );
  } catch (err) {
    throw new Error(
      `Refusing to deploy unverified bytes: attestation verification ` +
        `failed for ${wasmPath} against ${releaseRepo}. ` +
        `Underlying: ${(err as Error).message}`,
    );
  }
}

export function resolveReleaseCommit(params: ResolveReleaseCommitParams): string {
  const { releaseTag, releaseRepo } = params;
  // Mirrors bash: `gh api repos/<repo>/tags --paginate --jq ".[] | select(.name==\"<tag>\") | .commit.sha"`.
  // The jq filter is one argv element — execFileSync without `shell: true`
  // means no further parsing, so operator-controlled values are safe.
  const jqFilter = `.[] | select(.name == "${releaseTag}") | .commit.sha`;
  const out = execFileSync(
    "gh",
    [
      "api",
      `repos/${releaseRepo}/tags`,
      "--paginate",
      "--jq",
      jqFilter,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  ).toString();

  const first = out.split("\n")[0].trim();
  if (!first) {
    throw new Error(
      `could not resolve commit SHA for ${releaseRepo}@${releaseTag} ` +
        `(tag may not exist on the remote).`,
    );
  }
  return first;
}

export function crossVerifyLocalBuild(params: CrossVerifyLocalBuildParams): void {
  const { wasmPath, releaseTag, releaseRepo } = params;

  // Distinct, actionable error per missing prereq (locked decision Q3 — hard
  // error so `CROSS_VERIFY_LOCAL_BUILD=1` is a strict contract).
  assertToolPresent(
    "stellar",
    "stellar CLI required for cross-verify. Install via `brew install stellar-cli` or set `CROSS_VERIFY_LOCAL_BUILD=0`.",
  );
  assertToolPresent(
    "cargo",
    "cargo required for cross-verify. Install the Rust toolchain (https://rustup.rs) or set `CROSS_VERIFY_LOCAL_BUILD=0`.",
  );
  assertToolPresent("git", "git required for cross-verify (cannot read HEAD).");

  const headSha = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
  const releaseSha = resolveReleaseCommit({ releaseTag, releaseRepo });

  if (headSha !== releaseSha) {
    throw new Error(
      `HEAD does not match the release commit for ${releaseTag}; cannot reproduce.\n` +
        `  HEAD:        ${headSha}\n` +
        `  ${releaseTag}: ${releaseSha}\n` +
        `  Checkout \`${releaseSha}\` (git fetch --tags origin && git checkout ${releaseTag}) ` +
        `to cross-verify, or set CROSS_VERIFY_LOCAL_BUILD=0.`,
    );
  }

  const localBuildDir = path.resolve("./dist/local-build");
  fs.mkdirSync(localBuildDir, { recursive: true });
  // Clear stale .wasm files from prior runs so the post-build glob is unambiguous.
  for (const f of fs.readdirSync(localBuildDir)) {
    if (f.endsWith(".wasm")) fs.unlinkSync(path.join(localBuildDir, f));
  }

  // Parity with bash deploy-pipeline.sh:135-141. `--meta source_repo=...` and
  // `--meta home_domain=m0.org` are baked into the released WASM, so omitting
  // either guarantees a hash mismatch.
  execFileSync(
    "stellar",
    [
      "contract",
      "build",
      "--package",
      "mintergateway",
      "--locked",
      "--optimize",
      "--out-dir",
      localBuildDir,
      "--meta",
      `source_repo=github:${releaseRepo}`,
      "--meta",
      "home_domain=m0.org",
    ],
    { stdio: "inherit" },
  );

  const localWasms = fs.readdirSync(localBuildDir).filter((f) => f.endsWith(".wasm"));
  if (localWasms.length === 0) {
    throw new Error(`No .wasm produced in ${localBuildDir}`);
  }
  const localWasmPath = path.join(localBuildDir, localWasms[0]);

  const localHash = sha256OfFile(localWasmPath);
  const releaseHash = sha256OfFile(wasmPath);

  if (localHash !== releaseHash) {
    throw new Error(
      `REFUSING TO DEPLOY: local build does not reproduce attested bytes.\n` +
        `  local:    ${localHash} (${localWasmPath})\n` +
        `  release:  ${releaseHash} (${wasmPath})\n` +
        `\n` +
        `Possible causes:\n` +
        `  - rust-toolchain.toml channel drift (check rustc --version)\n` +
        `  - Stellar CLI version mismatch (check stellar --version, want 25.2.0)\n` +
        `  - macOS↔Linux build-path leak in WASM metadata — reproduce on Linux or set CROSS_VERIFY_LOCAL_BUILD=0\n` +
        `  - Dirty working tree (uncommitted changes alter compiled bytes)`,
    );
  }
}

function assertToolPresent(tool: string, errMsg: string): void {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(errMsg);
  }
}

function sha256OfFile(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function patternToRegex(pattern: string): RegExp {
  // Escape regex metacharacters except `*`, then translate `*` to `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
