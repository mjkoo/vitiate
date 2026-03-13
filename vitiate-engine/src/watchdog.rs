//! Watchdog thread for timeout enforcement.
//!
//! Spawns a background thread that parks on a condvar when idle. When armed,
//! it waits until the deadline expires or is disarmed. On expiry, it calls
//! `v8::TerminateExecution` to interrupt JS, and falls back to `_exit`
//! with input capture if V8 termination is unavailable or ineffective.

use std::fs;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::shmem_stash::{ShmemHandle, ShmemView};
use crate::v8_shim;

/// Exit code used by the watchdog's `_exit` fallback for timeouts.
/// Also exposed to JavaScript via the [`watchdog_exit_code()`] napi getter.
pub(crate) const WATCHDOG_EXIT_CODE: i32 = 77;

/// Returns the exit code used by the watchdog's `_exit` fallback for timeouts.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn watchdog_exit_code() -> i32 {
    WATCHDOG_EXIT_CODE
}

/// Internal watchdog state protected by a mutex.
struct WatchdogState {
    /// Deadline for the current arm, or `None` if disarmed.
    deadline: Option<Instant>,
    /// Whether the watchdog is armed.
    armed: bool,
    /// Whether the watchdog thread should shut down.
    shutdown: bool,
}

/// Shared state between the main thread and the watchdog thread.
struct WatchdogShared {
    state: Mutex<WatchdogState>,
    condvar: Condvar,
    /// Set to `true` when the watchdog fires TerminateExecution.
    fired: AtomicBool,
    /// The current timeout in milliseconds (set by arm, used by _exit path).
    timeout_ms: AtomicU64,
    /// Shmem view for reading the current input before `_exit`.
    /// `None` when running without the supervisor (Vitest integration mode).
    shmem_view: Option<ShmemView>,
    /// Prefix for timeout artifact paths (e.g., `./`, `./out/`, `bug-`).
    /// The artifact filename is appended directly to this prefix.
    artifact_prefix: String,
    /// Whether V8 TerminateExecution is available.
    v8_available: bool,
    /// The configured timeout multiplier for the `_exit` fallback.
    /// When V8 termination is available: 5x. When unavailable: 1x.
    exit_timeout_multiplier: u32,
}

/// Watchdog thread entry point.
fn watchdog_thread(shared: Arc<WatchdogShared>) {
    loop {
        let mut state = shared.state.lock().unwrap();

        // Wait until armed or shutdown
        while !state.armed && !state.shutdown {
            state = shared.condvar.wait(state).unwrap();
        }

        if state.shutdown {
            break;
        }

        // We're armed - compute how long to wait
        let deadline = match state.deadline {
            Some(d) => d,
            None => continue, // Spurious wake without deadline
        };
        drop(state);

        // Wait loop: re-check after each condvar wake
        loop {
            let now = Instant::now();
            if now >= deadline {
                // Deadline expired - fire!
                handle_timeout(&shared);
                break;
            }

            let remaining = deadline - now;
            let state = shared.state.lock().unwrap();
            if state.shutdown {
                return;
            }
            if !state.armed {
                // Disarmed while we were waiting
                break;
            }
            // Check if deadline changed (re-armed with different timeout)
            if state.deadline != Some(deadline) {
                break;
            }
            let (_state, _timeout) = shared.condvar.wait_timeout(state, remaining).unwrap();
            // Loop back to re-check
        }
    }
}

/// Handle a timeout expiry.
fn handle_timeout(shared: &WatchdogShared) {
    if shared.v8_available {
        // Set `fired` BEFORE calling v8_terminate(). The C++ shim reads `fired`
        // to distinguish timeout from crash - if the main thread sees the V8
        // termination exception before `fired` is visible, it misclassifies the
        // timeout as a crash.
        shared.fired.store(true, Ordering::Release);
        v8_shim::v8_terminate();

        // Wait for the _exit fallback deadline: (multiplier - 1) * timeout_ms
        // after TerminateExecution. This gives 4x more time for the termination
        // exception to propagate when V8 termination is available.
        let timeout_ms = shared.timeout_ms.load(Ordering::Acquire);
        let exit_wait = Duration::from_millis(timeout_ms)
            .saturating_mul(shared.exit_timeout_multiplier.saturating_sub(1));

        let exit_deadline = Instant::now() + exit_wait;
        loop {
            let now = Instant::now();
            if now >= exit_deadline {
                break; // Fall through to _exit
            }
            let state = shared.state.lock().unwrap();
            if !state.armed || state.shutdown {
                return; // Disarmed or shutting down - termination was handled
            }
            let remaining = exit_deadline - now;
            let _ = shared.condvar.wait_timeout(state, remaining).unwrap();
        }

        // If still armed after extended deadline, fall through to _exit
        let state = shared.state.lock().unwrap();
        if !state.armed || state.shutdown {
            return;
        }
        drop(state);
    } else {
        // No V8 TerminateExecution - go straight to _exit
        shared.fired.store(true, Ordering::Release);
    }

    // _exit path: capture input and terminate
    exit_with_input_capture(shared);
}

