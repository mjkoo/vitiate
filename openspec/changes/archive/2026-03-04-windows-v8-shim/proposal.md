## Why

On Windows, the watchdog cannot gracefully interrupt hung fuzz targets - it falls back to `ExitProcess()`, killing the entire Vitest worker process and producing "Channel closed" errors. This prevents in-process timeout tests from running on Windows and forces the `loop.test.ts` sync timeout test to be skipped. Node.js on Windows exports V8 C++ symbols from `node.exe`, making `TerminateExecution` available via `GetProcAddress` - the same approach used with `dlsym` on Unix.

Additionally, the Rust fallback path (used when the C++ shim returns 0) has a latent bug with two interacting problems: `disarm()` atomically resets `fired` to false before the classification code reads it, causing timeouts to be silently misclassified as crashes; and it does not call `CancelTerminateExecution()` before making NAPI calls, leaving V8's internal termination flag set. Today this is harmless because the fallback is only reached when V8 termination is unavailable (the process dies via `_exit` before the code runs), but it should be fixed as defense-in-depth regardless of the Windows work.

## What Changes

- Compile `v8_shim.cc` on all platforms (not just Unix), using `GetProcAddress` with MSVC-mangled symbol names on Windows and `dlsym` with Itanium-mangled names on Unix.
- Remove `#[cfg(unix)]` / `#[cfg(not(unix))]` gates from the Rust V8 shim wrapper (`v8_shim.rs`) - the C++ shim handles unavailability gracefully at runtime.
- Make the `_exit` fallback timeout multiplier dynamic: `5x` when V8 termination is available, `1x` when it is not - rather than hardcoding based on `cfg!(unix)`.
- Fix the Rust fallback path in `watchdog.rs`: read `fired` before `disarm()` resets it, call `CancelTerminateExecution()` before NAPI calls when fired, and use the saved value for classification.
- Update `build.rs` to compile `v8_shim.cc` on Windows targets (MSVC).
- Remove the `skipIf(win32)` from the sync timeout test in `loop.test.ts`.
- Update the `smoke.mjs` V8 shim availability assertion to expect `true` on Windows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watchdog`: V8 TerminateExecution becomes cross-platform (not Unix-only). The C++ shim compilation requirement changes from `cfg(unix)` to all platforms. The `_exit` fallback multiplier becomes dynamic based on V8 availability rather than target OS. The Rust fallback path is fixed to read `fired` before `disarm()` resets it and to call `CancelTerminateExecution()` before NAPI calls.

## Impact

- **`vitiate-napi/src/v8_shim.cc`**: Add `#ifdef _WIN32` branch using `GetProcAddress` + MSVC-mangled names alongside existing `dlsym` branch.
- **`vitiate-napi/src/v8_shim.rs`**: Remove `#[cfg(unix)]` / `#[cfg(not(unix))]` platform gates; all functions delegate to the C++ shim unconditionally.
- **`vitiate-napi/build.rs`**: Remove `CARGO_CFG_UNIX` gate; compile `v8_shim.cc` on all targets.
- **`vitiate-napi/src/watchdog.rs`**: Change `exit_multiplier` from `cfg!(unix)` to `v8_ok`-based. Fix Rust fallback path: read `fired` before `disarm()`, cancel V8 termination when fired, classify using saved value.
- **`vitiate/src/loop.test.ts`**: Remove `skipIf(win32)` on sync timeout test.
- **`vitiate-napi/test/smoke.mjs`**: Assert `v8ShimAvailable() === true` on Windows.
- **Risk**: MSVC-mangled names are architecture-dependent (x64 only) and more fragile than Itanium mangling, but V8's `Isolate` API has been stable for 8+ years. `GetProcAddress` returns null gracefully if symbols are missing.
