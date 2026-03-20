## 1. Config file capture and forwarding

- [x] 1.1 Add `setConfigFile`/`getConfigFile` accessors to `config.ts` (module-scoped state, same pattern as `setProjectRoot`)
- [x] 1.2 Add `configResolved` hook to the `vitiate:instrument` plugin in `plugin.ts` that captures `resolvedConfig.configFile` and calls `setConfigFile`
- [x] 1.3 Update `spawnChild` in `fuzz.ts` parent mode to read `getConfigFile()` and add `"--config", configPath` to the child's argv when available
- [x] 1.4 Write tests: child receives `--config` when config file is captured, `--config` omitted when config file is `undefined`

## 2. Unconditional fuzz options reading

- [x] 2.1 In `setup.ts`, change `const options = isFuzzingMode() ? getCliOptions() : {}` to `const options = getCliOptions()`
- [x] 2.2 Write tests: detector config from `VITIATE_OPTIONS` is applied in regression mode, default behavior preserved when env var is unset

## 3. Coverage map and trace function early initialization

Prerequisite for packages (group 4) working reliably. Must be done before packages.

- [x] 3.1a In `configResolved` hook (from 1.2), add early coverage map init for regression mode: create `Uint8Array(coverageMapSize)` and set `globalThis.__vitiate_cov`
- [x] 3.1b In `configResolved` hook, add early coverage map init for fuzz mode: load `@vitiate/engine` napi addon and call `createCoverageMap()` to get the Rust-backed buffer, set `globalThis.__vitiate_cov`. If the addon fails to load, throw immediately (fail-fast)
- [x] 3.1c Verify Vite lifecycle ordering: `configResolved` completes before vitest evaluates any inlined module code (Vite lifecycle: config -> configResolved -> module resolution -> transforms -> evaluation). Vite awaits async hooks. Document this assumption in a code comment at the hook site
- [x] 3.2 In `configResolved` hook, set `globalThis.__vitiate_cmplog_write` to a stable forwarding wrapper (delegates to replaceable internal no-op), and `globalThis.__vitiate_cmplog_reset_counts` similarly
- [x] 3.3 Update `setup.ts` `initGlobals()` to skip coverage map creation if `globalThis.__vitiate_cov` already exists; swap the cmplog internal implementation rather than replacing the function reference
- [x] 3.4 Write tests: `__vitiate_cov` is available after `configResolved` and before setup.ts, buffer identity is preserved across setup.ts, cmplog wrapper delegates to swapped implementation

## 4. Instrument packages option

Depends on group 3 (early init) for inlined dependencies to work without crashing.

- [x] 4.1 Add `packages?: string[]` to `InstrumentOptions` in `config.ts`, update `resolveInstrumentOptions` to pass through packages
- [x] 4.2 Implement package name matching function: check if a module ID contains `/node_modules/<packageName>/` on path segment boundaries (handles standard, pnpm, nested layouts, scoped packages)
- [x] 4.3 In `plugin.ts` `config()` hook, when `packages` is non-empty, return `test.server.deps.inline` containing regex patterns for each listed package
- [x] 4.4 In `plugin.ts` `transform` hook, check module ID against `packages` list before `instrumentFilter` - instrument if matched regardless of include/exclude
- [x] 4.5 In `plugin.ts` hooks plugin `transform` hook, bypass exclude filter for modules matching listed packages (so hooked import rewriting works in dependencies)
- [x] 4.6 Write tests: single package instrumented, multiple packages, pnpm layout matching, partial name rejection, scoped package matching, empty list no-op, vitiate packages rejected, hooks plugin rewrites hooked imports in listed packages

## 5. Remove nodeModulesExcluded heuristic

Depends on group 4 (packages must exist as the replacement).

- [x] 5.1 Remove the `nodeModulesExcluded` variable and the conditional `inline: true` logic from `plugin.ts`
- [x] 5.2 Ensure `**/node_modules/**` is always appended to the internal exclude list regardless of user-provided `exclude` patterns
- [x] 5.3 Change default `exclude` from `["**/node_modules/**"]` to `[]` in `config.ts` `resolveInstrumentOptions`
- [x] 5.4 Update or remove existing tests that assert the old heuristic behavior (exclude pattern string matching for "node_modules")
- [x] 5.5 Write tests: `exclude: []` no longer triggers `inline: true`, node_modules always excluded from include/exclude filter, exclude takes precedence over include

## 6. Include/exclude semantics documentation

- [x] 6.1 Update JSDoc on `InstrumentOptions.include` and `InstrumentOptions.exclude` in `config.ts` to document precedence (exclude wins over include) and scope (user code only, not dependencies)
- [x] 6.2 Update JSDoc on `InstrumentOptions.packages` to document its role as the dependency instrumentation mechanism

## 7. Documentation and examples

- [x] 7.1 Update README with `instrument.packages` usage example for dependency fuzzing
- [x] 7.2 Update README to document `include`/`exclude` precedence semantics and the breaking change (heuristic removal, default exclude change)
- [x] 7.3 Simplify `examples/detectors/` config to a single config file (remove duplicated config workaround) once config forwarding is working (N/A - the two configs serve different purposes, not a workaround)
- [x] 7.4 Add or update the flatted example to use `instrument.packages` instead of manual workarounds

## 8. Integration testing

- [x] 8.1 Run full test suite to verify no regressions from heuristic removal, default exclude change, and include/exclude changes
- [x] 8.2 Run e2e fuzz tests to verify end-to-end fuzzing still works with the new config surface
- [x] 8.3 Verify the flatted dependency fuzzing scenario works with `packages: ["flatted"]` end-to-end (instrumentation, corpus generation, detector activation in both fuzz and regression modes)
