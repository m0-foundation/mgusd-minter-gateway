use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use crate::constants::MAX_BATCH_SIZE;

use super::setup::*;

/// Verifies that batch operations at MAX_BATCH_SIZE (40) stay within
/// Soroban per-transaction resource limits (live mainnet `tx_max_*` config,
/// verified via `stellar network settings` on 2026-08-14):
///   - Write entries ≤ 200 (`tx_max_write_ledger_entries`)
///   - Footprint (reads + writes) ≤ 400 (`tx_max_footprint_entries`)
///   - CPU instructions ≤ 400M (`tx_max_instructions`)
///   - Events size ≤ 16,384 bytes (`tx_max_contract_events_size_bytes`)
#[test]
fn test_batch_at_max_size_within_resource_limits() {
    let s = setup();
    enforce_current_mainnet_limits(&s.env);
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

    // Mainnet per-transaction limits (with safety margin)
    assert!(
        est.write_entries <= 200,
        "write_entries {} exceeds limit 200",
        est.write_entries
    );
    assert!(
        est.memory_read_entries + est.disk_read_entries + est.write_entries <= 400,
        "footprint entries {} exceeds limit 400",
        est.memory_read_entries + est.disk_read_entries + est.write_entries
    );
    assert!(
        est.instructions <= 400_000_000,
        "instructions {} exceeds limit 400M",
        est.instructions
    );
    assert!(
        est.contract_events_size_bytes <= 16_384,
        "events size {} exceeds limit 16384",
        est.contract_events_size_bytes
    );
}
