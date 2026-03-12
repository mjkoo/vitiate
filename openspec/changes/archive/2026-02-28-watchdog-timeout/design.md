## Context

Vitiate's fuzz loop (`loop.ts`) calls the target function synchronously and only enforces timeouts for async targets via `Promise.race()` with `setTimeout`. Synchronous targets that hang block the Node.js event loop indefinitely - there is no mechanism to preempt them.

The NAPI module (`vitiate-napi`) currently has no threading, no signal handling, and no process management. It exposes a `Fuzzer` class that drives LibAFL's mutation/feedback engine on the main thread. The coverage map is a Node.js `Buffer` shared zero-copy between JS and Rust via raw pointer.

The fuzz loop cycle is: `getNextInput()` → call target → `reportResult(exitKind)`. The `last_input` field in the Fuzzer struct holds the current input between these calls but is only accessible from the main thread.

Node.js engines >= 18 are supported. The NAPI addon ships prebuilt binaries for 5 targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64-msvc.

## Goals / Non-Goals

**Goals:**
- Enforce per-execution timeouts on both synchronous and asynchronous fuzz targets
- On Unix: graceful timeout recovery where the process survives and the fuzz loop continues
- On Windows: functional timeout enforcement (process may terminate, but the timeout is detected and input captured)
- Zero overhead on the fuzz loop hot path when no timeout is active
- Maintain all existing NAPI compatibility guarantees across supported platforms

**Non-Goals:**
- Crash handling (native segfaults, SIGBUS, etc.) - separate concern, separate change
- Parent-child process supervisor architecture - not needed for timeout handling
- Shared memory regions or `fork()`-based isolation
- Cooperative instrumentation timeout checks in the SWC plugin - TerminateExecution covers all JS code at V8 safe points, which are sufficient for timeout granularity
- Input minimization for timeout artifacts

## Decisions

### 1. V8 TerminateExecution as primary timeout mechanism

**Choice**: Call `v8::Isolate::TerminateExecution()` from the watchdog thread to interrupt blocked JS execution.

**Alternatives considered**:

- *Cooperative instrumentation check*: Insert periodic timeout flag checks at branch points in the SWC plugin. Requires SWC plugin changes, new runtime globals, and only covers instrumented code (not `node_modules`, not built-in operations). TerminateExecution covers all JS including uninstrumented paths, with no SWC changes.
- *SIGALRM*: How libFuzzer handles timeouts. Unsafe under V8 - a signal arriving mid-GC or mid-JIT can corrupt the heap. V8 expects signals to be processed on the event loop, which is exactly what's blocked.
- *worker_threads*: Run the target in a Worker and terminate on timeout. Workers share the OS process, so a segfault kills everything. Message-passing overhead (~5-10K exec/s). Worker respawn costs 5-30ms. Not a general solution.

**Rationale**: TerminateExecution is V8's own mechanism for cross-thread interruption. It's explicitly documented as thread-safe, fires at V8's internal safe points (bytecode dispatch, JIT back-edges, function calls, and within built-in operations like RegExp and JSON.parse), and produces a catchable exception that the fuzz loop handles normally. The process survives, no state is lost, and the fuzz loop continues immediately.

### 2. C++ shim with forward declarations via `cc` (not `cxx`)

**Choice**: A ~20-line C++ file with minimal forward declarations of `v8::Isolate`, compiled via the `cc` crate. Rust calls the shim through `extern "C"` declarations. No V8 headers required.

```cpp
namespace v8 {
class Isolate {
public:
    static Isolate* GetCurrent();
    void TerminateExecution();
    void CancelTerminateExecution();
};
}
```

The symbols resolve at load time from the Node.js host binary. `Isolate` has no virtual methods, so the forward declarations match the ABI. These three methods have been stable since Node 12.

**Alternatives considered**:

