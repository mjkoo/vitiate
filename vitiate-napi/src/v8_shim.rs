//! Rust-side declarations for the V8 C++ shim functions.
//!
//! On Unix: links to the `extern "C"` functions in `v8_shim.cc`.
//! On Windows: provides no-op stubs (V8 C++ symbols aren't available).

use std::sync::atomic::AtomicBool;

// ABI safety: ensure Rust AtomicBool matches C++ std::atomic<bool>.
const _: () = assert!(size_of::<AtomicBool>() == 1);

/// Result from `vitiate_run_target` in C++.
#[repr(C)]
pub struct VitiateRunTargetResult {
    pub exit_kind: i32,
    pub value: napi::sys::napi_value,
}

#[cfg(unix)]
unsafe extern "C" {
    fn vitiate_v8_init() -> i32;
    fn vitiate_v8_terminate() -> i32;
    fn vitiate_v8_cancel_terminate() -> i32;
    fn vitiate_run_target(
        env: napi::sys::napi_env,
        target: napi::sys::napi_value,
        input: napi::sys::napi_value,
        fired: *const AtomicBool,
        out: *mut VitiateRunTargetResult,
    ) -> i32;
}

/// Initialize the V8 isolate cache. Must be called from the main thread.
/// Returns `true` if the isolate was cached successfully.
pub fn v8_init() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: Called once from the main thread during Watchdog construction.
        // The C++ shim caches `v8::Isolate::GetCurrent()` which is valid on the
        // main thread where Node.js runs.
        unsafe { vitiate_v8_init() == 1 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Call `v8::Isolate::TerminateExecution()` on the cached isolate.
/// Thread-safe — designed to be called from the watchdog thread.
/// Returns `true` if the call succeeded.
pub fn v8_terminate() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: `TerminateExecution` is documented as thread-safe in V8.
        // The cached isolate pointer was set by `v8_init` on the main thread.
        unsafe { vitiate_v8_terminate() == 1 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Call `v8::Isolate::CancelTerminateExecution()` on the cached isolate.
/// Called from the main thread to clear a pending termination flag.
/// Returns `true` if the call succeeded.
pub fn v8_cancel_terminate() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: Called from the main thread during `disarm()`. The isolate
        // pointer is valid for the lifetime of the Node.js process.
        unsafe { vitiate_v8_cancel_terminate() == 1 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Returns `true` if V8 TerminateExecution is available on this platform.
pub fn v8_terminate_available() -> bool {
    cfg!(unix)
}

/// Run the fuzz target via the C++ shim, which handles V8 termination at
/// the NAPI C level. Returns `None` if the shim is not initialized (e.g.,
/// during `cargo test` or on non-Unix platforms).
pub fn run_target_ffi(
    env: napi::sys::napi_env,
    target: napi::sys::napi_value,
    input: napi::sys::napi_value,
    fired: &AtomicBool,
) -> Option<VitiateRunTargetResult> {
    #[cfg(unix)]
    {
        let mut out = VitiateRunTargetResult {
            exit_kind: 0,
            value: std::ptr::null_mut(),
        };
        // SAFETY: Called from the main thread with valid NAPI handles.
        // The `fired` pointer remains valid for the duration of the call
        // (it's owned by the Arc<WatchdogShared>). The C++ shim only reads it.
        let ok =
            unsafe { vitiate_run_target(env, target, input, fired as *const AtomicBool, &mut out) };
        if ok == 1 { Some(out) } else { None }
    }
    #[cfg(not(unix))]
    {
        let _ = (env, target, input, fired);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v8_init_returns_false_without_node() {
        // When running under `cargo test` (not Node.js), dlsym can't find
        // V8 symbols, so v8_init should return false.
        assert!(!v8_init());
    }

    #[test]
    fn v8_terminate_returns_false_without_init() {
        // Without a cached isolate, terminate should be a no-op.
        assert!(!v8_terminate());
    }

    #[test]
    fn v8_cancel_terminate_returns_false_without_init() {
        // Without a cached isolate, cancel_terminate should be a no-op.
        assert!(!v8_cancel_terminate());
    }

    #[test]
    fn v8_terminate_available_matches_platform() {
        assert_eq!(v8_terminate_available(), cfg!(unix));
    }

    #[test]
    fn run_target_ffi_returns_none_without_node() {
        // Without Node.js, the shim can't resolve NAPI symbols, so
        // run_target_ffi should return None.
        let fired = AtomicBool::new(false);
        let result = run_target_ffi(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &fired,
        );
        assert!(result.is_none());
    }
}
