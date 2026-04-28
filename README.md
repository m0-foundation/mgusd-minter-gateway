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

The Blocker whitelists (unblocks) recipient accounts via `unblock_user()`. Once whitelisted, tokens can be transferred to the recipient using the SAC's standard SEP-41 `transfer()`. Whitelisted accounts can freely transfer among themselves. Accumulators are not affected by transfers — they are balance redistributions, not mints/burns.

## Authorization & Allowlist

The SAC issuer is configured with **AUTH_REQUIRED**, **REVOCABLE**, and **CLAWBACK_ENABLED** flags at the classic Stellar layer. This means every account starts **unauthorized** — it cannot send or receive the token until explicitly approved.

### How it works

1. Issuer flags are set on the SAC issuer account via classic Stellar (not from within Soroban)
2. New accounts are **unauthorized by default** — they cannot hold, send, or receive the token
3. The Blocker calls `unblock_user(addr, operator)` to authorize approved accounts
4. Both **sender and receiver** must be authorized for any SAC transfer to succeed

| State | Can Send | Can Receive | How to enter |
|-------|:--------:|:-----------:|--------------|
| **Authorized** | ✓ | ✓ | Blocker calls `unblock_user` |
| **Unauthorized** (default) | ✗ | ✗ | Default state, or Blocker calls `block_user` |

The contract exposes the `stellar_tokens::fungible::blocklist` function shape (`block_user`, `unblock_user`, `blocked`, `balance`) directly against the SAC's `set_authorized`. Because the SAC issuer runs with AUTH_REQUIRED, `blocked(account)` returns `true` for any account that has never been unblocked.

### Issuer Burn Prevention

The issuer account has no trustline for its own asset and cannot be frozen or unfrozen. However, the issuer is **exempt from AUTH_REQUIRED** at the Stellar protocol level — authorized (unfrozen) users **can** send tokens directly to the issuer via SAC `transfer()` or classic Stellar operations. Tokens sent to the issuer are destroyed (un-issued) without updating the contract's yield accumulators. See [Note 2](#note-2--send-to-issuer-bypasses-yield-accrual) for operational implications.

## Compliance Controls