- *`cxx` crate for binding generation*: `cxx` provides compile-time verification that Rust and C++ agree on types, which is valuable when the FFI surface involves structs, callbacks, or string passing. Here the entire surface is three functions: `() -> i32`, `() -> i32`, `() -> i32`. There is no type surface to verify - you can't get `i32` wrong. Adding `cxx` (runtime dep) + `cxx-build` (build dep) introduces two new dependencies, and `cxx-build`'s code generation would need to coexist with `napi-build` in the same `build.rs` - a non-trivial integration to validate when neither has been used in this crate. If the C++ surface were richer, `cxx` would be the right choice. For three trivially-typed functions, `cc` + `extern "C"` is simpler with no meaningful safety tradeoff.
- *Full V8 headers via node-gyp*: Correct but adds a build-time dependency on `node-gyp` and platform-specific header installation. Fragile in CI. Unnecessary when only 3 stable symbols are needed.
- *dlsym at runtime*: Look up mangled symbol names dynamically. Portable on Unix but C++ mangling is compiler-specific (Itanium vs MSVC), and calling a C++ member function via a C function pointer requires matching the calling convention exactly. More complex and fragile than the forward declaration approach.

**Rationale**: The forward declaration approach is the simplest correct option. The three V8 methods used (`GetCurrent`, `TerminateExecution`, `CancelTerminateExecution`) take no parameters (besides implicit `this`), have no virtual dispatch, and have been ABI-stable across all Node.js versions we support (>= 18). The C++ compiler handles name mangling and calling conventions correctly. `cc` as a build dependency has minimal footprint and integrates cleanly alongside `napi-build`.

### 3. Conditional compilation: `cfg(unix)` for the shim

**Choice**: The C++ shim is only compiled on Unix targets. On Windows, the shim is absent and the watchdog falls back to `_exit`.

**Rationale**: On Linux and macOS, V8 C++ symbols are visible to dlopen'd shared libraries (the Node.js binary exports them). On Windows, DLL symbol resolution works differently - `node.lib` guarantees N-API symbols but not V8 C++ symbols. Rather than adding Windows-specific complexity (GetProcAddress with MSVC-mangled names), we accept the platform asymmetry: Unix gets graceful recovery, Windows gets functional-but-destructive timeout enforcement. This matches the PRD's platform support policy.

The Rust side exposes a `fn v8_terminate_available() -> bool` that the watchdog checks. When unavailable, the watchdog skips straight to `_exit` on deadline.

### 4. `_exit` with input capture before termination, via raw `libc` (not `nix`)

**Choice**: Before calling `_exit()`, the watchdog writes the current input to disk as a timeout artifact. The `_exit` call uses `libc::_exit()` directly.

The watchdog thread can safely perform file I/O - it's a regular thread, not a signal handler. The input is available via a pre-stash mechanism: before each iteration, the fuzz loop writes the current input's bytes and length to a fixed `Arc<InputStash>` that the watchdog holds a reference to. The stash uses atomic operations (an `AtomicU64` generation counter and an `AtomicUsize` length alongside a pre-allocated byte buffer protected by a `Mutex`) so the watchdog can read a consistent snapshot without blocking the main thread's hot path.

On Unix, `_exit` fires at 5x the configured timeout - long enough that TerminateExecution has had ample opportunity to handle the case. On Windows, `_exit` fires at 1x timeout since it's the primary mechanism.

**Why `libc` over `nix`**: The only POSIX call needed is `_exit()`. The `nix` crate provides ergonomic Rust wrappers over raw libc - valuable for complex APIs with error handling, pointer management, and unsafe patterns (fork, mmap, sigaction, waitpid). For `_exit`, nix's wrapper is a direct passthrough: `pub fn _exit(status: i32) -> ! { libc::_exit(status) }`. There is no error handling to ergonomize, no pointer wrangling, no unsafe to encapsulate. Adding nix (~30K lines, non-trivial compile time) for a single trivial passthrough is pure overhead. `libc` is already a transitive dependency via libafl and napi, so adding it as a direct dependency costs nothing. If a future change introduces fork, mmap, or sigaction (e.g., the crash handling supervisor), nix becomes the right choice and should be adopted then.

