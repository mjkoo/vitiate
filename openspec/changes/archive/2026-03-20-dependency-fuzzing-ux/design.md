## Context

Dependency fuzzing (instrumenting and fuzzing code inside `node_modules`) currently requires understanding three internal mechanisms: vitest's `server.deps.inline`, the plugin's `nodeModulesExcluded` heuristic, and the supervisor's config resolution behavior. Additionally, plugin-level detector config is silently ignored in regression mode. These issues were discovered while setting up a fuzz test for flatted@3.4.1 (prototype pollution, GHSA-rf6f-7fwh-wjgh) and are documented in CONFIG_FIX.md.

The fixes are independent - each can be implemented and tested separately.

## Goals / Non-Goals

**Goals:**

- A user can instrument a specific npm package by name without understanding vitest internals or glob patterns
- `include`/`exclude` are scoped to the user's own code; dependency instrumentation is exclusively via `packages`
- The `nodeModulesExcluded` heuristic is removed - no more implicit `inline: true` based on pattern matching
- Coverage map initialization ordering is fixed so inlined dependencies don't crash
- The supervisor child process always uses the same vitest config as the parent
- Plugin-level detector config works in regression mode without per-test duplication

**Non-Goals:**

- Supporting instrumentation of transitive dependencies by name (only direct package names)
- Changing the `VITIATE_OPTIONS` env var name or the env-var-based config transport mechanism

## Decisions

### Decision 1: Config forwarding via `configResolved` hook + module-scoped stash

The `vitiatePlugin` will add a `configResolved` hook to the instrument plugin that captures `resolvedConfig.configFile` (a standard Vite property - the resolved absolute path to the config file, or `false` if no config file was used). This path is stored in a module-scoped variable (same pattern as `setProjectRoot`/`getProjectRoot`) and exported from `config.ts`.

In `fuzz.ts`, the `spawnChild` callback reads the stashed config path and adds `"--config", configPath` to the child's argv.

**Alternative considered:** Passing the config path via an env var (e.g. `VITIATE_CONFIG_FILE`). Rejected because the config path is only needed in-process (parent reads it before spawning the child), so module-scoped state is simpler and avoids adding another env var.

**Alternative considered:** Using `config()` hook's `config.configFile` instead of `configResolved`. Rejected because `config()` receives the user config before resolution - `configFile` may not be populated yet. `configResolved` receives the fully resolved config where `configFile` is guaranteed to be set.

### Decision 2: Clarify `include`/`exclude` semantics and add `instrument.packages`

This is a net simplification of the instrumentation config surface, from 3 mechanisms to 2 with clearly documented semantics.

**Before (3 mechanisms, unclear semantics):**
- `include`/`exclude` - glob-based scope, but also implicitly controlled dependency inlining via the `nodeModulesExcluded` heuristic. Precedence between include and exclude was undocumented.
- `nodeModulesExcluded` heuristic - if no exclude pattern mentions "node_modules", set `inline: true` for ALL deps (confusing, all-or-nothing, triggered by string matching on patterns)
- Manual `test.server.deps.inline` - vitest plumbing the user had to know about

**After (2 mechanisms with clear separation and documented semantics):**
- `include`/`exclude` - control instrumentation of the user's own code only (node_modules always excluded). Documented precedence: exclude always wins.
- `packages` - explicit list of npm package names to instrument. The plugin handles both vitest inlining and transform filter bypass automatically.

#### `include`/`exclude` semantics

`include` and `exclude` use the same precedence model as the path traversal detector's `allowedPaths`/`deniedPaths` - the negative list always wins:

1. If a file matches any `exclude` pattern, it is **not instrumented** (exclude wins, no override)
2. If a file matches any `include` pattern, it **is instrumented**
3. If no `include` patterns are specified, all non-excluded JS/TS files are instrumented (default: instrument everything)
4. If `include` patterns are specified but a file doesn't match any, it is **not instrumented**

This is the existing behavior of Vite's `createFilter` (which vitiate already uses), but it was undocumented. Making it explicit aligns with the precedence model already established in the path traversal detector config: `deniedPaths` always wins over `allowedPaths`, just as `exclude` always wins over `include`.

Both `include` and `exclude` are needed:
- `include` for narrowing scope: "only instrument `src/parser/`" - expressing this as excludes requires excluding everything else, which is the same glob negation problem that made dependency instrumentation painful
- `exclude` for carving exceptions: "skip generated code in `src/generated/`"

`include`/`exclude` only affect the user's own code. `**/node_modules/**` is always appended to the exclude list internally, regardless of user config. These options never affect dependency inlining or instrumentation - that is exclusively controlled by `packages`. Because node_modules is always internally excluded, the default for `exclude` changes from `["**/node_modules/**"]` to `[]` - the user-visible default now clearly communicates "we don't exclude any of your code by default."

