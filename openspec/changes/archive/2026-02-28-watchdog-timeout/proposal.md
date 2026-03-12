## Why

Vitiate cannot enforce per-execution timeouts on synchronous fuzz targets. The current `withTimeout()` mechanism uses `Promise.race()` with `setTimeout`, which only works for async targets - a synchronous infinite loop blocks the event loop, so the timer never fires. Any synchronous target that hangs blocks the fuzzer indefinitely. This is the most critical robustness gap for production use and OSS-Fuzz compatibility.

## What Changes

- **Watchdog thread**: A background Rust thread in `vitiate-napi` that manages timeout enforcement. Exposes `arm(timeout_ms)` and `disarm()` to JavaScript. The thread parks on a condvar when idle and consumes zero CPU. On deadline expiry, it terminates JS execution from outside the blocked event loop.
- **V8 TerminateExecution (primary mechanism, Unix)**: A minimal C++ shim compiled into the NAPI addon on Linux and macOS. Caches the `v8::Isolate*` at init and exposes `TerminateExecution()` / `CancelTerminateExecution()` to the watchdog thread. This interrupts any JavaScript execution at the next V8 safe point (bytecode boundary, JIT back-edge, function call, built-in operation). The process survives - the fuzz loop catches the termination, reports `ExitKind.Timeout`, and continues with the next input. No state is lost.
- **`_exit` fallback (Windows, and native-code edge case on Unix)**: When TerminateExecution is unavailable (Windows) or ineffective (infinite loop in native C++ addon code that never returns to V8), the watchdog calls `_exit()` after a longer deadline. The process terminates and the current input is written to disk before exit. On Windows this is the primary timeout mechanism; on Unix it is a rare fallback.
- **Fuzz loop integration**: The loop calls `arm(timeoutMs)` before each target execution and `disarm()` after. Timeout enforcement now works uniformly for both sync and async targets. The existing `withTimeout()` Promise.race approach is removed.

## Capabilities

### New Capabilities
- `watchdog`: Background watchdog thread with condvar-based arm/disarm lifecycle, V8 TerminateExecution integration, and `_exit` fallback

### Modified Capabilities
- `fuzz-loop`: Loop calls watchdog arm/disarm around target execution; timeout enforcement changes from async-only to universal (sync + async); `withTimeout()` removed
- `standalone-cli`: CLI must accept `-timeout` flag and forward it to the fuzz loop (already partially implemented, but timeout now applies to sync targets too)

## Impact

- **vitiate-napi**: New `watchdog` module (Rust thread, condvar, arm/disarm NAPI exports). New C++ shim (~20 lines, `cfg(unix)` only) for V8 isolate access. New build dependency: `cc` crate for C++ compilation. New dependency: `nix` crate for `_exit`. Build system changes to `build.rs`.
- **vitiate**: Changes to `loop.ts` (arm/disarm calls, remove `withTimeout`, catch termination exception). Minor changes to `globals.ts` (expose watchdog arm/disarm from napi).
- **No changes to**: SWC instrumentation plugin, corpus management, reporter, config types, test API surface.
- **Platform behavior**: Linux/macOS get graceful timeout recovery (process survives). Windows gets functional timeout enforcement via `_exit` (process terminates, degraded but working - consistent with PRD platform support policy).