/// Write the current input to disk and call `_exit`.
fn exit_with_input_capture(shared: &WatchdogShared) {
    // Read the current input from the shmem region using the generation-counter
    // consistency check. If shmem is not available (no supervisor), skip input
    // capture - the _exit still fires to terminate the hung process.
    if let Some(ref view) = shared.shmem_view
        && let Some(input) = view.read_consistent()
        && !input.is_empty()
    {
        // Write timeout artifact
        let hash = crate::artifact_hash(&input);
        let artifact_path = format!("{}timeout-{hash}", shared.artifact_prefix);
        let path = std::path::Path::new(&artifact_path);

        // Best-effort I/O: we're about to call _exit, so there is no caller to
        // propagate errors to. Ignoring results is intentional.
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = fs::create_dir_all(parent);
        }

        if let Ok(mut file) = fs::File::create(path) {
            let _ = file.write_all(&input);
            let _ = file.sync_all();
            eprintln!("vitiate: timeout artifact written to {}", path.display());
        }
    }

    eprintln!("vitiate: watchdog forcing _exit due to timeout");
    // Terminate the process immediately without running atexit handlers.
    //
    // Unix: libc::_exit bypasses CRT cleanup. SAFETY: _exit is safe to call
    // from any thread.
    //
    // Windows: ExitProcess terminates all threads and skips CRT atexit handlers
    // when called from a non-main thread (our watchdog thread). SAFETY:
    // ExitProcess is safe to call from any thread.
    #[cfg(unix)]
    unsafe {
        libc::_exit(WATCHDOG_EXIT_CODE);
    }
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Threading::ExitProcess(WATCHDOG_EXIT_CODE as u32);
    }
}

/// NAPI-exposed Watchdog class.
#[napi]
pub struct Watchdog {
    shared: Arc<WatchdogShared>,
    thread_handle: Option<thread::JoinHandle<()>>,
}

#[napi]
impl Watchdog {
    /// Create a new Watchdog. Spawns the background thread and caches the V8 isolate.
    ///
    /// - `artifact_prefix`: Prefix for timeout artifact paths (e.g., `./`, `./out/`, `bug-`).
    ///   The artifact filename (`timeout-{hash}`) is appended directly to the prefix.
    /// - `shmem`: Optional shared memory handle for input capture before `_exit`.
    ///   When running under the supervisor, pass the shmem handle so the watchdog
    ///   can read the current input from shmem before calling `_exit`. When running
    ///   without the supervisor (Vitest integration), pass `null` - the `_exit`
    ///   fallback still fires but without writing a timeout artifact.
    #[napi(constructor)]
    pub fn new(artifact_prefix: String, shmem: Option<&ShmemHandle>) -> Self {
        // Cache V8 init result to avoid redundant dlsym resolution on each
        // Watchdog::new(). OnceLock guarantees exactly one initialization.
        static V8_INIT_RESULT: OnceLock<bool> = OnceLock::new();
        let v8_ok = *V8_INIT_RESULT.get_or_init(v8_shim::v8_init);
        if !v8_ok {
            eprintln!(
                "vitiate: warning: V8 isolate not available, \
                 watchdog will use _exit fallback only"
            );
        }

        let exit_multiplier = if v8_ok { 5 } else { 1 };
        let shmem_view = shmem.map(|s| s.view());

        let shared = Arc::new(WatchdogShared {
            state: Mutex::new(WatchdogState {
                deadline: None,
                armed: false,
                shutdown: false,
            }),
            condvar: Condvar::new(),
            fired: AtomicBool::new(false),
            timeout_ms: AtomicU64::new(0),
            shmem_view,
            artifact_prefix,
            v8_available: v8_ok,
            exit_timeout_multiplier: exit_multiplier,
        });

        let thread_shared = Arc::clone(&shared);
        let handle = thread::Builder::new()
            .name("vitiate-watchdog".into())
            .spawn(move || watchdog_thread(thread_shared))
            .expect("failed to spawn watchdog thread");

        Self {
            shared,
            thread_handle: Some(handle),
        }
    }

