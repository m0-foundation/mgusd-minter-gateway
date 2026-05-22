# SDK scripts

Operator entry points for the soroban-fireblocks-sdk.

## Unified CLI — `npm run cli`

Single subcommand-style entry point covering every contract method. The CLI auto-resolves the signing role per method and only validates env vars the invoked command needs — missing vars for roles you don't own never block other commands.

```bash
npm run cli -- --help                                       # list commands
npm run cli -- roles                                        # what roles are configured locally
npm run cli -- <command> --help                             # per-command flags
npm run cli -- pause --contract C... --dry-run              # preview, no signing
npm run cli -- pause                                        # PAUSER signs
npm run cli -- mint --to G... --amount 1000000000           # MINTER signs
npm run cli -- transfer-sac-admin --new-sac-admin G...      # ADMIN signs (prompts before submit)
npm run cli -- transfer-sac-admin --new-sac-admin G... --yes
npm run cli -- query-paused --contract C...                 # view, no signing
```

### Global flags

| Flag        | Purpose                                                                 |
|-------------|-------------------------------------------------------------------------|
| `--dry-run` | Run preflight, print the call preview, exit. No signing, no submission. |
| `--yes`     | Skip the interactive y/N for destructive ops.                           |
| `--json`    | Emit machine-readable JSON on success.                                  |
| `--help`    | Show top-level help or per-command help.                                |

### Argument sources

For each command's flags: CLI flag → env var fallback → error if required and missing. CLI flags always win.

### Role / env layout

Every role has two env vars:
- `<ROLE>_FIREBLOCKS_VAULT_ACCOUNT_ID` — the Fireblocks vault holding the signer key
- `<ROLE>_PUBLIC_KEY` — the Stellar pubkey of that vault

You only need to set the roles you actually control. Run `npm run cli -- roles` to see your current configuration.

| Role                       | Covers                                                                       |
|----------------------------|------------------------------------------------------------------------------|
| `ADMIN`                    | All admin setters, `upgrade`, `transfer-sac-admin`, `reconcile-burn`, role-op grant/revoke |
| `MINTER`                   | `mint`, `burn`, `set-rate`                                                   |
| `PAUSER`                   | `pause`, `unpause`                                                           |
| `BLOCK_OPERATOR`           | `block-user`, `batch-block-users`                                            |
| `UNBLOCK_OPERATOR`         | `unblock-user`, `batch-unblock-users`                                        |
| `FORCED_TRANSFER_MANAGER`  | `force-transfer`                                                             |
| `YIELD_RECIPIENT_MANAGER`  | `set-yield-recipient`, `claim-yield`                                         |
| `VIEW` (no env)            | All `query-*` commands — only requires `SOROBAN_RPC_URL`, `HORIZON_URL`, `SOROBAN_NETWORK_PASSPHRASE` |

## Legacy scripts (still supported)

These predate the CLI and remain for muscle memory / direct script invocations:

| Script               | Equivalent CLI command           |
|----------------------|----------------------------------|
| `npm run mint`       | `npm run cli -- mint`            |
| `npm run burn`       | `npm run cli -- burn`            |
| `npm run query`      | `npm run cli -- query-admin`     |
| `npm run trustline`  | (no CLI equivalent yet)          |
| `npm run deploy`     | (no CLI equivalent — orchestrates 5 sub-txs) |

## Adding a new contract method

1. Add the wrapper in [`src/sctoken-client.ts`](../src/sctoken-client.ts) + matching type in [`sctoken-types.ts`](../src/sctoken-types.ts).
2. Add a unit test in [`tests/unit/sctoken-client.test.ts`](../tests/unit/sctoken-client.test.ts).
3. Add an entry in [`scripts/cli/registry.ts`](cli/registry.ts).
4. Add the method name to **both** [`tests/unit/parity.test.ts`](../tests/unit/parity.test.ts) and [`tests/unit/cli-registry.test.ts`](../tests/unit/cli-registry.test.ts) `EXPECTED_CONTRACT_METHODS` arrays.

Both parity tests must list it; that's the forcing function that prevents surface drift.
