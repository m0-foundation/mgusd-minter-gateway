# SDK scripts

Operator entry points for the soroban-fireblocks-sdk. Each script is a thin, self-contained driver around an SDK method — read it top-to-bottom to see exactly what it does.

## Action scripts

| Script                       | Role               | Action                                                                 |
|------------------------------|--------------------|------------------------------------------------------------------------|
| `npm run block-user`         | `BLOCK_OPERATOR`   | Block a single user                                                    |
| `npm run unblock-user`       | `UNBLOCK_OPERATOR` | Unblock a single user                                                  |
| `npm run pause`              | `PAUSER`           | Pause the contract (blocks mint / burn / force_transfer / claim_yield) |
| `npm run unpause`            | `PAUSER`           | Unpause the contract                                                   |

Each accepts the same convention:
```bash
npm run block-user -- --contract C... --user G...
# or via env:
CONTRACT_ID=C... BLOCK_USER=G... npm run block-user
```

Destructive scripts prompt before submission; pass `--yes` to skip.

## Utilities

| Script                    | Purpose                                                                     |
|---------------------------|-----------------------------------------------------------------------------|
| `npm run verify-envelope` | Offline decoder for tx envelope XDR (approver-side verification)           |
| `npm run roles`           | Print which roles are configured in your current `.env`                     |
| `npm run query`           | Read-only views (admin, paused, balance, etc.)                              |
| `npm run trustline`       | Configure a wrapper-issued trustline (Fireblocks-signed)                    |
| `npm run trustline-self`  | Configure a trustline using a locally-held Ed25519 secret (testing only)    |
| `npm run deploy`          | Multi-tx deployment orchestration                                           |

## Role / env layout

Every role has two env vars:
- `<ROLE>_FIREBLOCKS_VAULT_ACCOUNT_ID` — the Fireblocks vault holding the signer key
- `<ROLE>_PUBLIC_KEY` — the Stellar pubkey of that vault

Each script reads only the env vars for its declared role, so a missing `MINTER_PUBLIC_KEY` won't block `block-user`. Run `npm run roles` to inventory what's currently configured.

| Role                       | Used by                                                                       |
|----------------------------|-------------------------------------------------------------------------------|
| `ADMIN`                    | (no script yet — invoke via SDK directly for admin rotations / upgrades)      |
| `MINTER`                   | `mint`, `burn`, `query` (legacy: uses minter creds to read state)             |
| `PAUSER`                   | `pause`, `unpause`                                                            |
| `BLOCK_OPERATOR`           | `block-user`                                                                  |
| `UNBLOCK_OPERATOR`         | `unblock-user`                                                                |

`verify-envelope` is offline and needs no role at all — only `SOROBAN_NETWORK_PASSPHRASE` (or `--network`). For ad-hoc on-chain reads, use an external tool (`stellar-cli`, `soroban-cli`) — the SDK no longer ships a view-only config.

## Adding a new action script

The SDK already covers every contract method (`parity.test.ts` enforces this). To expose one as a script:

1. Copy [`block-user.ts`](block-user.ts) as a template.
2. Update the role, the SDK method call, and the prompt message.
3. Add a `package.json` script alias.

Scripts are deliberately *not* generated from a registry — each one is reviewed and run on its own merits, and operation-specific safety checks (like `pause`'s preflight verifying the on-chain pauser matches the configured key) belong inline in the script.

## Approver verification

Every signing script prints the envelope XDR + the 32-byte hash to stderr before submission. Approvers should run `verify-envelope` on their own machine and confirm the decoded contract / method / args + the hash match what Fireblocks shows them. See [`verify-envelope.ts`](verify-envelope.ts) for the protocol.
