# SMA Bridge Mint — Design Overview

## 1. Overview

- SMA Bridge Mint is a **Soroban smart contract** that acts as the **admin of a Stellar Asset Contract (SAC)**
- It wraps a classic Stellar asset into a **yield-bearing token** — minting/burning SAC tokens directly
- Yield accrues continuously on principal using an exponential index (`e^(rate × time)`) and is **non-compounding** — claimed yield does not earn more yield
- The contract never holds user funds — it orchestrates SAC operations (mint, clawback, authorize) on behalf of designated roles

---

## 2. Architecture Diagram

*(Insert existing diagram here)*

---

## 3. Roles

| Role | Permissions |
|------|------------|
| **Admin** | Set all other roles, freeze/unfreeze accounts, clawback tokens |
| **Minter** | Mint (wrap), burn (unwrap), set interest rate |
| **Yield Recipient Manager** | Set the yield recipient address |
| **Yield Recipient** | Claim accrued yield |
| **Forced Transfer Manager** | Atomic authorize-transfer-refreeze between accounts |

- All roles are single-address (one holder per role)
- Only Admin can reassign roles (except Yield Recipient, managed by YRM)
- Each role requires `require_auth()` on every call

---

## 4. Minter Gateway

The Minter acts as the **bridge gateway** — the sole entry point for supply changes.

**Mint (Wrap)**
- Minter calls `mint(to, amount)`
- Finalizes pending yield → increases both `total_principal` and `total_supply` → mints SAC tokens to recipient
- Recipient must already be authorized (unfrozen) at the SAC layer

**Burn (Unwrap)**
- Minter calls `burn(from, amount)`
- Finalizes pending yield → decreases both accumulators → clawbacks SAC tokens from account
- Capped: cannot burn more than `total_principal` (prevents burning claimed yield)
- Does NOT require the target account's authorization

**Set Rate**
- Minter calls `set_rate(rate_bps)` — basis points (100 = 1%, max 10,000 = 100%)
- Finalizes yield at old rate before applying the new rate
- No-op if rate is unchanged

**Key properties:**
- No pause checks on minter actions — minter is a trusted role
- Always updates the yield index before modifying supply (prevents yield loss)
- Emits `sup_sync` event with delta and new accumulator values

---

## 5. Yield Mechanics

- **Continuous index model**: `index = latestIndex × e^(rate × elapsed / SECONDS_PER_YEAR)`
- **Two accumulators** track state:
  - `total_principal` — yield-earning base (mints minus burns)
  - `total_supply` — total outstanding tokens (principal + claimed yield)
- **Yield formula**: `yield = total_principal × (newIndex - oldIndex) / INDEX_SCALE`
- **Non-compounding**: `claim_yield()` mints new SAC tokens to the yield recipient but does NOT increase `total_principal` — future yield still calculated on original principal only
- **Index updated** on every state-changing operation (mint, burn, clawback, claim, set_rate)

---

## 6. Transfers & the Issuer Burn Problem

**How SAC transfers work:**
- Both sender AND receiver must be authorized (unfrozen) for a transfer to succeed
- Transfers happen at the SAC layer — the contract does not intermediate them
- The contract has no `transfer()` function — users call the SAC's standard SEP-41 `transfer()` directly

**The issuer burn problem:**
- On classic Stellar, sending tokens to the **issuer address** burns them automatically
- If a user sends SMA tokens to the issuer, those tokens are destroyed at the SAC layer — but the contract's `total_principal` and `total_supply` are **never updated**
- This breaks the yield invariant: the contract thinks more tokens exist than actually do, and yield keeps accruing on phantom principal

**How this contract prevents it:**
- SAC is configured with `AUTH_REQUIRED` — all accounts start frozen
- Accounts can only transact after Admin explicitly calls `unfreeze_account()`
- `authorize_and_transfer` deliberately **re-freezes** the recipient after transferring, so they hold tokens but cannot move them (including to the issuer)
- To allow free transfers, Admin must consciously unfreeze an account, accepting the risk

---

## 7. Compliance & Safety

**Freeze / Unfreeze**
- SAC operates in `AUTH_REQUIRED` mode — accounts are unauthorized (frozen) by default
- Admin calls `unfreeze_account(addr)` → SAC `set_authorized(true)` → account can send/receive
- Admin calls `freeze_account(addr)` → SAC `set_authorized(false)` → account blocked

**Clawback**
- Admin calls `clawback(from, amount)` — force-removes tokens without target's consent
- Updates both accumulators (same as burn) — capped at `total_principal`
- Finalizes yield before executing

**Authorize & Transfer**
- Forced Transfer Manager calls `authorize_and_transfer(from, to, amount)`
- Atomic: authorize recipient → transfer → re-freeze recipient
- Requires `from.require_auth()` (sender must consent)
- Does NOT update accumulators (balance redistribution, not mint/burn)
- Prevents recipients from accidentally burning tokens by sending to the issuer
