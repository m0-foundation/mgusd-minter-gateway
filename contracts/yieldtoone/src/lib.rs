#![no_std]

mod admin;
mod continuous_index;
mod contract;
mod events;
mod roles;
mod sac_token;
mod storage_types;
mod yield_state;

pub use crate::contract::YieldTokenClient;

#[cfg(test)]
mod test;
