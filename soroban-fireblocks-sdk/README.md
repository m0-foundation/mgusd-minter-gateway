# soroban-fireblocks-sdk

Soroban SCToken contract deployment and invocation SDK with Fireblocks raw signing (Ed25519).

Extends the generic `SorobanFireblocksClient` with typed convenience methods for the `contracts/mintergateway` (YieldToken) contract — specifically its `mint(caller, to, amount)`, `burn(caller, from, amount)`, `set_rate(caller, rateBps)`, `set_minter(newMinter)`, `admin()`, and `sac_token()` methods, plus a full Fireblocks-signed deployment pipeline.

## Project Structure

```
soroban-fireblocks-sdk/
├── src/                   # TypeScript SDK
│   ├── client.ts          # SorobanFireblocksClient (base)
│   ├── sctoken-client.ts  # SctokenFireblocksClient (mint/burn/deploy)
│   ├── soroban-tx-builder.ts
│   ├── fireblocks-signer.ts
│   ├── scval-helpers.ts
│   ├── config.ts
│   ├── errors.ts
│   ├── types.ts
│   ├── sctoken-types.ts
│   └── index.ts
├── scripts/               # CLI scripts (all read from .env)
├── tests/
│   ├── unit/
│   └── integration/
└── package.json
```

> The Soroban contract (YieldToken) lives at `contracts/mintergateway/` in the repo root and is built via the root Cargo workspace.

## Prerequisites

- Node.js 18+
- Fireblocks sandbox or production account with Ed25519 vault
- Rust + Soroban CLI (for building the contract WASM)

## Setup

```bash
npm install
cp .env.example .env
# Fill in .env with real credentials
```

### Environment Variables (`.env`)

All parameters live in `.env` so they can be reviewed before each run. The SDK uses two Fireblocks accounts: an **issuer** (deploys) and a **minter** (mint/burn/trustline/query).

#### Shared (all scripts)

