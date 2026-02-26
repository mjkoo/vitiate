mod coverage;
mod engine;
mod types;

use napi_derive::napi;

#[napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
