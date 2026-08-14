# Stellar Minter Gateway

A Soroban smart contract that acts as a SAC (Stellar Asset Contract) admin, enabling controlled minting, burning, yield accrual via continuous compounding, and compliance enforcement through an on-chain allowlist.

## Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain)
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli) — pinned to **v25.2.0** (the soroban-sdk's minimum-CLI requirement; see `.tool-versions`)

### Install Rust + Stellar CLI

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none
cargo install --locked stellar-cli@25.2.0
```

If you use [mise](https://mise.jdx.dev/) or [asdf](https://asdf-vm.com/), `mise install` (or `asdf install`) will pick up the pin from `.tool-versions` automatically.

CI installs the same pinned version via the official [`stellar/stellar-cli@v25.2.0`](https://github.com/stellar/stellar-cli) GitHub Action. **Do not bump to `@latest` in CI** — bump in lockstep with the soroban-sdk's minimum-CLI requirement. This matches how [Blend](https://github.com/blend-capital/blend-contracts-v2) and Soroswap operate.

---

## Building

```bash
stellar contract build
```

## Testing

```bash
cargo test
```

## Deploying

Testnet / dev deploys are driven by `scripts/deploy-testnet.sh`, a thin bash wrapper around the `stellar` CLI that mirrors the 5-step pipeline (configure issuer flags → deploy SAC → upload WASM → deploy wrapper → transfer SAC admin). The script uses two `stellar keys` identities — an ISSUER (signs steps 1, 5) and a DEPLOYER (signs steps 2-4) — which can resolve to the same identity for testnet/dev or to distinct cold/warm signers for production.

```bash
cp scripts/deploy.env.example .env
$EDITOR .env                          # fill in role pubkeys + key names
make build
./scripts/deploy-testnet.sh
```

The script auto-loads `.env` from the repo root if present (gitignored). All required env vars and per-role conventions are documented in [`scripts/deploy.env.example`](scripts/deploy.env.example) (STEL1-5: no role-collapsing default).

**Production deploys** that require Fireblocks-custodied signing live on the [`sdk-integration`](https://github.com/m0-foundation/stellar-minter-gateway/tree/sdk-integration) branch. That branch retains the TypeScript SDK and its Fireblocks deploy pipeline; check it out when you need to deploy with MPC-signed issuer keys.

---

## Overview

> **SAC = Stellar Asset Contract.** A SAC is the Soroban interface to a classic Stellar asset — they are the **same token**, not different ones.

This contract is set as the **SAC admin**, giving it the ability to:

- **Mint** new SAC tokens to authorized recipients (`mint`)
- **Burn** SAC tokens from accounts (`burn`)
- **Claim yield** by minting new tokens to the yield recipient (`claim_yield`)
- **Control authorization** — block and unblock accounts via the SAC allowlist

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

The unblock operator whitelists recipient accounts via `unblock_user()`. Once whitelisted, tokens can be transferred to the recipient using the SAC's standard SEP-41 `transfer()`. Whitelisted accounts can freely transfer among themselves. Accumulators are not affected by transfers — they are balance redistributions, not mints/burns.

## Authorization & Allowlist

The SAC issuer is configured with **AUTH_REQUIRED**, **REVOCABLE**, and **CLAWBACK_ENABLED** flags at the classic Stellar layer. This means every account starts **unauthorized** — it cannot send or receive the token until explicitly approved.

### How it works

1. Issuer flags are set on the SAC issuer account via classic Stellar (not from within Soroban)
2. New accounts are **unauthorized by default** — they cannot hold, send, or receive the token
3. An **unblock operator** calls `unblock_user(addr, operator)` to authorize approved accounts
4. Both **sender and receiver** must be authorized for any SAC transfer to succeed

| State | Can Send | Can Receive | How to enter |
|-------|:--------:|:-----------:|--------------|
| **Authorized** | ✓ | ✓ | Unblock operator calls `unblock_user` |
| **Unauthorized** (default) | ✗ | ✗ | Default state, or block operator calls `block_user` |

The contract exposes the `stellar_tokens::fungible::blocklist` function shape (`block_user`, `unblock_user`, `blocked`, `balance`) directly against the SAC's `set_authorized`. Because the SAC issuer runs with AUTH_REQUIRED, `blocked(account)` returns `true` for any account that has never been unblocked.

### Issuer Burn Prevention

The issuer account has no trustline for its own asset and cannot be blocked or unblocked. However, the issuer is **exempt from AUTH_REQUIRED** at the Stellar protocol level — authorized (unblocked) users **can** send tokens directly to the issuer via SAC `transfer()` or classic Stellar operations. Tokens sent to the issuer are destroyed (un-issued) without updating the contract's yield accumulators. See [Note 2](#note-2--send-to-issuer-bypasses-yield-accrual) for operational implications.

## Compliance Controls

Block / unblock and forced-transfer flows are gated by their **own** roles —
the admin role does *not* implicitly carry these powers. See
[Roles](#roles) for the full authorization graph.

| Function | Role | Description |
|----------|------|-------------|
| `block_user(user, operator)` | Block operator | Blocks a user — removes from allowlist, preventing sending and receiving |
| `unblock_user(user, operator)` | Unblock operator | Unblocks a user — adds to allowlist, permitting sending and receiving |
| `batch_block_users(users, operator)` | Block operator | Block up to 40 users per call |
| `batch_unblock_users(users, operator)` | Unblock operator | Unblock up to 40 users per call |
| `blocked(account)` | (view) | Returns whether a user is blocked (inverse of SAC authorization) |
| `balance(id)` | (view) | Returns the SAC-reported balance for an address |

- `block_user` and `unblock_user` call the SAC's `set_authorized` under the hood
- Emits the upstream `stellar_tokens::fungible::blocklist` events: `UserBlocked` / `UserUnblocked` (snake_case topic names `user_blocked` / `user_unblocked`, with the user `Address` as a topic)

### What Blocking Does Not Undo: Standing Orders and Pool Deposits

Stellar has a built-in exchange. Any account can place a standing order (an "offer" in Stellar terms, e.g. *sell 100 MGUSD for 100 USDC*) that sits on the ledger until another account takes the other side — the trade then executes automatically, with no new signature from the account that placed it. Accounts can also deposit tokens into Stellar's on-ledger liquidity pools, where the deposited tokens keep trading on their own.

`block_user` freezes an account by clearing its trustline authorization flag (SAC `set_authorized(false)`). This stops the account from sending, receiving, and placing **new** orders — but it does **not** cancel orders the account placed before the block, and it does **not** pull its tokens out of liquidity pools. A blocked user's earlier order can therefore still execute later and move their tokens. (The classic Stellar issuer operation `SetTrustLineFlags` *would* cancel those orders as a side effect, but our issuer key is renounced at deployment — see [issuer renunciation](docs/issuer-renunciation.md) — so SAC deauthorization is the only freeze mechanism available.)

Operational guidance for a compliance hold:

1. After blocking, check whether the account has standing orders or pool deposits: Horizon `/accounts/{id}/offers` lists its orders, and its pool deposits are visible on the account record.
2. `force_transfer` (clawback) can reclaim only the account's **available** balance — tokens committed to a standing order are locked and cannot be clawed back until that order is cancelled or executes.
3. If an old order does execute after the block, use the standard tools on the outcome: `block_user` the account that received the tokens if warranted, and `force_transfer` to reclaim them.

## Roles

| Role | Permissions | Intended Actor |
|------|------------|----------------|
| **Admin** | role administration only — see breakdown below | M0 |
| **Minter** | `mint`, `burn`, `set_interest_rate` | Bridge |
| **Yield Recipient Manager** | `set_yield_recipient`, `claim_yield` | M0 |
| **Yield Recipient** | passive — receives the SAC tokens minted by `claim_yield` (does **not** call it) | MoneyGram |
| **Block operator** (membership) | `block_user`, `batch_block_users` | Crossmint (typical) |
| **Unblock operator** (membership) | `unblock_user`, `batch_unblock_users` | Crossmint (typical) |
| **Forced Transfer Manager** | `force_transfer` | *(configurable)* |
| **Pauser** (membership) | `pause`, `unpause` | M0 |

**Design properties:**

- **Admin is *not* a super-role.** Admin can only call admin-exclusive functions: `set_admin`, `set_minter`, `set_yield_recipient_manager`, `set_forced_transfer_manager`, `add_block_operator`, `remove_block_operator`, `add_unblock_operator`, `remove_unblock_operator`, `add_pauser`, `remove_pauser`, `reconcile_burn`, `transfer_sac_admin`, `upgrade`. Admin **cannot** block users, unblock users, force-transfer, claim yield, mint, burn, set rate, or pause without first granting itself the relevant role.
- **Operational consequence (no implicit emergency fallback).** A cold admin signer cannot block a user or force-move balances in an incident. If an admin-driven fallback is needed, the admin must first grant itself the relevant role: `add_block_operator(admin)` to gain block, `add_unblock_operator(admin)` to gain unblock, `add_pauser(admin)` to gain pause, or `set_forced_transfer_manager(admin)` to take over forced-transfer. Plan response runbooks accordingly — keep the dedicated role signers reachable.
- All roles are **single-address** except **Block operator**, **Unblock operator**, and **Pauser**, each a membership set (any number of addresses can hold each role; granted/revoked by Admin via `add_block_operator` / `remove_block_operator`, `add_unblock_operator` / `remove_unblock_operator`, and `add_pauser` / `remove_pauser`).
- Only Admin can reassign roles (except Yield Recipient, which is managed by the Yield Recipient Manager).
- Every role-gated function calls `require_auth()` on the `caller` argument and verifies it equals the role holder — no implicit trust.
- Roles are stored in **Instance** storage.

## Role Hierarchy

```
Admin (role administrator only — NOT a super-role)
├── Sets/rotates: Minter, Yield Recipient Manager, Forced Transfer Manager
├── Grants/revokes: Block operator membership (add_block_operator / remove_block_operator)
├── Grants/revokes: Unblock operator membership (add_unblock_operator / remove_unblock_operator)
├── Grants/revokes: Pauser membership (add_pauser / remove_pauser)
├── reconcile_burn — accumulator reconciliation for tokens destroyed off-contract
├── transfer_sac_admin — emergency / migration handoff of SAC admin
└── upgrade — contract upgrade
   (Cannot block, unblock, force-transfer, mint, burn, claim, or pause without
    first granting itself the relevant role.)

Minter (Bridge / Issuer)
├── Mints SAC tokens directly via mint()
├── Burns SAC tokens directly via burn()
└── Sets interest rate for yield accrual via set_interest_rate()

Yield Recipient Manager
├── Sets/changes Yield Recipient address (set_yield_recipient)
└── Calls claim_yield — the resulting SAC tokens are minted to the Yield Recipient

Yield Recipient
└── Passive — holds the SAC tokens minted by claim_yield (does not call it)

Block operator (membership set; Admin grants / revokes)
├── `block_user` — block an individual user
└── `batch_block_users` — block up to 40 users per call

Unblock operator (membership set; Admin grants / revokes)
├── `unblock_user` — unblock an individual user
└── `batch_unblock_users` — unblock up to 40 users per call
   (Matches the `stellar_tokens::fungible::blocklist` function shape.)

Forced Transfer Manager
└── force_transfer — clawback + mint (bypasses block on source)

Pauser (membership set; Admin grants / revokes)
└── pause / unpause
```

## Notes

### Note 1 — Trustline + Authorization Required for Token Distribution

- Recipient accounts must establish a classic Stellar **trustline** (`ChangeTrust` operation) for the MGUSD asset before they can hold tokens — the contract and SAC do not create trustlines on behalf of recipients
- All accounts start **unauthorized** due to `AUTH_REQUIRED` on the issuer — an **unblock operator** (e.g. Crossmint) must call `batch_unblock_users` to authorize recipients before they can receive tokens
- Distribution flow: recipient creates trustline → batch-unblock recipients → tokens can be transferred via SAC `transfer()`

### Note 2 — Send-to-Issuer Bypasses Yield Accrual

- Because MGUSD is a Stellar-native asset (SAC-wrapped), authorized users can send tokens directly to the issuer address using standard Stellar operations (SAC `transfer()`, classic `PaymentOp`) — the issuer is exempt from `AUTH_REQUIRED` and cannot be blocked
- Tokens sent to the issuer are destroyed at the protocol level (un-issued), but the contract's accumulators (`total_principal`, `total_supply`) are **not updated** — the contract has no visibility into these direct transfers
- M0 must account for this in its off-chain yield calculations by reconciling actual circulating supply against the contract's reported `total_supply`