| Variable | Description |
|----------|-------------|
| `SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `SOROBAN_NETWORK_PASSPHRASE` | Stellar network passphrase |
| `FIREBLOCKS_API_KEY` | Fireblocks API key |
| `FIREBLOCKS_SECRET_PATH` | Path to Fireblocks API secret PEM file |
| `FIREBLOCKS_ASSET_ID` | Fireblocks asset ID (e.g., `XLM_TEST`) |
| `FIREBLOCKS_BASE_PATH` | Fireblocks environment (`sandbox`, `us`, `eu`, `eu2`) |

#### Issuer — Fireblocks account #1 (`npm run deploy`)

| Variable | Description |
|----------|-------------|
| `ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID` | Fireblocks vault account ID for the issuer |
| `ISSUER_PUBLIC_KEY` | Stellar public key for the issuer (G...) |

#### Minter — Fireblocks account #2 (`npm run mint / burn / trustline / query`)

| Variable | Description |
|----------|-------------|
| `MINTER_FIREBLOCKS_VAULT_ACCOUNT_ID` | Fireblocks vault account ID for the minter |
| `MINTER_PUBLIC_KEY` | Stellar public key for the minter (G...) |

#### Contract roles (`npm run deploy`)

Each role is read from its own env var (see audit STEL1-5). For local testing you may set several to the same key on purpose; production should use distinct vaults where possible.

| Variable | Description |
|----------|-------------|
| `ADMIN_PUBLIC_KEY` | Top-level admin |
| `MINTER_PUBLIC_KEY` | Minter (also listed under minter account above) |
| `YIELD_RECIPIENT_MANAGER_PUBLIC_KEY` | Rotates yield recipient |
| `YIELD_RECIPIENT_PUBLIC_KEY` | Receives claimed yield |
| `FORCED_TRANSFER_MANAGER_PUBLIC_KEY` | Forced transfers |
| `BLOCK_OPERATOR_PUBLIC_KEY` | Block / batch block on the allowlist |
| `UNBLOCK_OPERATOR_PUBLIC_KEY` | Unblock / batch unblock on the allowlist |
| `PAUSER_PUBLIC_KEY` | Pause / unpause |

#### Per-script

| Variable | Used by | Description |
|----------|---------|-------------|
| `ASSET_CODE` | deploy | Asset code / symbol (default: `TMGUSD`) |
| `WASM_PATH` | deploy | Path to compiled WASM |
| `TRUSTLINE_ASSET_CODE` | trustline | Asset code (e.g., `TMGUSD`) — issuer is `ISSUER_PUBLIC_KEY` |
| `CONTRACT_ID` | mint, burn, query | Deployed SCToken wrapper contract ID (C...) |
| `MINT_TO` | mint | Destination address (G...) — typically `MINTER_PUBLIC_KEY` |
| `MINT_AMOUNT` | mint | Amount to mint (integer, bigint-safe) |
| `BURN_AMOUNT` | burn | Amount to burn (integer, bigint-safe) |

## Commands

### `npm run build`

Compiles TypeScript from `src/` to `dist/`.

### `npm run deploy`

Runs the full 5-step Fireblocks-signed deployment pipeline. The **issuer** Fireblocks account (`ISSUER_PUBLIC_KEY`) signs all deploy transactions and acts as the Stellar asset issuer. The **minter** (`MINTER_PUBLIC_KEY`) is set as the wrapper contract admin.

| Step | Action | Tx Type |
|------|--------|---------|
| 1 | **Configure issuer** — sets `AUTH_REVOCABLE` + `AUTH_CLAWBACK_ENABLED` flags on the issuer account | Classic `setOptions` |
| 2 | **Deploy SAC** — creates the Stellar Asset Contract for the asset | Soroban `createStellarAssetContract` |
| 3 | **Upload WASM** — uploads the compiled contract bytecode to the ledger | Soroban `uploadContractWasm` |
| 4 | **Deploy wrapper** — instantiates the wrapper with constructor args: `sac_token`, admin, minter, yield recipient manager, yield recipient, forced transfer manager, block operator, unblock operator, pauser | Soroban `createCustomContract` |
| 5 | **Transfer SAC admin** — calls `set_admin` on the SAC to hand control to the wrapper | Soroban `invokeContract` |

Build the contract WASM first (requires Rust + Soroban CLI):

```bash
stellar contract build   # from repo root — builds contracts/mintergateway via workspace
```

Uses `.env` variables: `ASSET_CODE`, `WASM_PATH`, `MINTER_PUBLIC_KEY`

### `npm run trustline`

Creates a trustline on the **minter's** Fireblocks vault account so it can hold the classic Stellar asset. Required before the minter can receive tokens.

Uses `.env` variables: `TRUSTLINE_ASSET_CODE`, `ISSUER_PUBLIC_KEY`

### `npm run mint`

Calls `mint(caller, to, amount)` on the wrapper contract. `caller` must be the minter or admin.

Uses `.env` variables: `CONTRACT_ID`, `MINT_TO`, `MINT_AMOUNT`

### `npm run burn`

Calls `burn(caller, from, amount)` on the wrapper contract. `caller` must be the minter or admin.

Uses `.env` variables: `CONTRACT_ID`, `BURN_AMOUNT`

### `npm run query`

Calls `admin()` and `sac_token()` on the wrapper contract, decoding the returned addresses. Read-only (still submits a simulated Soroban tx). Signed by the **minter**.

Uses `.env` variables: `CONTRACT_ID`

### `npm test`

Runs unit tests only.

### `npm run test:integration`

Runs integration tests (requires real Fireblocks credentials + Stellar testnet).

### `npm run test:all`

Runs both unit and integration tests.

## Typical End-to-End Flow

```bash
# 1. Build the contract WASM (from repo root)
stellar contract build

# 2. Deploy (signed by issuer; configure all role env vars, including block/unblock operators)
npm run deploy

# 3. Set up trustline on the minter's account
npm run trustline

# 4. Mint tokens to the minter (minter is the admin)
npm run mint

# 5. Verify contract state
npm run query

# 6. Burn tokens from the minter
npm run burn
```

## Programmatic Usage

```typescript
import {
  SctokenFireblocksClient,
  loadIssuerConfigFromEnv,
  loadMinterConfigFromEnv,
} from "soroban-fireblocks-sdk";