Block / unblock and forced-transfer flows are gated by their **own** roles —
the admin role does *not* implicitly carry these powers. See
[Roles](#roles) for the full authorization graph.

| Function | Role | Description |
|----------|------|-------------|
| `block_user(user, operator)` | Blocker | Blocks a user — removes from allowlist, preventing sending and receiving |
| `unblock_user(user, operator)` | Blocker | Unblocks a user — adds to allowlist, permitting sending and receiving |
| `batch_block_users(users, operator)` | Blocker | Block up to 40 users per call |
| `batch_unblock_users(users, operator)` | Blocker | Unblock up to 40 users per call |
| `blocked(account)` | (view) | Returns whether a user is blocked (inverse of SAC authorization) |
| `balance(id)` | (view) | Returns the SAC-reported balance for an address |

- `block_user` and `unblock_user` call the SAC's `set_authorized` under the hood
- Events match the OZ standard (`UserBlocked` / `UserUnblocked` with topics `["block", user]` / `["unblock", user]`)

## Roles

| Role | Permissions | Intended Actor |
|------|------------|----------------|
| **Admin** | role administration only — see breakdown below | M0 |
| **Minter** | `mint`, `burn`, `set_rate` | Bridge |
| **Yield Recipient Manager** | `set_yield_recipient`, `claim_yield` | M0 |
| **Yield Recipient** | passive — receives the SAC tokens minted by `claim_yield` (does **not** call it) | MoneyGram |
| **Blocker** | `block_user`, `unblock_user`, `batch_block_users`, `batch_unblock_users` | Crossmint |
| **Forced Transfer Manager** | `force_transfer` | *(configurable)* |
| **Pauser** | `pause`, `unpause` | M0 |

**Design properties:**

- **Admin is *not* a super-role.** Admin can only call admin-exclusive functions: `set_admin`, `set_minter`, `set_yield_recipient_manager`, `set_forced_transfer_manager`, `set_pauser`, `add_blocker`, `remove_blocker`, `reconcile_burn`, `transfer_sac_admin`, `upgrade`. Admin **cannot** block users, force-transfer, claim yield, mint, burn, set rate, or pause without first granting itself the relevant role.
- **Operational consequence (no implicit emergency fallback).** A cold admin signer cannot freeze a user or force-move balances in an incident. If an admin-driven fallback is needed, the admin must first grant itself the relevant role: `add_blocker(admin)` to gain block/unblock, or `set_forced_transfer_manager(admin)` to take over forced-transfer. Plan response runbooks accordingly — keep the dedicated role signers reachable.
- All roles are **single-address** except **Blocker**, which is a membership set (any number of addresses can hold the role; granted/revoked by Admin via `add_blocker` / `remove_blocker`).
- Only Admin can reassign roles (except Yield Recipient, which is managed by the Yield Recipient Manager).
- Every role-gated function calls `require_auth()` on the `caller` argument and verifies it equals the role holder — no implicit trust.
- Roles are stored in **Instance** storage.

## Role Hierarchy

```
Admin (role administrator only — NOT a super-role)
├── Sets/rotates: Minter, Yield Recipient Manager, Forced Transfer Manager, Pauser
├── Grants/revokes: Blocker membership (add_blocker / remove_blocker)
├── reconcile_burn — accumulator reconciliation for tokens destroyed off-contract
├── transfer_sac_admin — emergency / migration handoff of SAC admin
└── upgrade — contract upgrade
   (Cannot block, force-transfer, mint, burn, claim, or pause without
    first granting itself the relevant role.)

Minter (Bridge / Issuer)
├── Mints SAC tokens directly via mint()
├── Burns SAC tokens directly via burn()
└── Sets interest rate for yield accrual via set_rate()

Yield Recipient Manager
├── Sets/changes Yield Recipient address (set_yield_recipient)
└── Calls claim_yield — the resulting SAC tokens are minted to the Yield Recipient

Yield Recipient
└── Passive — holds the SAC tokens minted by claim_yield (does not call it)

Blocker (membership set; Admin grants / revokes)
├── Blocks/unblocks individual users (`block_user` / `unblock_user`)
└── Batch block/unblock users (max 40 per call) — matches the `stellar_tokens::fungible::blocklist` function shape

Forced Transfer Manager
└── force_transfer — clawback + mint (bypasses block on source)

Pauser
└── pause / unpause
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

## Notes

### Note 1 — Trustline + Authorization Required for Token Distribution

- Recipient accounts must establish a classic Stellar **trustline** (`ChangeTrust` operation) for the MGUSD asset before they can hold tokens — the contract and SAC do not create trustlines on behalf of recipients
- All accounts start **unauthorized** due to `AUTH_REQUIRED` on the issuer — the Blocker (Crossmint) must call `batch_unblock_users` to authorize recipients before they can receive tokens
- Distribution flow: recipient creates trustline → Blocker batch-unblocks recipients → tokens can be transferred via SAC `transfer()`

### Note 2 — Send-to-Issuer Bypasses Yield Accrual

- Because MGUSD is a Stellar-native asset (SAC-wrapped), authorized users can send tokens directly to the issuer address using standard Stellar operations (SAC `transfer()`, classic `PaymentOp`) — the issuer is exempt from `AUTH_REQUIRED` and cannot be frozen
- Tokens sent to the issuer are destroyed at the protocol level (un-issued), but the contract's accumulators (`total_principal`, `total_supply`) are **not updated** — the contract has no visibility into these direct transfers
- M0 must account for this in its off-chain yield calculations by reconciling actual circulating supply against the contract's reported `total_supply`

---

## TODO

- [ ] Double check rounding math (verify rounding directions are consistent and protocol-favorable across all operations)
