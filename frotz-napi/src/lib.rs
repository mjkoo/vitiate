#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub fn version() -> &'static str {
  env!("CARGO_PKG_VERSION")
}