// Deploy pipeline (issuer signs; pass every role address — block/unblock may be the same pubkey)
const issuerConfig = loadIssuerConfigFromEnv();
const issuerClient = new SctokenFireblocksClient(issuerConfig);
const minterPublicKey = process.env.MINTER_PUBLIC_KEY!;
const blockOp = process.env.BLOCK_OPERATOR_PUBLIC_KEY!;
const unblockOp = process.env.UNBLOCK_OPERATOR_PUBLIC_KEY!;
const pauser = process.env.PAUSER_PUBLIC_KEY!;

const deploy = await issuerClient.deployFull({
  assetCode: "TMGUSD",
  assetIssuer: issuerConfig.sourcePublicKey,
  wasm: fs.readFileSync("./target/wasm32v1-none/release/mintergateway.wasm"),
  admin: minterPublicKey,
  minter: minterPublicKey,
  yieldRecipientManager: minterPublicKey,
  yieldRecipient: minterPublicKey,
  forcedTransferManager: minterPublicKey,
  blockOperator: blockOp,
  unblockOperator: unblockOp,
  pauser: pauser,
});
console.log(deploy.sacContractId);      // C...
console.log(deploy.wasmHash);           // hex
console.log(deploy.wrapperContractId);  // C...

// Mint (caller must be minter or admin)
const minterConfig = loadMinterConfigFromEnv();
const minterClient = new SctokenFireblocksClient(minterConfig);

const mintResult = await minterClient.mint({
  contractId: "C...",
  caller: minterConfig.sourcePublicKey,
  to: minterConfig.sourcePublicKey,
  amount: 1_000_000_000n,
});

// Burn (caller must be minter or admin)
const burnResult = await minterClient.burn({
  contractId: "C...",
  caller: minterConfig.sourcePublicKey,
  from: minterConfig.sourcePublicKey,
  amount: 500_000_000n,
});

// Query
const admin = await minterClient.queryAdmin({ contractId: "C..." });
console.log(admin.address); // G... (MINTER_PUBLIC_KEY)

const sacToken = await minterClient.querySacToken({ contractId: "C..." });
console.log(sacToken.address); // C...
```

## Verification (Testnet)

With valid Fireblocks sandbox credentials in `.env`, the full pipeline has been verified end-to-end on Stellar testnet:

```bash
# 1. Build
npm run build        # TypeScript compiles cleanly

# 2. Unit tests
npm test             # 71 unit tests pass

# 3. Build the contract WASM (from repo root)
stellar contract build

# 4. Deploy — full 5-step pipeline (issuer signs)
npm run deploy
#   Step 1/5: Configuring issuer flags... ✓
#   Step 2/5: Deploying SAC...            ✓  → SAC Contract ID
#   Step 3/5: Uploading WASM...           ✓  → WASM Hash
#   Step 4/5: Deploying wrapper contract...✓  → Wrapper Contract ID
#   Step 5/5: Transferring SAC admin...   ✓

# 5. Set up trustline on the minter's account
npm run trustline    # Transaction SUCCESS

# 6. Query contract state
npm run query        # Returns admin + SAC token addresses

# 7. Mint tokens
npm run mint         # Transaction SUCCESS

# 8. Burn tokens
npm run burn         # Transaction SUCCESS

