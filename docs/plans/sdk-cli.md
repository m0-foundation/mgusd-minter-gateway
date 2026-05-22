# Plan: Unified SDK CLI (Phase 3, consolidated)

**Branch:** `feat/sdk-contract-parity`
**Reference:** [sdk-contract-parity.md](sdk-contract-parity.md) for Phase 1 + 2 (already implemented).

## Goal

Replace ad-hoc per-method scripts with a single CLI that:
- Exposes every contract method as a subcommand.
- Auto-resolves the signing role from the method.
- **Only validates env vars the invoked command needs** — missing vars for roles you don't own never block.
- Supports `--dry-run` (simulate + print unsigned XDR), `--yes` (skip confirmation), `--json` (structured output).
- Requires interactive confirmation for destructive operations by default.

## What stays as-is from current unstaged work

- [src/scval-helpers.ts](../../soroban-fireblocks-sdk/src/scval-helpers.ts) + test (`bytesN32ToScVal`)
- [src/sctoken-types.ts](../../soroban-fireblocks-sdk/src/sctoken-types.ts) (8 new param interfaces)
- [src/sctoken-client.ts](../../soroban-fireblocks-sdk/src/sctoken-client.ts) (11 new wrappers)
- [src/index.ts](../../soroban-fireblocks-sdk/src/index.ts) (re-exports of new types/helper)
- [tests/unit/sctoken-client.test.ts](../../soroban-fireblocks-sdk/tests/unit/sctoken-client.test.ts) (+18 wrapper tests)
- [tests/unit/parity.test.ts](../../soroban-fireblocks-sdk/tests/unit/parity.test.ts)
- [sdk-contract-parity.md](sdk-contract-parity.md)

## What gets restructured

| File | Action | Reason |
|---|---|---|
| [src/config.ts](../../soroban-fireblocks-sdk/src/config.ts) | Extend role enum to all 7 roles (`ISSUER`, `MINTER`, `PAUSER`, `ADMIN`, `BLOCK_OPERATOR`, `UNBLOCK_OPERATOR`, `FORCED_TRANSFER_MANAGER`, `YIELD_RECIPIENT_MANAGER`). Add `loadXxxConfigFromEnv` per role + new `loadReadOnlyConfigFromEnv` + `validateReadOnlyConfig` for view commands. | CLI auto-resolves per command; views need no signing creds. |
| [src/index.ts](../../soroban-fireblocks-sdk/src/index.ts) | Re-export new role loaders + read-only loader. | API surface. |
| [.env.example](../../soroban-fireblocks-sdk/.env.example) | Add `ADMIN_FIREBLOCKS_VAULT_ACCOUNT_ID`, `BLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID`, etc. for each role. All are optional — only loaded by the command that needs them. | Document the surface; nothing required upfront. |
| [tests/unit/config.test.ts](../../soroban-fireblocks-sdk/tests/unit/config.test.ts) | Mirror the PAUSER test pattern for each new loader + tests for the read-only loader. | Coverage for new loaders. |
| [package.json](../../soroban-fireblocks-sdk/package.json) | Drop `pause`/`unpause`; add `"cli": "ts-node scripts/cli.ts"`. Leave `mint`/`burn`/`deploy`/`query`/`trustline` alone for now. | Single new entrypoint. |
| [scripts/invoke-pause.ts](../../soroban-fireblocks-sdk/scripts/invoke-pause.ts) | **Delete** — subsumed by `npm run cli -- pause`. | Single source of truth; no drift. |
| [scripts/invoke-unpause.ts](../../soroban-fireblocks-sdk/scripts/invoke-unpause.ts) | **Delete** — subsumed by `npm run cli -- unpause`. | Same. |

## What gets added

