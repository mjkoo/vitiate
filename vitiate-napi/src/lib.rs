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

/// Returns `true` if the V8 C++ shim resolved all required symbols at runtime.
///
/// Under Node.js on platforms where V8 symbols are visible (glibc Linux, macOS,
/// Windows), this should return `true`. Returns `false` under `cargo test` or
/// on platforms where V8 symbols are not in the dynamic symbol table.
#[napi]
pub fn v8_shim_available() -> bool {
    v8_shim::v8_init()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_hash_produces_lowercase_hex_sha256() {
        assert_eq!(
            artifact_hash(b"test"),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }
}
