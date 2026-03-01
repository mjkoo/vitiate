mod cmplog;
mod coverage;
mod engine;
mod exception_handler;
mod shmem_stash;
mod trace;
mod types;
mod v8_shim;
mod watchdog;

use sha2::{Digest, Sha256};

use napi_derive::napi;

#[napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Compute a SHA-256 hash of `data` and return it as a lowercase hex string.
///
/// Used for content-addressable artifact filenames (crash/timeout artifacts).
/// Similar to libFuzzer's use of SHA-1 for artifact naming, but using SHA-256
/// for better collision resistance (already a transitive dependency).
pub(crate) fn artifact_hash(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    format!("{digest:x}")
}