```
scripts/
├── cli.ts                      # argv → parser → executor
└── cli/
    ├── registry.ts             # declarative CommandSpec[] — one entry per method
    ├── executor.ts             # role resolve → preflight → dry-run? → confirm? → invoke → postcheck
    ├── role-config.ts          # role → loader function (incl. VIEW → loadReadOnlyConfigFromEnv)
    ├── args.ts                 # hand-rolled argv parser + type coercion (string|bigint|hex32|address)
    └── prompt.ts               # readline-based y/N confirm

tests/unit/
├── cli-args.test.ts            # parser unit tests
├── cli-registry.test.ts        # asserts every method in parity.test.ts's EXPECTED_CONTRACT_METHODS has a registry entry
└── cli-executor.test.ts        # role resolution, lazy env validation, dry-run path, confirmation gating
```

## CommandSpec shape

```ts
type CommandSpec = {
  name: string;                     // "transfer-sac-admin"
  contractMethod: string;           // "transfer_sac_admin"
  role: Role | "VIEW";              // "ADMIN" | "MINTER" | ... | "VIEW"
  args: ArgSpec[];                  // [{ name, type, source: 'flag' | 'env', envVar?, required }]
  destructive?: boolean;            // require confirm unless --yes
  preflight?: (client, ctx) => Promise<void>;   // e.g. pause: queryPauser === sourcePublicKey
  invoke: (client, args, ctx) => Promise<InvokeResult | string>;
  postcheck?: (client, ctx) => Promise<void>;   // e.g. pause: queryPaused === true
};
```

Adding a future method = one new registry entry (~8 lines) + matching wrapper if missing.

## Lazy env-validation contract

The CLI loads **only the env vars the invoked command needs**. No upfront full-config check. Error messages name only the missing vars for the current command.

| Command | Required env | If unrelated role vars are missing |
|---|---|---|
| `pause` / `unpause` | `PAUSER_*` + shared signing (Fireblocks creds, RPC, passphrase) | No effect — never inspected |
| `mint` / `burn` / `set-rate` | `MINTER_*` + shared signing | No effect |
| Admin setters / `upgrade` / `transfer-sac-admin` / `reconcile-burn` | `ADMIN_*` + shared signing | No effect |
| `block-user` / `batch-block-users` | `BLOCK_OPERATOR_*` + shared signing | No effect |
| `unblock-user` / `batch-unblock-users` | `UNBLOCK_OPERATOR_*` + shared signing | No effect |
| `force-transfer` | `FORCED_TRANSFER_MANAGER_*` + shared signing | No effect |
| `set-yield-recipient` / `claim-yield` | `YIELD_RECIPIENT_MANAGER_*` + shared signing | No effect |
| `query *` | shared read-only only (RPC, passphrase, HORIZON_URL) | No effect — no Fireblocks creds needed |
| `--help` / `roles` | nothing | Runs with zero env |

Error template:

```
Error: `npm run cli -- pause` requires:
  PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID  (not set)
  PAUSER_PUBLIC_KEY                   (not set)
  FIREBLOCKS_SECRET_PATH              (not set)
See .env.example for the full role env layout.
```

## Command surface

```bash
npm run cli -- --help                                       # list commands
npm run cli -- roles                                        # show which roles are configured locally
npm run cli -- pause --contract C...                        # PAUSER role
npm run cli -- pause                                        # contract from CONTRACT_ID env
npm run cli -- pause --dry-run                              # simulate + print unsigned XDR, no signing
npm run cli -- unpause --yes                                # skip confirmation
npm run cli -- mint --to G... --amount 1000000000           # MINTER role
npm run cli -- transfer-sac-admin --new-sac-admin G...      # ADMIN role; prompts (destructive)
npm run cli -- upgrade --wasm-hash 0xabc...                 # ADMIN role; prompts
npm run cli -- set-admin --new-admin G... --yes             # ADMIN role; bypass prompt for scripted use
npm run cli -- query paused                                 # view, no signing
npm run cli -- query pauser
npm run cli -- query balance --account G...
```

## Phased implementation

### Phase A — Config layer (~45 min)

