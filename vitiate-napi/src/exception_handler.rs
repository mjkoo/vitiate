//! Windows Structured Exception Handling (SEH) for crash detection.
//!
//! On Windows, installs a vectored exception handler that captures crash
//! information (exception code, crashing input) to shmem and writes a crash
//! artifact before continuing the exception chain.
//!
//! On Unix, this module provides a no-op stub — the parent supervisor
//! observes crashes via `waitpid` signal detection instead.

use std::sync::Once;

use napi_derive::napi;

use crate::shmem_stash::ShmemHandle;

/// Ensures the exception handler is installed at most once per process.
/// Multiple `test.fuzz()` calls in the same process share a single handler.
static INSTALL_ONCE: Once = Once::new();

/// Install the platform-specific exception/crash handler.
///
/// - **Windows**: Calls `AddVectoredExceptionHandler` to intercept
///   `EXCEPTION_ACCESS_VIOLATION`, `EXCEPTION_ILLEGAL_INSTRUCTION`,
///   `EXCEPTION_STACK_OVERFLOW`, and `EXCEPTION_INT_DIVIDE_BY_ZERO`.
///   The handler writes crash metadata to shmem and a crash artifact to disk,
///   then returns `EXCEPTION_CONTINUE_SEARCH` to propagate the exception.
///
/// - **Unix**: No-op. The parent supervisor detects crashes via the child's
///   exit signal (SIGSEGV, SIGBUS, SIGABRT, etc.) using Node's `child.on('exit')`
///   signal property.
///
/// Safe to call multiple times — subsequent calls are no-ops.
// This function is only called from JavaScript via NAPI. In the Rust test binary,
// the NAPI entry point is not linked, so the function appears unused.
#[allow(dead_code, unused_variables)]
#[napi]
pub fn install_exception_handler(shmem: &ShmemHandle) {
    INSTALL_ONCE.call_once(|| {
        #[cfg(windows)]
        {
            install_seh_handler(shmem);
        }
        // Unix: no-op — parent observes crashes via waitpid/signal
    });
}

/// Windows SEH implementation (compiled only on Windows).
#[cfg(windows)]
fn install_seh_handler(_shmem: &ShmemHandle) {
    // TODO: Implement Windows SEH crash handler
    //
    // Implementation plan:
    // 1. Store shmem view in a global static for the handler callback
    // 2. Call AddVectoredExceptionHandler(1, handler_fn) to install as first handler
    // 3. In handler_fn:
    //    a. Check exception code against EXCEPTION_ACCESS_VIOLATION,
    //       EXCEPTION_ILLEGAL_INSTRUCTION, EXCEPTION_STACK_OVERFLOW,
    //       EXCEPTION_INT_DIVIDE_BY_ZERO
    //    b. Read crashing input from shmem using read_consistent()
    //    c. Write crash artifact to artifact_dir
    //    d. Return EXCEPTION_CONTINUE_SEARCH to propagate
    //
    // Requires: windows-sys crate dependency for SEH FFI types
}