    /// Arm the watchdog with a timeout in milliseconds.
    /// Wakes the watchdog thread to start timing.
    #[napi]
    pub fn arm(&mut self, timeout_ms: f64) {
        debug_assert!(
            timeout_ms.is_finite() && timeout_ms > 0.0,
            "arm() timeout must be finite and positive, got {timeout_ms}"
        );
        // Clamp invalid values: NaN, negative, or zero → 1ms (fire immediately
        // rather than silently becoming 0ms or wrapping).
        let clamped = if timeout_ms.is_finite() && timeout_ms > 0.0 {
            timeout_ms
        } else {
            1.0
        };
        let ms = clamped as u64;
        self.shared.timeout_ms.store(ms, Ordering::Release);

        let deadline = Instant::now() + Duration::from_millis(ms);

        let mut state = self.shared.state.lock().unwrap();
        state.deadline = Some(deadline);
        state.armed = true;
        drop(state);
        self.shared.condvar.notify_one();
    }

    /// Disarm the watchdog. Clears the deadline and cancels any pending
    /// V8 termination if the watchdog fired.
    #[napi]
    pub fn disarm(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        state.deadline = None;
        state.armed = false;
        drop(state);
        self.shared.condvar.notify_one();

        // If the watchdog fired TerminateExecution, cancel it to ensure V8
        // state is clean before the next fuzz iteration.
        //
        // For the sync timeout path, the C++ shim already called
        // CancelTerminateExecution so NAPI calls could succeed - this second
        // cancel is redundant but harmless (CancelTerminateExecution is
        // idempotent). For the async timeout path, this is the *only* cancel,
        // since the C++ shim never ran the timeout branch. The intentional
        // redundancy is defense-in-depth: each layer ensures its own invariants.
        if self.shared.fired.swap(false, Ordering::AcqRel) {
            v8_shim::v8_cancel_terminate();
        }
    }

    /// Returns `true` if the watchdog fired since the last `disarm()`.
    #[napi(getter)]
    pub fn did_fire(&self) -> bool {
        self.shared.fired.load(Ordering::Acquire)
    }

    /// Deterministically shut down the watchdog thread.
    ///
    /// Signals the background thread to exit, wakes it via condvar, and joins
    /// it. Safe to call multiple times - subsequent calls are no-ops.
    /// Also called automatically by `Drop`, but calling explicitly allows JS
    /// callers to release the thread without waiting for GC.
    #[napi]
    pub fn shutdown(&mut self) {
        {
            let mut state = self.shared.state.lock().unwrap();
            state.shutdown = true;
        }
        self.shared.condvar.notify_one();

        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }

    /// Run the target function with watchdog protection.
    ///
    /// Arms the watchdog, calls the target, and handles V8 termination at the
    /// NAPI C level (where `CancelTerminateExecution` can be called before
    /// returning to JavaScript). Returns `{ exitKind, error?, result? }`.
    ///
    /// If the target returns a Promise, it is returned in `result` for the JS
    /// caller to await. Async timeout handling relies on the `_exit` fallback
    /// or on TerminateExecution firing during active JS in the continuation.
    ///
    /// Note: Input stashing is the caller's responsibility. The fuzz loop must
    /// call `shmemHandle.stashInput(input)` before calling `runTarget()`.
    #[napi(ts_return_type = "{ exitKind: number; error?: Error; result?: unknown }")]
    pub fn run_target(
        &mut self,
        env: Env,
        #[napi(ts_arg_type = "(data: Buffer) => void | Promise<void>")] target: Unknown,
        input: Buffer,
        timeout_ms: f64,
    ) -> Result<Object<'_>> {
        // Arm watchdog. Input stashing is done by the fuzz loop via shmem
        // before calling run_target.
        self.arm(timeout_ms);

