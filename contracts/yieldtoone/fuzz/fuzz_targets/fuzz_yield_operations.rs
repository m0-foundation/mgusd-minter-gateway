#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, IssuerFlags, Ledger};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Env};
use yieldtoone::{YieldToken, YieldTokenClient};

const INDEX_SCALE: u128 = 1_000_000_000_000;
const T0: u64 = 1_000_000;

#[derive(Debug, Arbitrary)]
enum Command {
    Mint { amount: u64 },
    Burn { amount: u64 },
    SetRate { rate_bps: u16 },
    AdvanceTime { seconds: u32 },
    ClaimYield,
    Clawback { amount: u64 },
}

#[derive(Debug, Arbitrary)]
struct FuzzInput {
    commands: [Command; 12],
}

fn assert_invariants(contract: &YieldTokenClient<'_>, total_claimed: i128) {
    let principal = contract.total_principal();
    let supply = contract.total_supply();
    let accrued = contract.accrued_yield();
    let current = contract.current_index();
    let latest = contract.latest_index();

    assert!(
        supply >= principal,
        "supply {} < principal {}",
        supply,
        principal
    );
    assert!(principal >= 0, "negative principal {}", principal);
    assert!(supply >= 0, "negative supply {}", supply);
    assert!(accrued >= 0, "negative accrued yield {}", accrued);
    assert!(
        current >= latest,
        "current index {} < latest index {}",
        current,
        latest
    );
    assert!(
        latest >= INDEX_SCALE,
        "index {} below initial 1.0",
        latest
    );

    // supply should equal principal + total claimed yield
    assert_eq!(
        supply,
        principal + total_claimed,
        "supply {} != principal {} + claimed {}",
        supply,
        principal,
        total_claimed
    );
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);

    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let yield_recipient_manager = Address::generate(&env);
    let yield_recipient = Address::generate(&env);
    let forced_transfer_manager = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer_handle = sac.issuer();
    issuer_handle.set_flag(IssuerFlags::RequiredFlag);
    issuer_handle.set_flag(IssuerFlags::RevocableFlag);
    issuer_handle.set_flag(IssuerFlags::ClawbackEnabledFlag);
    let sac_addr = sac.address();
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);

    let contract_addr = env.register(
        YieldToken,
        (
            &sac_addr,
            &admin,
            &minter,
            &yield_recipient_manager,
            &yield_recipient,
            &forced_transfer_manager,
        ),
    );
    let contract = YieldTokenClient::new(&env, &contract_addr);
    sac_admin_client.set_admin(&contract_addr);
    contract.unfreeze_account(&yield_recipient);

    let mut total_claimed: i128 = 0;

    for cmd in &input.commands {
        match cmd {
            Command::Mint { amount } => {
                let amt = (*amount as i128) % 1_000_000_000_000_000; // cap at reasonable size
                if amt > 0 {
                    let _result = contract.try_mint(&minter, &yield_recipient, &amt);
                }
            }
            Command::Burn { amount } => {
                let amt = (*amount as i128) % 1_000_000_000_000_000;
                if amt > 0 {
                    let _ = contract.try_burn(&minter, &yield_recipient, &amt);
                    // may fail with BurnExceedsPrincipal - expected
                }
            }
            Command::SetRate { rate_bps } => {
                let rate = (*rate_bps as u32) % 10_001; // clamp to [0, 10000]
                let _ = contract.try_set_rate(&minter, &rate);
            }
            Command::AdvanceTime { seconds } => {
                let secs = (*seconds as u64) % (86_400 * 365 * 2); // max 2 years at a time
                if secs > 0 {
                    let current = env.ledger().timestamp();
                    env.ledger().set_timestamp(current + secs);
                }
            }
            Command::ClaimYield => {
                match contract.try_claim_yield(&yield_recipient) {
                    Ok(Ok(claimed)) => {
                        total_claimed += claimed;
                    }
                    _ => {}
                }
            }
            Command::Clawback { amount } => {
                let amt = (*amount as i128) % 1_000_000_000_000_000;
                if amt > 0 {
                    let _ = contract.try_clawback(&yield_recipient, &amt);
                    // may fail - expected
                }
            }
        }

        assert_invariants(&contract, total_claimed);
    }
});
