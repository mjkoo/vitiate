## MODIFIED Requirements

### Requirement: Coverage map initialization

`globalThis.__vitiate_cov` SHALL be initialized in the plugin's `configResolved` hook, before any module transforms or evaluations occur. This is the single creation point - the buffer is never replaced, and the buffer identity SHALL remain stable for the entire process lifetime. Instrumented modules cache a module-level reference and the identity MUST NOT change.

In regression mode (default): `__vitiate_cov` SHALL be a plain `Uint8Array` of the configured coverage map size (default 65536, configurable via `coverageMapSize` plugin option) that absorbs counter writes without any consumer reading the data.

In fuzzing mode (`VITIATE_FUZZ` env var is set): `__vitiate_cov` SHALL be the `Buffer` returned from `createCoverageMap(getCoverageMapSize())` backed by Rust memory for zero-copy feedback to the fuzzing engine. The `@vitiate/engine` napi addon SHALL be loaded in the plugin's `configResolved` hook to create this buffer early.

`setup.ts`'s `initGlobals()` SHALL check if `globalThis.__vitiate_cov` already exists. If it does, `initGlobals()` SHALL skip coverage map creation and reuse the existing buffer. If it does not (e.g., running without the plugin in standalone CLI mode), `initGlobals()` SHALL create the buffer as before.

#### Scenario: Regression mode initialization

- **WHEN** Vitest starts without `VITIATE_FUZZ` set
- **THEN** `globalThis.__vitiate_cov` is a `Uint8Array` of the configured coverage map size
- **AND** instrumented code can write to it without errors

#### Scenario: Fuzzing mode initialization

- **WHEN** Vitest starts with `VITIATE_FUZZ=1`
- **THEN** `globalThis.__vitiate_cov` is the Rust-backed `Buffer` from `createCoverageMap(getCoverageMapSize())`
- **AND** the buffer is backed by Rust memory for zero-copy engine access
- **AND** the buffer was created in the plugin's `configResolved` hook before any module transforms

#### Scenario: Buffer identity is stable

- **WHEN** `globalThis.__vitiate_cov` is initialized in `configResolved`
- **THEN** the same object reference persists for the entire process lifetime
- **AND** any module-level `let __vitiate_cov = globalThis.__vitiate_cov` cache remains valid
- **AND** `setup.ts` does NOT replace the buffer

#### Scenario: Inlined dependency evaluates before setup

- **WHEN** a dependency listed in `instrument.packages` is inlined by vitest
- **AND** vitest evaluates the dependency module during module graph construction before setup files run
- **THEN** `globalThis.__vitiate_cov` is already a valid writable buffer (created in `configResolved`)
- **AND** the instrumented dependency code does not throw

#### Scenario: Standalone CLI mode without plugin

- **WHEN** the standalone CLI runs without the Vite plugin (no `configResolved` hook)
- **AND** `globalThis.__vitiate_cov` is not set
- **THEN** `setup.ts`'s `initGlobals()` creates the coverage map as before

### Requirement: Trace function early initialization

`globalThis.__vitiate_cmplog_write` SHALL be initialized in the plugin's `configResolved` hook as a stable forwarding wrapper. The wrapper SHALL read the current implementation function from `globalThis.__vitiate_cmplog_write_impl` on each call and delegate to it. Initially `globalThis.__vitiate_cmplog_write_impl` SHALL be set to a no-op `(_l, _r, _c, _o) => {}`.

When `setup.ts` runs in fuzz mode, it SHALL replace `globalThis.__vitiate_cmplog_write_impl` with the real slot-buffer writer function. The wrapper function reference on `globalThis.__vitiate_cmplog_write` itself SHALL never change, preserving identity for modules that cached it at module scope during early evaluation. Subsequent calls through the cached wrapper delegate to the new implementation via the `globalThis.__vitiate_cmplog_write_impl` indirection.

In regression mode, `globalThis.__vitiate_cmplog_write_impl` SHALL remain a no-op. `setup.ts` SHALL not replace it.

A companion `globalThis.__vitiate_cmplog_reset_counts` SHALL also be initialized early as a forwarding wrapper, reading from `globalThis.__vitiate_cmplog_reset_counts_impl` (initially a no-op `() => {}`), following the same pattern.

The `globalThis` indirection is chosen over closure-captured or module-scoped variables to avoid coupling the plugin and setup modules through a shared JS module import. `globalThis` is the coordination point, consistent with how `__vitiate_cov` is shared.

`setup.ts`'s `initGlobals()` SHALL check if `globalThis.__vitiate_cmplog_write` already exists. If it does, it SHALL replace `globalThis.__vitiate_cmplog_write_impl` (and `globalThis.__vitiate_cmplog_reset_counts_impl`) with the real implementations rather than replacing the wrapper function references. If `globalThis.__vitiate_cmplog_write` does not exist (standalone CLI mode), it SHALL create the function as before.

#### Scenario: Trace function available before setup

- **WHEN** a dependency listed in `instrument.packages` is inlined by vitest
- **AND** the dependency module is evaluated before setup files run
- **AND** the module contains comparison operators that the SWC plugin replaced with `__vitiate_cmplog_write` calls
- **THEN** `globalThis.__vitiate_cmplog_write` is already a callable function (no-op wrapper)
- **AND** the calls succeed without throwing

#### Scenario: Trace function delegates to real implementation after setup

- **WHEN** `globalThis.__vitiate_cmplog_write` is set to the forwarding wrapper in `configResolved`
- **AND** a module caches the function reference at module scope
- **AND** `setup.ts` later swaps the internal implementation to the real slot-buffer writer
- **THEN** subsequent calls through the cached reference delegate to the real implementation

#### Scenario: Regression mode trace function remains no-op

- **WHEN** Vitest starts without `VITIATE_FUZZ` set
- **THEN** `globalThis.__vitiate_cmplog_write` is a callable function
- **AND** calling it has no side effects
- **AND** `setup.ts` does not swap the implementation

## ADDED Requirements

### Requirement: Unconditional fuzz options reading

The runtime setup module SHALL read `VITIATE_OPTIONS` unconditionally in all modes (fuzz, regression, optimize, merge), not gated on `isFuzzingMode()`. This ensures plugin-level detector config is available for `installDetectorModuleHooks()` in all modes.

When `VITIATE_OPTIONS` is not set (no plugin, or plugin had no fuzz options), `getCliOptions()` SHALL return `{}`, preserving the current regression-mode default behavior.

#### Scenario: Detector config applied in regression mode

- **WHEN** the plugin serialized `{ detectors: { prototypePollution: true } }` to `VITIATE_OPTIONS`
- **AND** vitest runs in regression mode (no `VITIATE_FUZZ` set)
- **THEN** `getCliOptions()` returns the parsed options including detector config
- **AND** `installDetectorModuleHooks()` receives `{ prototypePollution: true }`
- **AND** the prototype pollution detector is active during corpus replay

#### Scenario: Detector config applied in fuzz mode

- **WHEN** the plugin serialized `{ detectors: { prototypePollution: true } }` to `VITIATE_OPTIONS`
- **AND** vitest runs in fuzz mode (`VITIATE_FUZZ=1`)
- **THEN** `getCliOptions()` returns the parsed options including detector config
- **AND** `installDetectorModuleHooks()` receives `{ prototypePollution: true }`

#### Scenario: No fuzz options env var

- **WHEN** `VITIATE_OPTIONS` is not set in the environment
- **THEN** `getCliOptions()` returns `{}`
- **AND** `installDetectorModuleHooks()` receives `undefined` for detectors
- **AND** only Tier 1 detectors are active (default behavior preserved)