1. Extend `loadRoleConfigFromEnv` role union to include `ADMIN`, `BLOCK_OPERATOR`, `UNBLOCK_OPERATOR`, `FORCED_TRANSFER_MANAGER`, `YIELD_RECIPIENT_MANAGER`.
2. Add `loadAdminConfigFromEnv`, `loadBlockOperatorConfigFromEnv`, `loadUnblockOperatorConfigFromEnv`, `loadForcedTransferManagerConfigFromEnv`, `loadYieldRecipientManagerConfigFromEnv`.
3. Add `loadReadOnlyConfigFromEnv` + `validateReadOnlyConfig`. Read-only requires only `SOROBAN_RPC_URL`, `SOROBAN_NETWORK_PASSPHRASE`, `HORIZON_URL`. Fireblocks fields stay empty strings.
4. Re-export from `index.ts`.
5. Update `.env.example` with each role's `*_FIREBLOCKS_VAULT_ACCOUNT_ID` line, commented as optional ("only needed if you own this role's vault").
6. Tests: mirror PAUSER tests for each new loader (5 × 3 = 15 tests) + 3 tests for the read-only loader.

**Acceptance:** `npm test` green; `npm run build` clean.

### Phase B — CLI scaffold (~1.5–2 hr)

1. Hand-rolled `args.ts` argv parser (~80 LOC, no deps). Handles `--flag value`, `--flag=value`, positional subcommand, `--help`, `--dry-run`, `--yes`, `--json`.
2. `role-config.ts` — `Role → loader` map including `"VIEW" → loadReadOnlyConfigFromEnv`.
3. `prompt.ts` — readline y/N (~15 LOC).
4. `executor.ts` — given a `CommandSpec` + parsed args:
   - resolve role → call only that loader
   - if loader throws on missing env → reformat error to name only the relevant vars
   - instantiate `SctokenFireblocksClient`
   - run `preflight` if defined
   - if `--dry-run`: simulate, print unsigned XDR + base64, exit 0
   - if `destructive` && !`--yes`: prompt
   - invoke
   - run `postcheck` if defined
   - log tx hash / ledger / explorer URL (or `--json` structured output)
5. `cli.ts` — entrypoint, dispatches to a registered command or prints `--help`.
6. Tests:
   - `cli-args.test.ts` — parser cases
   - `cli-executor.test.ts` — role resolution, lazy validation (pause works with only PAUSER vars), dry-run path doesn't sign, confirmation gates destructive ops, view path doesn't load Fireblocks creds.

**Acceptance:** `npm run cli -- --help` runs with zero env; `npm run cli -- pause --dry-run` prints unsigned XDR without contacting Fireblocks.

### Phase C — Register all methods (~1 hr)

1. Populate `registry.ts`:
   - **22 state-changing commands** (each maps to a wrapper)
   - **17 view commands** under `query` subcommand namespace
2. **Preflight + postcheck for pause / unpause:**
   - preflight: `queryPauser === config.sourcePublicKey` (loud fail with both addresses if not)
   - postcheck: `queryPaused` matches expected post-state
3. **Destructive list** (require confirm by default): `transfer-sac-admin`, `upgrade`, `set-admin`, `set-pauser`, `set-minter`, `set-yield-recipient-manager`, `set-forced-transfer-manager`, `set-yield-recipient`, `pause`, `unpause`.
4. **`roles` subcommand** — ~30 LOC. Reads `*_PUBLIC_KEY` + `*_FIREBLOCKS_VAULT_ACCOUNT_ID` for each role; tabulates configured/not-configured + pubkey if present.
5. `cli-registry.test.ts` — assert every entry in `parity.test.ts`'s `EXPECTED_CONTRACT_METHODS` has exactly one `CommandSpec` whose `contractMethod` matches. This is the third layer of the parity defense (after the source-scan parity test and the per-wrapper unit tests).

