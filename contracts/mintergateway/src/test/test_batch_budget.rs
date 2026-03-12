use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use super::setup::*;

/// Verifies that batch operations at MAX_BATCH_SIZE (20) stay within
/// Soroban per-transaction resource limits (SLP-0001):
///   - Write entries ≤ 50
///   - Read entries ≤ 100
///   - CPU instructions ≤ 100M
///   - Events size ≤ 16,384 bytes
#[test]
fn test_batch_at_max_size_within_resource_limits() {
    let s = setup();
    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..20 {
        accounts.push_back(Address::generate(&s.env));
    }

    s.contract
        .batch_unfreeze_accounts(&s.distributor, &accounts);
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
