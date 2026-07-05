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

/// Exit code used by the engine's panic hook (see [`install_panic_hook`]) when a
/// Rust panic is intercepted. Distinct from [`crate::watchdog::WATCHDOG_EXIT_CODE`]
/// (77) so the supervisor can classify an internal engine panic as an infrastructure
/// error rather than a crash in the target under test. Also exposed to
/// JavaScript via the [`engine_panic_exit_code()`] napi getter.
pub(crate) const ENGINE_PANIC_EXIT_CODE: i32 = 78;

/// Returns the exit code the engine uses when its panic hook intercepts a Rust
/// panic. Sourced by the supervisor as the single source of truth.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn engine_panic_exit_code() -> i32 {
    ENGINE_PANIC_EXIT_CODE
}

/// Terminate the process immediately with `code`, bypassing atexit/CRT cleanup.
///
/// Shared by the watchdog timeout fallback and the engine panic hook so both
/// fatal paths exit identically.
///
/// SAFETY: `_exit` (Unix) and `ExitProcess` (Windows) are safe to call from any
/// thread and skip CRT cleanup, avoiding deadlocks on static destructors.
pub(crate) fn exit_process(code: i32) {
    #[cfg(unix)]
    unsafe {
        libc::_exit(code);
    }
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Threading::ExitProcess(code as u32);
    }
    #[cfg(not(any(unix, windows)))]
    std::process::exit(code);
}

/// Install a process-wide panic hook that reports the panic and then terminates
/// the process with [`ENGINE_PANIC_EXIT_CODE`] *before* the unwind can cross the
/// napi/C++ FFI boundary.
///
/// The hook runs before unwinding begins, on whichever thread panicked
/// (including the watchdog thread), so a Rust panic can never unwind through an
/// `extern "C"` frame, and the supervisor receives an unambiguous death cause
/// distinct from a crash in the target under test. Idempotent via
/// [`std::sync::Once`]; safe to call from every napi constructor.
///
/// Gated to non-test builds: under `cargo test` the default unwinding hook must
/// remain installed so libtest can catch panicking tests. (Integration/e2e
/// builds load the compiled addon without `cfg(test)`, so they get the hook.)
#[cfg(not(test))]
pub(crate) fn install_panic_hook() {
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // Preserve the default message/backtrace output, then exit with the
            // dedicated engine-panic code instead of unwinding.
            default_hook(info);
            exit_process(ENGINE_PANIC_EXIT_CODE);
        }));
    });
}

/// No-op under `cargo test`; see the non-test variant for rationale.
#[cfg(test)]
pub(crate) fn install_panic_hook() {}

/// Install the engine panic hook as soon as the addon is loaded, so panics in
/// napi entries called before `Watchdog`/`Fuzzer` construction (e.g.
/// [`createCoverageMap`](coverage::create_coverage_map),
/// `ShmemHandle::allocate`/`attach`) still exit with [`ENGINE_PANIC_EXIT_CODE`]
/// instead of aborting as SIGABRT and being misclassified by the supervisor as
/// a crash in the target under test. The per-constructor installs remain as
/// belt-and-suspenders; the hook itself is `Once`-guarded.
#[cfg(not(test))]
#[napi_derive::module_init]
fn init_engine_panic_hook() {
    install_panic_hook();
}

/// Internal test hook: panics immediately to exercise the engine panic hook
/// installed at module load (must exit the process with the engine panic exit
/// code without constructing `Watchdog` or `Fuzzer` first). Not part of the
/// public API; do not call.
#[napi(js_name = "__testEnginePanic")]
#[cfg_attr(test, allow(dead_code))]
pub fn test_engine_panic() {
    panic!("__testEnginePanic: intentional test panic");
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
    hex::encode(Sha256::digest(data))
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