**Acceptance:** all 39 subcommands listed in `--help`; `npm run cli -- query paused` runs end-to-end against testnet without signing; `npm run cli -- roles` shows your configured roles.

### Phase D — Cleanup (~15 min)

1. Delete [scripts/invoke-pause.ts](../../soroban-fireblocks-sdk/scripts/invoke-pause.ts), [scripts/invoke-unpause.ts](../../soroban-fireblocks-sdk/scripts/invoke-unpause.ts).
2. Remove `pause`/`unpause` from [package.json](../../soroban-fireblocks-sdk/package.json) scripts.
3. Update [.env.example](../../soroban-fireblocks-sdk/.env.example) header comment to point at `npm run cli -- --help`.
4. Brief note in the SDK README (or new `scripts/README.md`) on the CLI usage pattern.

**Acceptance:** working tree shows the two scripts removed; `npm test` and `npm run build` green; documentation points at the new entrypoint.

## Defaults locked

1. **Hand-rolled argv parser.** No new dep on a security-relevant tool.
2. **`pause` / `unpause` are destructive** (require confirm). They're reversible but production-impacting. `--yes` bypasses for scripted use.
3. **Delete `invoke-pause.ts` / `invoke-unpause.ts`** as part of Phase D. Single source of truth.
4. **`mint` / `burn` / `deploy` / `query-admin` / `trustline` stay as separate scripts for now.**

## Risks

| Risk | Mitigation |
|---|---|
| **Lazy validation hides typos.** Setting `MINTR_PUBLIC_KEY` instead of `MINTER_PUBLIC_KEY` would surface as "MINTER_PUBLIC_KEY not set" rather than "did you mean MINTER_PUBLIC_KEY?". | Acceptable. The error message names the *expected* var clearly. A typo-suggestion engine is over-scope. |
| **Hand-rolled parser drift.** Adding novel arg shapes later (e.g., `--flag=a,b,c` lists) requires parser changes. | Tests in `cli-args.test.ts` pin every shape we support. If a future need needs new syntax, that's a one-line parser change with a corresponding test. |
| **`--dry-run` simulates the tx but doesn't fully execute — the operator might read the XDR wrong.** | Print both XDR base64 *and* a human-readable summary (method name, args, source vault, role). Operator can also paste XDR into Stellar Lab for full decode. |
| **`destructive` boolean is a judgment call.** Pause/unpause being destructive could be wrong if you'd rather have them be one-keystroke ops in a control room. | Easy to flip — single boolean in the registry entry. We can revisit after first use. |

## Complexity estimate

| Phase | LOC delta | Effort |
|---|---|---|
| A — Config | +130 src + +180 tests | 45 min |
| B — CLI scaffold | +260 src + +220 tests | 1.5–2 hr |
| C — Registry + roles | +280 src + +80 tests | 1 hr |
| D — Cleanup | −80 (scripts) + +40 (docs) | 15 min |
| **Total** | ~110 net src + ~480 tests | ~3.5 hr |

## Success criteria

- [ ] `npm run cli -- --help` lists every contract method with no env vars set.
- [ ] `npm run cli -- query paused` runs end-to-end against testnet with only `SOROBAN_RPC_URL` / `HORIZON_URL` / `SOROBAN_NETWORK_PASSPHRASE` set.
- [ ] `npm run cli -- pause --dry-run` produces an unsigned XDR without touching Fireblocks.
- [ ] `npm run cli -- pause` with only `PAUSER_*` + Fireblocks creds completes a real testnet pause (flipping `queryPaused`).
- [ ] `npm run cli -- mint` with only `PAUSER_*` set fails with an error naming only `MINTER_*` vars — not ADMIN, not BLOCK_OPERATOR.
- [ ] `npm run cli -- roles` accurately reports which roles you have configured.
- [ ] `cli-registry.test.ts` would fail if a contract method were added to `parity.test.ts` without a matching registry entry.
- [ ] All existing 120 tests still green; new test count: ~520 total.
