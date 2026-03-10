# MGUSD Implementation Plan

## Phase 1: Requirements & Architecture Design

Define the contract interface, role model, yield mechanics, and compliance controls for MGUSD on Stellar.

- Five on-chain roles with scoped permissions (Admin, Minter, Yield Recipient Manager, Yield Recipient, Forced Transfer Manager)
- Continuous non-compounding yield model and walled garden compliance design
- Full contract interface specification and end-to-end funds flow mapping

## Phase 2: Soroban Minter Gateway Build

Implement the MGUSD smart contract on Soroban — a SAC admin wrapper with yield accrual, RBAC, and transfer compliance.

- Mint/burn with dual accumulator tracking (total_principal and total_supply)
- Continuous yield streaming via exponential index with fixed-point arithmetic
- Atomic authorize-and-transfer flow for compliant token distribution

## Phase 3: Gateway Minter SDK (Fireblocks Integration)

TypeScript SDK enabling Bridge to operate the contract through Fireblocks institutional custody with MPC signing.

- Fireblocks RAW signing pipeline: build → simulate → hash → MPC sign → submit
- Typed SDK methods for mint, burn, set_rate, deploy, and query operations
- CLI scripts and 5-step orchestrated deployment tooling

## Phase 4: Audit

Independent security review of the Soroban contract and SDK.

- Third-party audit of yield math, access control, and compliance logic
- Assessment of signing pipeline and transaction assembly
- Remediation of all critical and high-severity findings

## Phase 5: Finalization & On-Chain Testing

Address audit findings and validate the full system end-to-end on Stellar testnet.

- Implement remediations with targeted regression tests
- Validate yield accuracy, compliance flows, and contract upgrade path on testnet

## Phase 6: Testnet Deployment & Integration

Shared testnet environment where Bridge, Crossmint, and MoneyGram connect their systems to MGUSD for the first time.

- Bridge, Crossmint, and MoneyGram validate their respective role operations end-to-end
- Full lifecycle testing: fiat-in → mint → distribute → hold → redeem → fiat-out

## Phase 7: Mainnet Launch & Operational Handoff

Production deployment, role assignment to Fireblocks vaults, and operational handoff.

- Deploy to mainnet and assign roles to production addresses
- Deliver operational runbooks, monitoring, and incident response procedures