**Alternative considered:** Exclude-only (gitignore-style). Rejected because narrowing scope ("only instrument the parser") is a legitimate use case that is painful to express as exclusions. Both lists are needed for the same reason the path traversal detector has both `allowedPaths` and `deniedPaths`.

#### `instrument.packages`

Add `packages?: string[]` to `InstrumentOptions`. The plugin handles two things automatically:

1. **Inline control**: For each listed package, add a regex to the `test.server.deps.inline` array returned from the `config()` hook. This tells vitest to route the package through the Vite transform pipeline instead of externalizing it. Vite's `mergeConfig` concatenates arrays, so the plugin's inline entries are appended to any user-provided `test.server.deps.inline` configuration without replacing it.

2. **Transform filter bypass**: In the `transform` hook, before checking `instrumentFilter(id)`, check if the module ID contains `/node_modules/<packageName>/` (matching anywhere in the path to handle pnpm's nested `.pnpm/<pkg>@<version>/node_modules/<pkg>/` layout). If it matches a listed package, instrument it regardless of the `instrumentFilter` result. The `include`/`exclude` filter is not consulted for packages - they are a separate instrumentation domain.

3. **Hooks filter bypass**: The `vitiate:hooks` plugin also uses the packages list to bypass its exclude filter. Since `**/node_modules/**` is always in the exclude list, the hooks plugin would otherwise skip dependency modules. For listed packages, the hooks plugin processes modules regardless of the exclude filter, ensuring detector import rewriting works in instrumented dependencies.

The `nodeModulesExcluded` heuristic is removed entirely. The plugin never sets `inline: true` globally - only specific packages listed in `packages` are inlined. This is a **breaking change** for anyone who relied on the heuristic (removing "node_modules" from exclude patterns to inline everything), but that behavior was buggy (crashed on many real-world deps) and undocumented.

**Alternative considered:** Keeping the heuristic and adding `packages` alongside it. Rejected because it adds a fourth knob without removing any complexity. The heuristic is the primary source of confusion and its trigger condition (string matching on exclude patterns) is surprising.

**Alternative considered:** Auto-detecting packages from `include` patterns that mention `node_modules`. Rejected because it's fragile (what counts as a package name in a glob?) and implicit (the user doesn't see that inline is being set). Explicit `packages` is clearer.

**Matching strategy**: Match `/node_modules/<packageName>/` as a substring of the resolved module ID. This handles:
- Standard `node_modules/flatted/src/index.js`
- pnpm `node_modules/.pnpm/flatted@3.4.1/node_modules/flatted/src/index.js`
- Nested deps `node_modules/foo/node_modules/flatted/src/index.js`

The match must be on a path segment boundary (surrounded by `/`) to avoid `flat` matching `flatted`.

**Scoped packages in pnpm layouts**: Scoped packages like `@scope/pkg` appear in pnpm as `node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/`. The matching strategy works correctly because it targets the final `/node_modules/@scope/pkg/` segment in the path, not the `.pnpm` directory where `@scope/pkg` is encoded as `@scope+pkg`.

### Decision 3: Early coverage map and trace function initialization in `configResolved`

When dependencies are inlined (via `packages`), vitest may evaluate them during module graph construction before `setup.ts` runs `initGlobals()`. If an instrumented dependency evaluates before `__vitiate_cov` exists, it crashes - the `ipaddr.js` error (`Cannot read properties of undefined (reading '50368')`) from CONFIG_FIX.md is the canonical example of this.

This is a prerequisite for `packages` working reliably: any package listed in `packages` gets instrumented and inlined, so it must be safe for instrumented code to run before setup.ts.

**Vite lifecycle guarantee:** Vite awaits all `configResolved` hooks (including async hooks) to completion before proceeding to module resolution, transforms, or evaluation. The Vite lifecycle is: `config` -> `configResolved` -> module resolution -> transforms -> evaluation. This ordering guarantees that globals initialized in `configResolved` are available before any instrumented code can execute. This is the foundational assumption for the early-init approach. If the `@vitiate/engine` napi addon fails to load in fuzz mode, the hook throws immediately (fail-fast), failing the Vitest startup.

**Coverage map (`__vitiate_cov`):** The plugin's `configResolved` hook creates the coverage map before any module transforms occur. This is the single creation point - the buffer is never replaced, preserving identity for modules that cache a reference at module scope.

- In regression mode: create a plain `Uint8Array(coverageMapSize)`.
- In fuzz mode: load the `@vitiate/engine` napi addon and call `createCoverageMap(coverageMapSize)` to get the Rust-backed buffer. The plugin already resolves `@vitiate/engine/package.json` for exclusion, so the addon is available. Loading it at config time adds a small one-time startup cost but guarantees the Rust-backed buffer exists before any instrumented code runs.

