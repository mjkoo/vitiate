## Why

Fuzzing third-party dependencies (e.g. `flatted` for prototype pollution) requires the user to understand and work around three independent internal mechanisms: config resolution in child processes, vitest's `server.deps.inline`, and the `nodeModulesExcluded` heuristic in the plugin. On top of that, detector config set at the plugin level is silently ignored in regression mode, so known-bad corpus entries replay without triggering vulnerability errors. These issues compound into a frustrating onboarding experience that makes dependency fuzzing effectively inaccessible without reading source code.

## What Changes

- **Config forwarding**: The supervisor's `spawnChild` will forward the resolved `--config` path to child vitest processes, so the child always uses the same config as the parent instead of walking up directories to find an unrelated config.
- **`instrument.packages` replaces `nodeModulesExcluded` heuristic**: A new high-level config option that accepts package names (e.g. `packages: ["flatted"]`). The plugin automatically handles vitest inlining and transform filter bypass for listed packages. The confusing `nodeModulesExcluded` heuristic (implicit `inline: true` based on exclude pattern string matching) is removed entirely. `include`/`exclude` are scoped to the user's own code only - all dependency instrumentation goes through `packages`. **BREAKING**: users who relied on removing "node_modules" from exclude patterns to instrument deps must switch to `packages`.
- **Fix coverage map initialization ordering**: When dependencies are inlined (via `packages`), they may evaluate before `setup.ts` initializes `__vitiate_cov`. Fix the initialization ordering so instrumented inlined dependencies don't crash. This is a prerequisite for `packages` working reliably.
- **Detector config in regression mode**: `setup.ts` will read detector config from `VITIATE_OPTIONS` in all modes (not just when `VITIATE_FUZZ=1`), so plugin-level detector settings apply during `vitest run` regression testing.

## Capabilities

### New Capabilities

- `dependency-instrumentation`: High-level `instrument.packages` option for instrumenting specific node_modules dependencies. Replaces the `nodeModulesExcluded` heuristic and manual `server.deps.inline` plumbing. Includes fixing the coverage map initialization ordering so that inlined dependencies don't crash.

### Modified Capabilities

- `vitest-plugin`: Capture resolved config path via `configResolved` hook. Handle `instrument.packages` by auto-configuring `server.deps.inline` and bypassing the `instrumentFilter` for listed packages. Remove the `nodeModulesExcluded` heuristic. Enforce that `include`/`exclude` only affect the user's own code (node_modules always excluded from glob-based filtering).
- `parent-supervisor`: Forward `--config <resolvedPath>` when spawning child vitest processes, so child always inherits the parent's config file.
- `runtime-setup`: Read `VITIATE_OPTIONS` unconditionally (not gated on `isFuzzingMode()`) so detector config applies in regression mode.

## Impact

- **Config**: New `instrument.packages` field in `InstrumentOptions`. Default `exclude` changes from `["**/node_modules/**"]` to `[]` (node_modules is now always excluded internally). **BREAKING**: removal of the `nodeModulesExcluded` heuristic changes behavior for users who relied on exclude pattern manipulation to control dependency inlining (this behavior was buggy and undocumented).
- **Files**: `vitiate-core/src/plugin.ts` (config capture, packages logic, heuristic removal), `vitiate-core/src/fuzz.ts` (child spawn args), `vitiate-core/src/config.ts` (schema addition), `vitiate-core/src/setup.ts` (unconditional options read), `vitiate-core/src/globals.ts` (early coverage map init).
- **Examples**: `examples/detectors/` can be simplified to a single config file once config forwarding works.
- **Behavior changes**: Regression mode will now activate Tier 2 detectors when configured at the plugin level (bug fix). Inlined dependencies no longer crash due to uninitialized coverage map (bug fix).
