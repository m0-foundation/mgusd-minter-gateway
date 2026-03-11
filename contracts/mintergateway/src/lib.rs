#![no_std]

mod admin;
mod constants;
mod continuous_index;
mod contract;
mod errors;
mod events;
mod roles;
mod sac_token;
mod storage_types;
mod yield_state;

pub use crate::contract::YieldTokenClient;
pub use crate::errors::*;

#[cfg(test)]
mod test;