# 9. Integration tests (Fireblocks sandbox + testnet)
npm run test:integration   # 4/4 pass (queryAdmin, querySacToken, mint, burn)
```

> **Note:** `npm run deploy` will fail at Step 2 if the SAC for the same asset+issuer already exists on the network (`Error(Storage, ExistingValue)`). This is expected — each asset+issuer pair can only have one SAC. Use a different `ASSET_CODE` or issuer to deploy again.

## Architecture

`SctokenFireblocksClient` extends `SorobanFireblocksClient`, inheriting the generic `invokeContract()` pipeline and adding typed convenience methods (`mint`, `burn`, `queryAdmin`, `querySacToken`) that handle Address/i128 XDR serialization internally via `scval-helpers.ts`.

### Two Transaction Pipelines

Every operation uses one of two signing pipelines depending on the transaction type:

| | Soroban (6-step) | Classic (4-step) |
|---|---|---|
| **Used by** | `mint`, `burn`, `query`, `deploySac`, `uploadWasm`, `deployContract`, `set_admin` | `configureIssuer`, `setupTrustline` |
| **Simulation** | Yes — `simulateAndPrepare()` | No |

**Soroban pipeline:** Build → Simulate → Hash → Sign (Fireblocks) → Attach signature → Submit & poll

**Classic pipeline:** Build → Hash → Sign (Fireblocks) → Attach signature → Submit & poll

### Operation Call Chains

#### 1. Deploy Full (`npm run deploy`)

5 sub-steps, each using the appropriate pipeline:

| Sub-step | Method | Builder | Pipeline |
|----------|--------|---------|----------|
| 1. Configure issuer | `configureIssuer()` | `buildConfigureIssuerTransaction()` | Classic |
| 2. Deploy SAC | `deploySac()` | `buildDeploySacTransaction()` | Soroban |
| 3. Upload WASM | `uploadWasm()` | `buildUploadWasmTransaction()` | Soroban |
| 4. Deploy wrapper | `deployContract()` | `buildDeployContractTransaction()` | Soroban |
| 5. Transfer SAC admin | `invokeContract("set_admin")` | `buildInvokeTransaction()` | Soroban |

**Env:** Core config + `ASSET_CODE` (opt) + `WASM_PATH` (opt) + `MINTER_PUBLIC_KEY`

#### 2. Mint (`npm run mint`)

`mint()` → `invokeContract("mint", [caller, to, amount])` → Soroban pipeline

**Env:** Core config + `CONTRACT_ID` + `MINT_TO` + `MINT_AMOUNT`

#### 3. Burn (`npm run burn`)

`burn()` → `invokeContract("burn", [caller, from, amount])` → Soroban pipeline

**Env:** Core config + `CONTRACT_ID` + `BURN_AMOUNT`

#### 4. Query (`npm run query`)

`queryAdmin()` / `querySacToken()` → `invokeContract("admin" | "sac_token")` → Soroban pipeline

**Env:** Core config + `CONTRACT_ID`

#### 5. Trustline (`npm run trustline`)

`setupTrustline()` → `buildChangeTrustTransaction()` → Classic pipeline

**Env:** Core config + `TRUSTLINE_ASSET_CODE` + `ISSUER_PUBLIC_KEY`

> **Core config** = `SOROBAN_RPC_URL`, `SOROBAN_NETWORK_PASSPHRASE`, `FIREBLOCKS_API_KEY`, `FIREBLOCKS_SECRET_PATH`, `FIREBLOCKS_ASSET_ID` (+ optional `FIREBLOCKS_BASE_PATH`). Per-role: `{ISSUER,MINTER}_FIREBLOCKS_VAULT_ACCOUNT_ID`, `{ISSUER,MINTER}_PUBLIC_KEY`

### Fireblocks Signing Detail

The SDK uses Fireblocks RAW signing to produce Ed25519 signatures without exposing private keys:

1. SHA-256 hash of the assembled transaction → 32-byte hex string (64 chars)
2. `fireblocks.transactions.createTransaction({ operation: RAW, content: hashHex })` → MPC Ed25519 signing
3. Poll `fireblocks.transactions.getTransaction()` every 1s, max 120 attempts (120s timeout)
4. Extract 64-byte Ed25519 signature from `signedMessages[0].signature.fullSig` (128 hex chars)

### Simulation Detail

`simulateAndPrepare()` (Soroban transactions only):

1. `server.simulateTransaction(tx)` — estimates CPU/memory resources, runs contract logic in a sandbox
2. `rpc.assembleTransaction(tx, simResponse)` — merges estimated resource fees + auth entries into the TX envelope

If simulation fails, a `SimulationError` is thrown before any signing occurs.

### Submission Detail

`submitAndPoll()` (both pipelines):

1. `server.sendTransaction(tx)` — sends the signed transaction to the network
2. Polls `server.getTransaction(txHash)` every 2s, max 60 attempts (120s timeout)
3. Returns on `SUCCESS` or `FAILED`; throws `SubmissionError` on submission rejection or polling timeout

### Error Types

| Error | When |
|-------|------|
| `ConfigError` | Invalid or missing configuration on startup |
| `SimulationError` | Soroban simulation fails (before signing) |
| `FireblocksSigningError` | Fireblocks signing fails, times out, or returns invalid signature |
| `SubmissionError` | TX submission rejected by network or polling timeout |
