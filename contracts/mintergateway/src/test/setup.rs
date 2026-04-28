pub use soroban_sdk::{
    testutils::{Events as _, IssuerFlags, Ledger},
    token::{StellarAssetClient, TokenClient},
    xdr, Address, BytesN, Env, Event,
};

use soroban_sdk::testutils::Address as _;

#[allow(unused_imports)]
pub use crate::continuous_index::{
    convert_from_basis_points, current_index, exponent, get_continuous_index,
    multiply_indices_down, INDEX_SCALE, SECONDS_PER_YEAR,
};
pub use crate::contract::{YieldToken, YieldTokenClient};

pub const T0: u64 = 1_000_000; // Arbitrary start timestamp
pub const DECIMALS: i128 = 10_000_000; // 1 token = 10^7 stroops

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
    pub block_operator: Address,
    pub unblock_operator: Address,
    pub pauser: Address,
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
    // Default to separate block and unblock operators so the role split is
    // exercised across the suite. Tests that need a single address holding
    // both roles construct that case explicitly.
    let block_operator = Address::generate(&env);
    let unblock_operator = Address::generate(&env);
    let pauser = Address::generate(&env);

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
            &block_operator,
            &unblock_operator,
            &pauser,
        ),
    );
    let contract = YieldTokenClient::new(&env, &contract_addr);

    // Set yield contract as SAC admin (so it can mint/clawback)
    sac_admin_client.set_admin(&contract_addr);

    // Authorize yield_recipient so claim_yield can mint to it (AUTH_REQUIRED mode)
    contract.unblock_user(&yield_recipient, &unblock_operator);

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
        block_operator,
        unblock_operator,
        pauser,
    }
}

/// Same as `setup()` but switches to enforcing auth mode with no entries.
/// Calls to functions with `require_auth()` will revert unless explicitly mocked.
pub fn setup_no_mock_auth() -> TestSetup<'static> {
    let s = setup();
    s.env.mock_auths(&[]);
    s
}

impl TestSetup<'_> {
    /// Assert the most recent event emitted by the gateway contract equals
    /// `expected`. Must be called immediately after the emitting invocation —
    /// any subsequent top-level contract call (including view fns) resets the
    /// host event buffer.
    pub fn assert_event<E: Event>(&self, expected: E) {
        let events = self
            .env
            .events()
            .all()
            .filter_by_contract(&self.contract.address);
        let actual = events.events().last().expect("no gateway event").clone();
        assert_eq!(actual, expected.to_xdr(&self.env, &self.contract.address));
    }

    /// Assert the last `expected.len()` gateway events match `expected` in
    /// order. Each entry is the XDR form of a `#[contractevent]` struct,
    /// built via `Event::to_xdr`.
    pub fn assert_events_tail(&self, expected: &[xdr::ContractEvent]) {
        let events = self
            .env
            .events()
            .all()
            .filter_by_contract(&self.contract.address);
        let actual = events.events();
        let n = expected.len();
        assert!(
            actual.len() >= n,
            "expected at least {} gateway events, got {}",
            n,
            actual.len(),
        );
        let tail = &actual[actual.len() - n..];
        assert_eq!(tail, expected);
    }

    /// Assert the gateway contract has not emitted any events since the last
    /// top-level invocation.
    pub fn assert_no_events(&self) {
        let events = self
            .env
            .events()
            .all()
            .filter_by_contract(&self.contract.address);
        assert!(
            events.events().is_empty(),
            "expected no gateway events, got {}",
            events.events().len(),
        );
    }
}

/// Build a fixed-size array of `xdr::ContractEvent` from a list of
/// `#[contractevent]` structs, converting each via `Event::to_xdr`.
/// Pairs with `TestSetup::assert_events_tail`.
///
/// Example:
/// ```ignore
/// s.assert_events_tail(&gateway_events![s,
///     UpdateIndex { latest_index },
///     Mint { to, amount, new_total_principal, new_total_supply },
/// ]);
/// ```
#[macro_export]
macro_rules! gateway_events {
    ($s:expr, $($event:expr),+ $(,)?) => {
        [
            $(
                soroban_sdk::Event::to_xdr(
                    &$event,
                    &$s.env,
                    &$s.contract.address,
                )
            ),+
        ]
    };
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
