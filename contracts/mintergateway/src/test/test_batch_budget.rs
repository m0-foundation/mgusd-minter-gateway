extern crate std;

use soroban_env_host::InvocationResourceLimits;
use soroban_sdk::testutils::cost_estimate::NetworkInvocationResourceLimits;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use crate::constants::MAX_BATCH_SIZE;

use super::setup::*;

/// Verifies that batch operations at MAX_BATCH_SIZE (18) stay within
/// Soroban per-transaction resource limits (SLP-0001):
///   - Write entries ≤ 50
///   - Read entries ≤ 100
///   - CPU instructions ≤ 100M
///   - Events size ≤ 16,384 bytes
#[test]
fn test_batch_at_max_size_within_resource_limits() {
    let s = setup();
    // Bypass the Rust SDK test harness's shadow budget, which is consumed by
    // `get_authenticated_authorizations` serializing auth trees for test
    // instrumentation — not a constraint enforced on-chain or in preflight.
    // The SLP-0001 assertions below measure the real mainnet resource use.
    s.env.cost_estimate().budget().reset_unlimited();

    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..MAX_BATCH_SIZE {
        accounts.push_back(Address::generate(&s.env));
    }

    s.contract.batch_onboard_users(&accounts, &s.onboarder);
    let est = s.env.cost_estimate().resources();

    // SLP-0001 per-transaction limits (with safety margin)
    assert!(
        est.write_entries <= 50,
        "write_entries {} exceeds limit 50",
        est.write_entries
    );
    assert!(
        est.memory_read_entries + est.disk_read_entries <= 100,
        "total read entries {} exceeds limit 100",
        est.memory_read_entries + est.disk_read_entries
    );
    assert!(
        est.instructions <= 100_000_000,
        "instructions {} exceeds limit 100M",
        est.instructions
    );
    assert!(
        est.contract_events_size_bytes <= 16_384,
        "events size {} exceeds limit 16384",
        est.contract_events_size_bytes
    );
}

/// Executes `batch_onboard_users` with exactly MAX_BATCH_SIZE accounts under
/// TODAY'S live network limits, then prints the measured resource use.
///
/// To explore the limit: change MAX_BATCH_SIZE in constants.rs and re-run
/// with `cargo test -p mintergateway live_network -- --nocapture`.
///
/// Live per-transaction limits (verified on-chain 2026-08-03 on both testnet
/// and mainnet via getLedgerEntries; see https://lab.stellar.org/network-limits):
///   - 200 write ledger entries
///   - 400 footprint entries
///   - 400M CPU instructions
///   - 16,384 bytes of contract events
///
/// Each account in a batch costs 2 ledger writes and ~320 bytes of events
/// (two events: SAC set_authorized + gateway user_onboarded), so the binding
/// constraint is EVENT SIZE: a batch of 51 fits, 52 is rejected.
///
/// Note: the SDK enforces `InvocationResourceLimits::mainnet()` by default,
/// but that is a stale snapshot (50 writes / 100 footprint entries — the
/// SLP-0001 values behind MAX_BATCH_SIZE = 18), so this test overrides it
/// with the live values.
#[test]
fn test_batch_at_max_size_within_live_network_limits() {
    let s = setup();

    let mut limits = InvocationResourceLimits::mainnet();
    limits.instructions = 400_000_000;
    limits.disk_read_entries = 200;
    limits.write_entries = 200;
    limits.ledger_entries = 400;
    // limits.contract_events_size_bytes is already the live value (16,384) —
    // the one limit no SLP upgrade has ever raised.
    s.env.cost_estimate().enforce_resource_limits(limits);

    // Bypass the Rust SDK test harness's shadow budget, which is consumed by
    // test instrumentation — not a constraint enforced on-chain.
    s.env.cost_estimate().budget().reset_unlimited();

    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..MAX_BATCH_SIZE {
        accounts.push_back(Address::generate(&s.env));
    }

    s.contract.batch_onboard_users(&accounts, &s.onboarder);

    let est = s.env.cost_estimate().resources();
    std::println!(
        "batch of {}: writes {}/200, footprint {}/400, cpu {:.1}M/400M, events {}/16384 bytes",
        MAX_BATCH_SIZE,
        est.write_entries,
        est.write_entries + est.memory_read_entries + est.disk_read_entries,
        est.instructions as f64 / 1_000_000.0,
        est.contract_events_size_bytes
    );
}