        let raw_env = env.raw();
        // SAFETY: `raw_env` is valid - obtained from the `Env` parameter which
        // NAPI guarantees is valid for the duration of this call. `input` and
        // `target` are owned Rust values being converted to raw NAPI handles.
        let input_value = unsafe { Buffer::to_napi_value(raw_env, input)? };
        let target_value = unsafe { Unknown::to_napi_value(raw_env, target)? };

        // Try the C++ shim path (handles V8 termination interception)
        if let Some(result) =
            v8_shim::run_target_ffi(raw_env, target_value, input_value, &self.shared.fired)
        {
            self.disarm();
            let mut obj = Object::from_raw(raw_env, result.value);
            // Set the "result" property (target's return value) via napi-rs.
            // For async targets this is the Promise that the JS caller must await.
            // Previously this was done in the C++ shim via set_prop_value with an
            // unchecked return, which silently failed on Windows and caused the
            // async continuation to never be awaited (coverage lost).
            if !result.fn_result.is_null() {
                obj.set("result", result.fn_result)?;
            }
            return Ok(obj);
        }

        // Fallback path: C++ shim not initialized (cargo test, symbol resolution
        // failed). Call the function via NAPI and handle exceptions manually.
        //
        // SAFETY for all raw NAPI calls below: `raw_env` is valid (from the
        // `Env` parameter), and all output pointers are valid stack locals.
        // Raw NAPI functions are safe to call with valid env + pointer args.
        let mut result_value: napi::sys::napi_value = std::ptr::null_mut();
        let mut global: napi::sys::napi_value = std::ptr::null_mut();
        let status = unsafe { napi::sys::napi_get_global(raw_env, &mut global) };
        if status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_get_global failed in fallback path",
            ));
        }

        let call_status = unsafe {
            napi::sys::napi_call_function(
                raw_env,
                global,
                target_value,
                1,
                &input_value,
                &mut result_value,
            )
        };

        // Read fired BEFORE disarm() resets it. disarm() atomically swaps
        // fired to false, so reading after disarm() always sees false.
        //
        // Note: in practice, `timed_out` is always false here. This fallback
        // path only runs when the C++ shim isn't initialized (v8_available is
        // false), and without V8 termination the watchdog calls _exit() on
        // timeout - the process is dead before we reach this point. The timeout
        // handling below exists for defensive consistency with the C++ shim path.
        let timed_out = self.shared.fired.load(Ordering::Acquire);

        // If V8 termination fired, cancel it before any NAPI calls to clear
        // V8's internal termination flag. disarm() calls cancel again -
        // idempotent, harmless.
        if timed_out {
            v8_shim::v8_cancel_terminate();
        }

        // Stop the watchdog timer to prevent _exit from firing while we
        // build the result object.
        self.disarm();

        let mut raw_obj: napi::sys::napi_value = std::ptr::null_mut();
        let status = unsafe { napi::sys::napi_create_object(raw_env, &mut raw_obj) };
        if status != napi::sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                "napi_create_object failed in fallback path",
            ));
        }
        let mut obj = Object::from_raw(raw_env, raw_obj);

        if call_status == napi::sys::Status::napi_ok {
            obj.set("exitKind", 0u32)?;
            obj.set("result", result_value)?;
            Ok(obj)
        } else if call_status == napi::sys::Status::napi_pending_exception {
            let mut exception: napi::sys::napi_value = std::ptr::null_mut();
            let exc_status =
                unsafe { napi::sys::napi_get_and_clear_last_exception(raw_env, &mut exception) };
            if timed_out {
                obj.set("exitKind", 2u32)?;

                // Create a timeout error for consistency with the C++ shim path.
                // Best-effort - exitKind is already set for classification.
                let msg = "fuzz target timed out";
                let mut js_msg: napi::sys::napi_value = std::ptr::null_mut();
                let msg_status = unsafe {
                    napi::sys::napi_create_string_utf8(
                        raw_env,
                        msg.as_ptr().cast(),
                        msg.len() as isize,
                        &mut js_msg,
                    )
                };
                if exc_status == napi::sys::Status::napi_ok
                    && msg_status == napi::sys::Status::napi_ok
                {
                    let mut js_error: napi::sys::napi_value = std::ptr::null_mut();
                    let err_status = unsafe {
                        napi::sys::napi_create_error(
                            raw_env,
                            std::ptr::null_mut(),
                            js_msg,
                            &mut js_error,
                        )
                    };
                    if err_status == napi::sys::Status::napi_ok {
                        obj.set("error", js_error)?;
                    }
                }
            } else {
                obj.set("exitKind", 1u32)?;
                if exc_status == napi::sys::Status::napi_ok {
                    obj.set("error", exception)?;
                }
            }
            Ok(obj)
        } else {
            Err(Error::new(
                Status::GenericFailure,
                format!("napi_call_function failed with status {call_status}"),
            ))
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shmem_stash;

    /// Create a test ShmemView backed by a heap-allocated buffer.
    fn make_test_shmem_view(max_input_len: usize) -> (Vec<u8>, ShmemView) {
        let total = shmem_stash::shmem_size(max_input_len);
        let mut buf = vec![0u8; total];
        let base = buf.as_mut_ptr();
        unsafe {
            (base as *mut u32).write(shmem_stash::MAGIC);
        }
        let view = ShmemView::new_for_test(base, max_input_len);
        (buf, view)
    }

    fn make_shared(v8_available: bool) -> (Vec<u8>, Arc<WatchdogShared>) {
        let (buf, view) = make_test_shmem_view(1024);
        let shared = Arc::new(WatchdogShared {
            state: Mutex::new(WatchdogState {
                deadline: None,
                armed: false,
                shutdown: false,
            }),
            condvar: Condvar::new(),
            fired: AtomicBool::new(false),
            timeout_ms: AtomicU64::new(0),
            shmem_view: Some(view),
            artifact_prefix: "/tmp/vitiate-test/".to_owned(),
            v8_available,
            exit_timeout_multiplier: 5,
        });
        (buf, shared)
    }

    #[test]
    fn arm_and_disarm_without_firing() {
        let (_buf, shared) = make_shared(false);
        let thread_shared = Arc::clone(&shared);
        let handle = thread::spawn(move || watchdog_thread(thread_shared));

        // Arm with a long timeout
        {
            let mut state = shared.state.lock().unwrap();
            state.deadline = Some(Instant::now() + Duration::from_secs(60));
            state.armed = true;
        }
        shared.condvar.notify_one();

        // Disarm before deadline - no sleep needed; the watchdog thread checks
        // `armed` on every condvar wake, so the disarm is observed regardless of
        // whether the thread has entered its wait loop yet.
        {
            let mut state = shared.state.lock().unwrap();
            state.armed = false;
            state.deadline = None;
        }
        shared.condvar.notify_one();

        // Shutdown and join - thread::join() establishes happens-before, so all
        // writes from the watchdog thread are visible after join returns.
        {
            let mut state = shared.state.lock().unwrap();
            state.shutdown = true;
        }
        shared.condvar.notify_one();
        handle.join().unwrap();

        assert!(!shared.fired.load(Ordering::Acquire));
    }

    #[test]
    fn shutdown_while_idle() {
        let (_buf, shared) = make_shared(false);
        let thread_shared = Arc::clone(&shared);
        let handle = thread::spawn(move || watchdog_thread(thread_shared));

        // Immediately shut down
        {
            let mut state = shared.state.lock().unwrap();
            state.shutdown = true;
        }
        shared.condvar.notify_one();
        handle.join().unwrap();
    }

    #[test]
    fn shutdown_while_armed() {
        let (_buf, shared) = make_shared(false);
        let thread_shared = Arc::clone(&shared);
        let handle = thread::spawn(move || watchdog_thread(thread_shared));

        // Arm with a long timeout
        {
            let mut state = shared.state.lock().unwrap();
            state.deadline = Some(Instant::now() + Duration::from_secs(60));
            state.armed = true;
        }
        shared.condvar.notify_one();

        // Shut down while armed - no sleep needed; the watchdog thread checks
        // `shutdown` before every condvar wait, so setting it and notifying
        // always causes clean exit regardless of timing.
        {
            let mut state = shared.state.lock().unwrap();
            state.shutdown = true;
        }
        shared.condvar.notify_one();
        handle.join().unwrap();
    }

    #[test]
    fn shmem_stash_integration() {
        let (_buf, shared) = make_shared(false);
        let view = shared.shmem_view.as_ref().expect("should have shmem");
        view.stash_input(b"test input");
        let data = view.read_consistent().expect("should read");
        assert_eq!(data, b"test input");
    }
}
