# SDK scripts

Operator entry points for the soroban-fireblocks-sdk. Each script is a thin, self-contained driver around an SDK method — read it top-to-bottom to see exactly what it does.

## Action scripts — in-script VARS model

Every action script has a `VARS` block near the top that the operator **edits before running**. The vault account ID, the signing pubkey, and the per-action arguments live there — visible in source, not buried in `.env`.

`.env` holds only environment basics (RPC URL, network, Fireblocks API creds, asset ID, base path) and `CONTRACT_ID`.

| Script                       | Action                                                                 |
|------------------------------|------------------------------------------------------------------------|
| `npm run block-user`         | Block a single user                                                    |
| `npm run unblock-user`       | Unblock a single user                                                  |
| `npm run pause`              | Pause the contract (blocks mint / burn / force_transfer / claim_yield) |
| `npm run unpause`            | Unpause the contract                                                   |

Each script's VARS block looks like:
```ts
// ─── VARS — edit before running ────────────────────────────────────
const USER_TO_BLOCK   = "GADV2Q7M...";
const VAULT_ACCOUNT_ID = "11";
const VAULT_PUBLIC_KEY = "GD4KTM3S...";
// ───────────────────────────────────────────────────────────────────
```

Pause/unpause additionally preflight-check that the on-chain pauser matches `VAULT_PUBLIC_KEY`, so a misconfigured pubkey fails before signing.

## Utilities

| Script                    | Purpose                                                                     |
|---------------------------|-----------------------------------------------------------------------------|
| `npm run verify-envelope` | Offline decoder for tx envelope XDR (approver-side verification)            |
| `npm run roles`           | Print which legacy roles are configured in `.env` (ISSUER, MINTER, etc.)    |
| `npm run query`           | Read-only views (admin, paused, balance, etc.) via the legacy minter creds  |
| `npm run trustline`       | Configure a wrapper-issued trustline (Fireblocks-signed)                    |
| `npm run trustline-self`  | Configure a trustline using a locally-held Ed25519 secret (testing only)    |
| `npm run deploy`          | Multi-tx deployment orchestration                                           |

For ad-hoc on-chain reads outside what `npm run query` covers, use an external tool (`stellar-cli`, `soroban-cli`) — the SDK no longer ships a view-only config.

## Adding a new action script

The SDK already covers every contract method (`parity.test.ts` enforces this). To expose one as a script:

1. Copy [`block-user.ts`](block-user.ts) as a template.
2. Update the VARS block (action args + vault + pubkey).
3. Swap the SDK method call.
4. Add a `package.json` script alias.

Scripts are deliberately *not* generated from a registry — each one is reviewed and run on its own merits, and operation-specific safety checks (like `pause`'s preflight verifying the on-chain pauser matches `VAULT_PUBLIC_KEY`) belong inline in the script.

## Approver verification

Every signing script prints the envelope XDR + the 32-byte hash to stderr before submission. Approvers should run `verify-envelope` on their own machine and confirm the decoded contract / method / args + the hash match what Fireblocks shows them. See [`verify-envelope.ts`](verify-envelope.ts) for the protocol.
