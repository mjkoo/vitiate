## Context

Vitiate's configuration is currently split across four mechanisms:

1. **Environment variables**: `VITIATE_FUZZ` (mode), `VITIATE_FUZZ_OPTIONS` (JSON-encoded options), `VITIATE_CACHE_DIR` (cache path), `VITIATE_CORPUS_DIRS` (extra corpus dirs).
2. **CLI flags**: The standalone CLI (`cli.ts`) parses libFuzzer-style flags and injects them as env vars.
3. **Per-test options**: `fuzz(name, target, { maxLen: 4096 })` in test files.
4. **Plugin options**: `vitiatePlugin({ instrument: { ... } })` — currently only accepts instrumentation patterns.

The CLI already bridges flags → env vars (`cli.ts:68-76`). The fuzz loop merges per-test options with env-var-based CLI options (`fuzz.ts:58`). The missing link is a declarative way to set project-wide defaults in the Vitest config file.

The cache directory (`getCacheDir()` in `corpus.ts`) resolves `.vitiate-corpus` via `path.resolve()`, which is relative to `process.cwd()`. This is fragile — the same project produces different cache paths depending on the working directory.

## Goals / Non-Goals

**Goals:**

- Allow users to set project-wide fuzz defaults (`maxLen`, `timeoutMs`, `maxTotalTimeMs`, `runs`, `seed`, `cacheDir`) in `vitest.config.ts` via the plugin options.
- Anchor the default cache directory to the Vite project root instead of `cwd()`.
- Maintain full backward compatibility: env vars and per-test options continue to work and take precedence over plugin config.

**Non-Goals:**

- Standalone config file (`.vitiaterc`, `vitiate.config.js`). The Vitest config is sufficient.
- Changing the env-var-based protocol between the CLI and the fuzz loop. The CLI continues to set env vars; plugin config is an alternative source for the same env vars.
- Modifying the standalone CLI — it already has its own flag parsing and env var injection.

## Decisions

### 1. Plugin config injects env vars via `config()` hook

The plugin's `config()` hook already runs before any test code. We extend it to read `options.fuzz` and set the corresponding `process.env` values — the same ones the CLI sets. This means the fuzz loop, corpus module, and test registrar require zero changes to their option-reading code.

**Why env vars as the transport?** The plugin (`plugin.ts`) runs in the Vite config phase. The fuzz loop (`loop.ts`) and corpus module (`corpus.ts`) run inside Vitest workers. Workers inherit `process.env` from the parent, so env vars are the simplest cross-process communication channel. Vitest also has a `provide`/`inject` mechanism, but env vars are already the established pattern and avoid a dependency on Vitest internals.

**Precedence (lowest to highest):**

1. Plugin `fuzz` config defaults
2. `VITIATE_FUZZ_OPTIONS` / `VITIATE_CACHE_DIR` env vars
3. Per-test `FuzzOptions` argument

The `config()` hook only writes to env vars that are not already set. This means explicit env vars (from the CLI, CI, or the user's shell) always win.

### 2. Cache dir anchored to Vite's resolved root

The `config()` hook receives Vite's resolved `root` (the project root, typically where `vite.config.ts` lives). We pass this to `getCacheDir()` via `process.env.VITIATE_PROJECT_ROOT`.

`getCacheDir()` resolution order:

1. `VITIATE_CACHE_DIR` env var — used as-is (absolute) or resolved relative to project root.
2. `VITIATE_PROJECT_ROOT` env var + `.vitiate-corpus` — set by the plugin.
3. Fall back to `path.resolve(".vitiate-corpus")` (cwd-relative, same as today).

This means: when running via the Vitest plugin (normal case), the cache is always project-root-relative. When running outside of the plugin (unlikely), the old cwd behavior is preserved.

**Why not git-walk?** Walking up to find `.git` is an option, but Vite already resolves the project root correctly (including monorepo support via `root` config). Using Vite's root avoids reimplementing project root detection and stays consistent with how Vite resolves all other paths.

### 3. `FuzzDefaults` type as a subset of `FuzzOptions`

The plugin config `fuzz` field uses the same shape as the existing `FuzzOptions` plus `cacheDir`. We define `FuzzDefaults` as `FuzzOptions & { cacheDir?: string }`. This keeps the types aligned and avoids inventing a parallel config vocabulary.

## Risks / Trade-offs

- **Cache location change**: Users who previously relied on the cwd-relative default will find their cache in a different location after this change. Mitigation: this only affects users running Vitest from a non-root directory, and the new location is more correct. The old cache is simply orphaned (no data loss, just a stale directory). We do not attempt automatic migration.

- **Env var pollution**: The plugin writes to `process.env` in `config()`. This is an established pattern (the CLI does the same thing), but env vars are global state. Mitigation: we only write vars that are not already set, and only the vitiate-namespaced vars.

- **Worker inheritance**: Vitest workers inherit env vars from the parent process. If Vitest's worker isolation model changes in a future version, this transport mechanism could break. Mitigation: env vars are the most basic IPC mechanism and are unlikely to be stripped from worker processes.
