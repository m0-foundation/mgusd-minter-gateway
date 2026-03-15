pub use soroban_sdk::{
    testutils::{IssuerFlags, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env,
};

use soroban_sdk::testutils::Address as _;

#[allow(unused_imports)]
pub use crate::continuous_index::{
    convert_from_basis_points, current_index, exponent, get_continuous_index,
    multiply_indices_down, INDEX_SCALE, SECONDS_PER_YEAR,
};
pub use crate::contract::{YieldToken, YieldTokenClient};

pub const T0: u64 = 1_000_000; // Arbitrary start timestamp

pub struct TestSetup<'a> {
    pub env: Env,
    pub contract: YieldTokenClient<'a>,
    pub sac_token: TokenClient<'a>,
    pub admin: Address,
    pub issuer: Address,
    pub minter: Address,
    pub yield_recipient_manager: Address,
    pub yield_recipient: Address,
    pub forced_transfer_manager: Address,
    pub distributor: Address,
}

pub fn setup() -> TestSetup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);

    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let yield_recipient_manager = Address::generate(&env);
    let yield_recipient = Address::generate(&env);
    let forced_transfer_manager = Address::generate(&env);
    let distributor = Address::generate(&env);

    // Register SAC token with admin as initial issuer
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let issuer_handle = sac.issuer();
    let issuer = issuer_handle.address();
    issuer_handle.set_flag(IssuerFlags::RequiredFlag);
    issuer_handle.set_flag(IssuerFlags::RevocableFlag);
    issuer_handle.set_flag(IssuerFlags::ClawbackEnabledFlag);
    let sac_addr = sac.address();
    let sac_token = TokenClient::new(&env, &sac_addr);
    let sac_admin_client = StellarAssetClient::new(&env, &sac_addr);

    // Register the yield token contract
    let contract_addr = env.register(
        YieldToken,
        (
            &sac_addr,
            &admin,
            &minter,
            &yield_recipient_manager,
            &yield_recipient,
            &forced_transfer_manager,
            &distributor,
        ),
    );
    let contract = YieldTokenClient::new(&env, &contract_addr);

    // Set yield contract as SAC admin (so it can mint/clawback)
    sac_admin_client.set_admin(&contract_addr);

    // Authorize yield_recipient so claim_yield can mint to it (AUTH_REQUIRED mode)
    contract.unfreeze_account(&admin, &yield_recipient);

    TestSetup {
        env,
        contract,
        sac_token,
        admin,
        issuer,
        minter,
        yield_recipient_manager,
        yield_recipient,
        forced_transfer_manager,
        distributor,
    }
}

/// Same as `setup()` but switches to enforcing auth mode with no entries.
/// Calls to functions with `require_auth()` will revert unless explicitly mocked.
pub fn setup_no_mock_auth() -> TestSetup<'static> {
    let s = setup();
    s.env.mock_auths(&[]);
    s
}

/// The Soroban host error returned when `require_auth()` fails.
pub fn auth_error() -> soroban_sdk::Error {
    soroban_sdk::Error::from_type_and_code(
        soroban_sdk::xdr::ScErrorType::Context,
        soroban_sdk::xdr::ScErrorCode::InvalidAction,
    )
}

pub fn advance_time(env: &Env, seconds: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set_timestamp(current + seconds);
}

pub mod dummy_issuer {
    use soroban_sdk::{contract, contractimpl, Env};

    #[contract]
    pub struct DummyIssuer;

    #[contractimpl]
    impl DummyIssuer {
        pub fn __constructor(_e: Env) {}
    }
}
