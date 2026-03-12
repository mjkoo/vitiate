## Context

The vitiate plugin has two Vite plugins that both independently skip node_modules:

1. **`vitiate:instrument`** - Uses `@rollup/pluginutils` `createFilter(include, exclude)` where `exclude` defaults to `["**/node_modules/**"]`. This is configurable via `InstrumentOptions.exclude`.
2. **`vitiate:hooks`** - Has a hardcoded `id.includes("/node_modules/") || id.includes("\\node_modules\\")` check that returns `null` unconditionally. This is not configurable.

Additionally, Vitest externalizes node_modules by default (via `server.deps.external`), meaning those files never enter the Vite transform pipeline at all - even if both plugin-level checks were removed.

A user setting `instrument: { exclude: [] }` today would only affect layer 1. The hooks plugin and Vitest externalization would still block node_modules.

## Goals / Non-Goals

**Goals:**

- Single configuration surface: the existing `InstrumentOptions.exclude` pattern controls all three layers (hooks plugin, instrument plugin, Vitest externalization).
- Default behavior unchanged: `**/node_modules/**` excluded by default.
- When node_modules are included, Vitest's dep inlining is configured automatically so the user doesn't need to understand Vitest internals.
- Vitiate's own packages remain unconditionally excluded (already handled by explicit path exclusions appended after user config).

**Non-Goals:**

- Fine-grained per-package control of which node_modules to instrument (users can achieve this with include/exclude glob patterns - no special API needed).
- CLI-level flags for controlling instrumentation scope (this is a plugin config concern).
- Changing the standalone CLI behavior (it already passes `instrument: {}` which uses defaults).

## Decisions

### Decision 1: Share the resolved filter with the hooks plugin

The hooks plugin's `transform` currently hardcodes the node_modules check. Instead, it will use a separate `createFilter` built from the same resolved exclude patterns but without the include patterns. The hooks plugin must process all JS/TS files that aren't excluded - not just files matching the instrument plugin's include globs - because detector import rewriting needs to work across all user code regardless of instrumentation scope.

**Rationale:** The hooks plugin and instrument plugin have different responsibilities. The instrument plugin adds coverage counters to a scoped set of files (controlled by include + exclude). The hooks plugin rewrites imports of hooked built-in modules so detectors can intercept calls - this must work everywhere detectors are active, which is all user code not in the exclude list. If a user sets `include: ["src/**/*.ts"]` to instrument only their source, the hooks plugin must still rewrite imports in test files so detectors fire during regression testing.

Concretely: the instrument plugin uses `createFilter(include, exclude)`, while the hooks plugin uses `createFilter(undefined, exclude)` (where both share the same resolved exclude array plus vitiate's own package exclusions).

**Alternative considered:** A single shared filter for both plugins. Rejected because it couples the hooks plugin's scope to the include patterns, which would silently break detectors when users narrow instrumentation scope.

**Alternative considered:** A separate boolean flag like `instrumentNodeModules: true`. Rejected because it's redundant with the exclude patterns and adds a second way to express the same thing.

### Decision 2: Auto-configure `server.deps.inline` when node_modules are not fully excluded

When the resolved exclude patterns do not contain a glob that covers `**/node_modules/**`, the plugin's `config()` hook will return `server: { deps: { inline: true } }` to tell Vitest to inline all dependencies through the Vite pipeline.

**Rationale:** Without this, Vitest externalizes node_modules and they never reach the transform hooks. Setting `inline: true` is a broad hammer but is correct - the user has explicitly opted in to instrumenting dependencies. Vitest deep-merges `config()` returns, so if the user also sets `server.deps.inline` in their own config, Vite's merge behavior applies.

**Alternative considered:** Parsing the include/exclude patterns to derive a precise list of packages to inline. Rejected - glob pattern analysis is fragile and `inline: true` is the correct intent when the user has removed the node_modules exclusion.

### Decision 3: Detect "node_modules not excluded" via simple heuristic

Rather than attempting to evaluate whether arbitrary glob patterns would match node_modules paths, use a simple check: if none of the resolved exclude patterns contain the substring `node_modules`, assume node_modules are included and configure `server.deps.inline`.

**Rationale:** This covers the two realistic use cases - the default (`["**/node_modules/**"]` → excluded) and the opt-in (`[]` or patterns that don't mention node_modules → included). Edge cases like `["**/node_modules/lodash/**"]` (partially excluding some packages) would still trigger inlining, which is correct - some node_modules need to be in the pipeline.

## Risks / Trade-offs

- **Performance**: Instrumenting node_modules increases build time and coverage map pressure. This is the user's explicit choice. → Document the performance implications.
- **Coverage map saturation**: Large dependency trees may exhaust coverage map slots, reducing feedback quality. → Users can increase `coverageMapSize` if needed. Worth mentioning in docs.
- **`server.deps.inline: true` side effects**: Inlining all deps changes how Vitest resolves modules, which could cause issues with packages that rely on being externalized (e.g., native addons, packages with `require` of non-JS files). → This only activates when the user explicitly opts in by modifying exclude patterns. The risk is acceptable and matches what the user asked for.
