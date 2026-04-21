use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Vec};

use super::setup::*;

/// Verifies that batch operations at MAX_BATCH_SIZE (40) stay within
/// Soroban per-transaction resource limits (SLP-0001):
///   - Write entries ≤ 50
///   - Read entries ≤ 100
///   - CPU instructions ≤ 100M
///   - Events size ≤ 16,384 bytes
///
/// `reset_unlimited()` disables the harness's internal budget (which
/// accumulates auth-recording cost across calls within a single test);
/// on mainnet each transaction gets its own budget, so resource fit is
/// asserted against the reported `cost_estimate().resources()` values
/// which are per-transaction.
#[test]
fn test_batch_at_max_size_within_resource_limits() {
    let s = setup();
    let mut accounts: Vec<Address> = Vec::new(&s.env);
    for _ in 0..40 {
        accounts.push_back(Address::generate(&s.env));
    }

    s.env.cost_estimate().budget().reset_unlimited();
    s.contract
        .batch_unfreeze_accounts(&s.distributor, &accounts);
    assert_slp_0001_compliant(&s.env);

    // Freeze on authorized accounts exercises the heavier path — real auth
    // flip plus 40 AccountFrozen events.
    s.env.cost_estimate().budget().reset_unlimited();
    s.contract.batch_freeze_accounts(&s.distributor, &accounts);
    assert_slp_0001_compliant(&s.env);
}

fn assert_slp_0001_compliant(env: &Env) {
    let est = env.cost_estimate().resources();
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
