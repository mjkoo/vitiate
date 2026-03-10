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
///
/// - `artifact_prefix`: Prefix for crash artifact paths (e.g., `./`, `./out/`, `bug-`).
///   The artifact filename (`crash-{hash}`) is appended directly to the prefix.
// This function is only called from JavaScript via NAPI. In the Rust test binary,
// the NAPI entry point is not linked, so the function appears unused.
#[allow(dead_code)]
#[cfg_attr(not(windows), allow(unused_variables))]
#[napi]
pub fn install_exception_handler(shmem: &ShmemHandle, artifact_prefix: String) {
    INSTALL_ONCE.call_once(|| {
        #[cfg(windows)]
        {
            install_seh_handler(shmem, artifact_prefix);
        }
        // Unix: no-op — parent observes crashes via waitpid/signal
    });
}

// --- Windows SEH implementation ---

#[cfg(windows)]
mod seh {
    use std::fs;
    use std::io::Write;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{
        EXCEPTION_ACCESS_VIOLATION, EXCEPTION_ILLEGAL_INSTRUCTION, EXCEPTION_INT_DIVIDE_BY_ZERO,
        EXCEPTION_STACK_OVERFLOW, NTSTATUS,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        AddVectoredExceptionHandler, EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS,
    };

    use crate::shmem_stash::{ShmemHandle, ShmemView};

    /// Context stored in a global static for the vectored exception handler
    /// callback. C function pointers cannot capture state, so we use a
    /// process-global `OnceLock`.
    struct ExceptionContext {
        view: ShmemView,
        /// Prefix for crash artifact paths (e.g., `./`, `./out/`, `bug-`).
        artifact_prefix: String,
    }

    impl std::fmt::Debug for ExceptionContext {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("ExceptionContext")
                .field("artifact_prefix", &self.artifact_prefix)
                .finish_non_exhaustive()
        }
    }

    static EXCEPTION_CONTEXT: OnceLock<ExceptionContext> = OnceLock::new();

    /// Install the Windows vectored exception handler.
    pub(super) fn install_seh_handler(shmem: &ShmemHandle, artifact_prefix: String) {
        EXCEPTION_CONTEXT
            .set(ExceptionContext {
                view: shmem.view(),
                artifact_prefix,
            })
            .expect("exception handler context already initialized");

        // Register as the first handler (first=1) so we run before V8's own
        // vectored exception handler. This lets us capture the crash artifact
        // before V8 potentially handles (and masks) the exception.
        //
        // SAFETY: `handler_callback` has the correct `PVECTORED_EXCEPTION_HANDLER`
        // signature. The handler returns `EXCEPTION_CONTINUE_SEARCH`, so it
        // never prevents other handlers from running.
        unsafe {
            AddVectoredExceptionHandler(1, Some(handler_callback));
        }
    }

    /// Vectored exception handler callback.
    ///
    /// Called by the OS when an exception occurs on the faulting thread's stack.
    /// Unlike Unix signal handlers, SEH handlers run with full CRT available
    /// (heap allocation, I/O, etc. are all safe).
    ///
    /// **Stack overflow edge case:** Windows reserves one guard page (~4 KiB)
    /// for SEH dispatch after a stack overflow. Our handler's stack footprint
    /// is small (~200 bytes for SHA-256 state); large allocations (PathBuf,
    /// String, File) use the heap. If the handler itself overflows, re-entry
    /// would fail at I/O and return `EXCEPTION_CONTINUE_SEARCH` harmlessly.
    unsafe extern "system" fn handler_callback(info: *mut EXCEPTION_POINTERS) -> i32 {
        // SAFETY: The OS guarantees `info` is a valid pointer when calling
        // the vectored exception handler.
        let record = unsafe { (*info).ExceptionRecord };
        if record.is_null() {
            return EXCEPTION_CONTINUE_SEARCH;
        }
        let exception_code = unsafe { (*record).ExceptionCode };

        // Only handle exception codes that indicate a crash.
        // Other exceptions (e.g., V8 guard page probes) are passed through.
        if !is_crash_exception(exception_code) {
            return EXCEPTION_CONTINUE_SEARCH;
        }

        // Read the exception context (shmem view + artifact dir).
        let Some(ctx) = EXCEPTION_CONTEXT.get() else {
            return EXCEPTION_CONTINUE_SEARCH;
        };

        // Read the current fuzz input from shmem. read_consistent() uses
        // the seqlock protocol to detect torn reads. In an SEH handler this
        // is safe because we're on the faulting thread's stack with full CRT.
        let Some(input) = ctx.view.read_consistent() else {
            eprintln!(
                "vitiate: crash detected (exception {exception_code:#010x}) \
                 but no input available in shmem"
            );
            return EXCEPTION_CONTINUE_SEARCH;
        };

        if input.is_empty() {
            return EXCEPTION_CONTINUE_SEARCH;
        }

        let hash = crate::artifact_hash(&input);
        let artifact_path = format!("{}crash-{hash}", ctx.artifact_prefix);
        let path = std::path::Path::new(&artifact_path);

        // Best-effort I/O: we're in an exception handler that will propagate
        // the exception after returning. Ignoring I/O errors is intentional.
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = fs::File::create(path) {
            let _ = file.write_all(&input);
            let _ = file.sync_all();
            eprintln!(
                "vitiate: crash artifact written to {} (exception {exception_code:#010x})",
                path.display()
            );
        }

        // Let the OS continue searching for exception handlers (V8, Node, etc.).
        // The parent supervisor will observe the abnormal exit.
        EXCEPTION_CONTINUE_SEARCH
    }

    /// Returns true if the exception code represents a crash we should capture.
    pub(super) fn is_crash_exception(code: NTSTATUS) -> bool {
        matches!(
            code,
            EXCEPTION_ACCESS_VIOLATION
                | EXCEPTION_ILLEGAL_INSTRUCTION
                | EXCEPTION_STACK_OVERFLOW
                | EXCEPTION_INT_DIVIDE_BY_ZERO
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn access_violation_is_crash() {
            assert!(is_crash_exception(EXCEPTION_ACCESS_VIOLATION));
        }

        #[test]
        fn illegal_instruction_is_crash() {
            assert!(is_crash_exception(EXCEPTION_ILLEGAL_INSTRUCTION));
        }

        #[test]
        fn stack_overflow_is_crash() {
            assert!(is_crash_exception(EXCEPTION_STACK_OVERFLOW));
        }

        #[test]
        fn int_divide_by_zero_is_crash() {
            assert!(is_crash_exception(EXCEPTION_INT_DIVIDE_BY_ZERO));
        }

        #[test]
        fn other_exceptions_are_not_crash() {
            // STATUS_BREAKPOINT (0x80000003) should not be treated as a crash
            assert!(!is_crash_exception(0x80000003_u32 as i32));
            // STATUS_SINGLE_STEP (0x80000004) should not be treated as a crash
            assert!(!is_crash_exception(0x80000004_u32 as i32));
            // Zero should not be treated as a crash
            assert!(!is_crash_exception(0));
        }
    }
}

#[cfg(windows)]
fn install_seh_handler(shmem: &ShmemHandle, artifact_prefix: String) {
    seh::install_seh_handler(shmem, artifact_prefix);
}