`setup.ts`'s `initGlobals()` checks if `globalThis.__vitiate_cov` already exists and skips creation if so. This preserves buffer identity - there is exactly one buffer for the process lifetime.

**Trace function (`__vitiate_cmplog_write`):** The SWC plugin also emits calls to `globalThis.__vitiate_cmplog_write`, which modules cache at module scope. The same identity problem applies. The `configResolved` hook sets `globalThis.__vitiate_cmplog_write` to a stable forwarding wrapper that delegates to an internal implementation variable. Initially the implementation is a no-op. When `setup.ts` runs in fuzz mode, it swaps the internal implementation to the real slot-buffer writer. The wrapper function reference never changes, so modules that cached it during early evaluation call through to the real implementation after setup.ts runs.

**Shared state for implementation swapping:** The forwarding wrapper reads the current implementation from `globalThis.__vitiate_cmplog_write_impl` (and `globalThis.__vitiate_cmplog_reset_counts_impl`) on each call. `configResolved` sets these to no-ops. `setup.ts` replaces them with the real implementations in fuzz mode. This avoids coupling the plugin and setup modules through a shared JS module import - `globalThis` is the coordination point, consistent with how `__vitiate_cov` is shared.

In regression mode, the implementation stays as a no-op (the wrapper delegates to it). No replacement needed.

**Alternative considered:** Having the SWC plugin emit a guard (`globalThis.__vitiate_cov ??= new Uint8Array(N)`) at the top of each instrumented file. Rejected because it doesn't preserve buffer identity in fuzz mode (the guard creates a Uint8Array, but fuzz mode needs a Rust-backed buffer - modules that cached the guard's buffer would miss coverage). Plugin-level early init with the correct buffer type avoids this entirely.

**Alternative considered:** Not caching globals at module scope (always reading from `globalThis`). Rejected because the extra property lookup on every counter increment is a measurable hot-path cost.

### Decision 4: Read `VITIATE_OPTIONS` unconditionally in setup.ts

Change `setup.ts` line 27 from:

```typescript
const options = isFuzzingMode() ? getCliOptions() : {};
```

to:

```typescript
const options = getCliOptions();
```

`getCliOptions()` reads `VITIATE_OPTIONS` and parses it via the `FuzzOptionsSchema` validator. This is safe to call unconditionally - when the env var is unset (no plugin, or plugin had no fuzz options), `getCliOptions()` returns `{}`, which is the same as the current regression-mode behavior.

This means `installDetectorModuleHooks(options.detectors)` receives the plugin's detector config in all modes. The `DetectorManager` and module hooks already work correctly in regression mode (the hooks plugin already runs in all modes) - the only bug was that the config wasn't being read.

**Alternative considered:** A separate `VITIATE_DETECTOR_OPTIONS` env var for detector-only config. Rejected because it's more code for the same result, and the detector config is already inside `VITIATE_OPTIONS` - extracting it into a separate var creates a second source of truth.

**Alternative considered:** Using vitest's `test.provide` instead of env vars. Rejected because `setup.ts` runs before test files, and `provide` is populated at test registration time - the timing doesn't work. Env vars are set in the plugin's `config()` hook which runs before any setup files.

## Risks / Trade-offs

**Breaking change: heuristic removal.** Users who relied on removing "node_modules" from exclude to inline all deps will need to switch to `packages`. The old behavior crashed on many real-world dependency sets anyway, so the practical impact is low. Should be called out in release notes.

**`packages` matching false positives**: A package named `a` would match any path containing `/node_modules/a/`. This is unlikely in practice (npm package names are typically longer), and the consequence is over-instrumentation (harmless extra coverage counters), not incorrect behavior.

**Config forwarding assumes single config file**: If a project uses vitest workspace configs, `configResolved` returns the workspace-level config, which may not be the right one for the child. This is an existing limitation of the supervisor pattern (it spawns a single-file vitest run) and is not made worse by this change. The child currently finds *no* config or the *wrong* config - forwarding the parent's config is strictly better.

**`getCliOptions()` in regression mode parses fuzz-specific options**: In regression mode, options like `fuzzTimeMs` and `maxLen` are harmless (they're only read by the fuzz loop, which doesn't run in regression mode). The only field that matters is `detectors`, and it's already validated by the schema.

**Napi addon loaded at config time in fuzz mode**: The `configResolved` hook loads `@vitiate/engine` and calls `createCoverageMap()` to create the Rust-backed buffer early. This means the native addon is loaded during Vite config resolution rather than during test setup. If the addon fails to load (e.g., missing prebuilt binary), the error surfaces earlier than before. This is arguably better (fail-fast) but changes the error timing.

**Inline array merge behavior**: The plugin returns `test.server.deps.inline` containing regexes for listed packages. Vite's `mergeConfig` concatenates arrays, so user-provided inline entries are preserved. If a future Vite version changes merge behavior for this field, the interaction could break.
