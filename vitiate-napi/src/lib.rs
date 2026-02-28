mod cmplog;
mod coverage;
mod engine;
mod input_stash;
mod trace;
mod types;
mod v8_shim;
mod watchdog;

use napi_derive::napi;

#[napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
