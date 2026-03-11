# Stellar Minter Gateway

A Soroban smart contract system for issuing yield-bearing tokens on the Stellar network. The contract acts as a SAC (Stellar Asset Contract) admin, enabling controlled minting, burning, yield accrual via continuous compounding, and compliance enforcement through an on-chain allowlist. It is paired with a TypeScript SDK that handles transaction signing through Fireblocks MPC infrastructure.

Monorepo for the **SAC Admin Yield Token** contract and the **Fireblocks signing SDK** that invokes it.

| Directory | Description |
|-----------|-------------|
| `contracts/mintergateway/` | Soroban yield contract — SAC admin that mints, burns, tracks yield, and enforces an allowlist |
| `soroban-fireblocks-sdk/` | TypeScript SDK for invoking the contract via Fireblocks raw signing (Ed25519) |

## Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain)
- [Soroban CLI / Stellar CLI](https://soroban.stellar.org/docs/getting-started/setup) — includes the `stellar` command and the `wasm32` target
- [Node.js](https://nodejs.org/) >= 20
- A [Fireblocks](https://www.fireblocks.com/) account (for the SDK — not needed for contract-only development)

### Install Rust + Soroban target

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none
cargo install stellar-cli --locked
```

### Install SDK dependencies

```bash
cd soroban-fireblocks-sdk
npm install
```

### Configure environment

```bash
cd soroban-fireblocks-sdk
cp .env.example .env
# Edit .env with your Fireblocks credentials, vault IDs, and public keys
```

Key variables in `.env`:

| Variable | Description |
|----------|-------------|
| `FIREBLOCKS_API_KEY` | Your Fireblocks API key |
| `FIREBLOCKS_SECRET_PATH` | Path to your Fireblocks private key file |
| `FIREBLOCKS_ASSET_ID` | `XLM_TEST` (testnet) or `XLM` (mainnet) |
| `ISSUER_PUBLIC_KEY` | Stellar public key of the issuer account |
| `MINTER_PUBLIC_KEY` | Stellar public key of the minter account |
| `CONTRACT_ID` | Deployed contract ID (after deployment) |

---

## Building

### Contract

```bash
stellar contract build
```

### SDK

```bash
cd soroban-fireblocks-sdk
npm install
npm run build
```

## Testing

### Contract

```bash
cargo test
```

### SDK

```bash
cd soroban-fireblocks-sdk
npm test                # unit tests
npm run test:integration # integration tests (requires Fireblocks credentials + testnet)
```

---

## Contract — SAC Admin Yield Token

A Soroban contract that acts as the **SAC admin** for a Stellar asset. It directly mints and burns tokens via the SAC interface, tracks yield accrual on total principal, and enforces an allowlist via AUTH_REQUIRED.

## Overview

> **SAC = Stellar Asset Contract.** A SAC is the Soroban interface to a classic Stellar asset — they are the **same token**, not different ones.

This contract is set as the **SAC admin**, giving it the ability to:

- **Mint** new SAC tokens to authorized recipients (`mint`)
- **Burn** SAC tokens from accounts (`burn`)
- **Claim yield** by minting new tokens to the yield recipient (`claim_yield`)
- **Control authorization** — freeze and unfreeze accounts via the SAC allowlist

The contract never holds user funds. Users hold tokens directly in their accounts.

## Token Flows

![Architecture](images/architecture.png)

### Mint Flow

1. Minter (bridge) calls `mint(caller, to, amount)` on the yield contract
2. Contract updates accumulators (`total_principal` and `total_supply`)
3. Contract mints SAC tokens directly to the recipient via `StellarAssetClient::mint`

### Burn Flow

1. Minter (bridge) calls `burn(caller, from, amount)` on the yield contract
2. Contract updates accumulators (decreases both)
3. Contract removes SAC tokens from the account via `StellarAssetClient::clawback`

### Token Distribution

Admin whitelists (unfreezes) recipient accounts via `unfreeze_account()`. Once whitelisted, tokens can be transferred to the recipient using the SAC's standard SEP-41 `transfer()`. Whitelisted accounts can freely transfer among themselves. Accumulators are not affected by transfers — they are balance redistributions, not mints/burns.

## Authorization & Allowlist

The SAC issuer is configured with **AUTH_REQUIRED**, **REVOCABLE**, and **CLAWBACK_ENABLED** flags at the classic Stellar layer. This means every account starts **unauthorized** — it cannot send or receive the token until explicitly approved.

### How it works

1. Issuer flags are set on the SAC issuer account via classic Stellar (not from within Soroban)
2. New accounts are **unauthorized by default** — they cannot hold, send, or receive the token
3. The admin calls `unfreeze_account(addr)` to authorize approved accounts
4. Both **sender and receiver** must be authorized for any SAC transfer to succeed

| State | Can Send | Can Receive | How to enter |
|-------|:--------:|:-----------:|--------------|
| **Authorized** | ✓ | ✓ | Admin calls `unfreeze_account` |
| **Unauthorized** (default) | ✗ | ✗ | Default state, or admin calls `freeze_account` |

### Issuer Burn Prevention

The issuer account is never whitelisted (it has no trustline for its own asset). Since unfrozen accounts form a closed transfer network that cannot reach the issuer, tokens cannot be accidentally sent to the issuer address — which would burn them at the SAC layer without updating the yield accumulators.

## Compliance Controls

The admin has compliance functions for managing the allowlist and enforcing regulatory requirements.

| Function | Role | Description |
|----------|------|-------------|
| `freeze_account(account)` | Admin | Removes account from allowlist — blocks sending and receiving |
| `unfreeze_account(account)` | Admin | Adds account to allowlist — permits sending and receiving |
| `is_authorized(account)` | (view) | Returns whether an account is authorized |

- `freeze_account` and `unfreeze_account` call the SAC's `set_authorized` under the hood

## Roles

| Role | Permissions | Intended Actor |
|------|------------|----------------|
| **Admin** | All contract functions (super-role) | M0 |
| **Minter** | `mint`, `burn`, `set_rate` | Bridge |
| **Yield Recipient Manager** | `set_yield_recipient` | M0 |
| **Yield Recipient** | `claim_yield` | MoneyGram |
| **Forced Transfer Manager** | *(role stored but no active function)* | Crossmint |

**Design properties:**

- **Admin is a super-role** — can call any function in the contract, in addition to admin-exclusive functions (`set_admin`, `set_minter`, `set_yield_recipient_manager`, `set_forced_transfer_manager`, `freeze_account`, `unfreeze_account`, `upgrade`)
- All roles are **single-address** — exactly one holder per role at any time
- Only Admin can reassign roles (except Yield Recipient, which is managed by the Yield Recipient Manager)
- Every role-gated function calls `require_auth()` on the role holder — no implicit trust
- Roles are stored in **Instance** storage

## Role Hierarchy

```
Admin
├── Top-level authority
├── Can set/change Minter, Yield Recipient Manager, Forced Transfer Manager
└── Compliance: freeze, unfreeze accounts

Minter (Bridge / Issuer)
├── Mints SAC tokens directly via mint()
├── Burns SAC tokens directly via burn()
└── Sets interest rate for yield accrual via set_rate()

Yield Recipient Manager
└── Can set/change Yield Recipient address

Yield Recipient
└── Can claim accrued yield

Forced Transfer Manager
└── (role stored but no active function)
```

---

## SDK — Fireblocks Signing Client

The `soroban-fireblocks-sdk/` directory contains a TypeScript SDK that wraps the yield contract with Fireblocks MPC signing. See [`soroban-fireblocks-sdk/README.md`](soroban-fireblocks-sdk/README.md) for full setup, environment variables, and usage details.

### SDK Methods

| Method | Contract function | Description |
|--------|-------------------|-------------|
| `mint(caller, to, amount)` | `mint` | Mint SAC tokens to a recipient |
| `burn(caller, from, amount)` | `burn` | Burn SAC tokens from an account |
| `setRate(caller, rateBps)` | `set_rate` | Set interest rate in basis points |
| `setMinter(newMinter)` | `set_minter` | Change the minter address (admin only) |
| `queryAdmin()` | `admin` | Query the admin address |
| `querySacToken()` | `sac_token` | Query the SAC token address |
| `deployFull(...)` | — | Full deploy pipeline (configure issuer, deploy SAC, upload WASM, deploy wrapper, transfer admin) |

---

## TODO

- [ ] Double check rounding math (verify rounding directions are consistent and protocol-favorable across all operations)