**Rationale**: Without input capture, `_exit` terminates the process and the triggering input is lost. Since the watchdog is a normal thread with full I/O capabilities (unlike a signal handler), capturing the input before exit is straightforward and makes the `_exit` path useful rather than merely a "process didn't hang forever" signal.

### 5. Watchdog lifecycle: condvar-based arm/disarm

**Choice**: The watchdog thread is spawned once at `Fuzzer` construction and lives for the fuzzer's lifetime. It parks on a `Condvar` when disarmed (zero CPU). `arm(timeout_ms)` writes the deadline and signals the condvar. `disarm()` clears the deadline and signals.

The NAPI exports are:
- `Watchdog` class constructor: spawns the thread, caches the V8 isolate pointer
- `arm(timeoutMs: number)`: set deadline, wake the thread
- `disarm()`: clear deadline, call `CancelTerminateExecution()` if it was triggered

`disarm()` must call `CancelTerminateExecution()` when the watchdog fired TerminateExecution but the exception hasn't been observed yet (race between the termination and the fuzz loop's catch). This resets V8's internal termination flag so subsequent JS execution works normally.

**Alternative considered**: Spawn a new thread per iteration. Rejected - thread creation costs ~50-100μs per iteration, which would halve throughput at 40K exec/s. A persistent thread with condvar parking costs <10ns per arm/disarm cycle.

### 6. Remove `withTimeout()` Promise.race

**Choice**: Remove the `withTimeout()` helper and the conditional async-vs-sync branching in the fuzz loop. The watchdog handles both cases uniformly.

**Rationale**: With the watchdog active, async targets are covered the same way as sync targets - TerminateExecution interrupts the JS execution regardless of whether it's awaiting a promise or running synchronously. The Promise.race approach added complexity (timer management, unhandled rejection suppression) and only worked for async targets. The watchdog subsumes it entirely.

The fuzz loop simplifies to:
```
arm(timeoutMs)
try { maybePromise = target(input); if (promise) await it; }
catch (e) { classify as Crash or Timeout }
finally { disarm() }
```

## Risks / Trade-offs

**[V8 ABI stability]** The forward-declared `v8::Isolate` methods could theoretically change signature in a future V8 version. **Mitigation**: These are among the most stable V8 APIs (unchanged since V8 6.x / Node 10). The shim includes a runtime init check (`vitiate_v8_init` returns success/failure). If the isolate pointer is null, the watchdog falls back to `_exit`-only mode. CI tests on each supported Node.js version will catch ABI breaks.

**[CancelTerminateExecution race]** If the watchdog calls TerminateExecution and the target returns normally before the exception propagates, the pending termination flag could affect the next iteration. **Mitigation**: `disarm()` always calls `CancelTerminateExecution()` to clear the flag, regardless of whether the watchdog fired. This is idempotent and safe.

**[Windows performance]** Every sync timeout on Windows kills the process. If a target frequently hits timeouts (e.g., timeout set too low), the fuzzer restarts repeatedly. **Mitigation**: This matches the PRD's platform policy. Users can increase the timeout. The input is captured to disk before exit, so no data is lost. A future change could add cooperative instrumentation checks for Windows-specific improvement.

**[`_exit` vs resource cleanup]** `_exit()` skips atexit handlers and does not flush stdio buffers. **Mitigation**: The watchdog flushes the timeout artifact to disk with `fsync` before calling `_exit`. The fuzzer's corpus state on disk is always consistent (corpus entries are written atomically with rename). Vitest's own cleanup is skipped, but this only matters for the timeout case which already represents an abnormal execution.

**[Input stash overhead]** Copying the input to the stash buffer before each iteration adds a `memcpy`. **Mitigation**: Typical inputs are <4KB. A 4KB memcpy costs ~20ns - negligible relative to the ~25μs per-iteration budget at 40K exec/s. The stash buffer is pre-allocated once and reused.
