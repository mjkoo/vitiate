## Why

Fuzzing configuration is scattered across four environment variables (`VITIATE_FUZZ`, `VITIATE_FUZZ_OPTIONS`, `VITIATE_CACHE_DIR`, `VITIATE_CORPUS_DIRS`), CLI flags, and per-test `FuzzOptions` arguments. There is no way to set project-wide fuzz defaults declaratively. Additionally, the cache directory resolves relative to `process.cwd()` rather than the project root, causing fragmented corpora when Vitest is invoked from different working directories.

Since vitiate is a Vitest plugin, the Vitest/Vite config file is the natural place for project-wide defaults - users already have one. This change adds a `fuzz` section to the plugin options and anchors the cache directory to the Vite project root.

## What Changes

- Expand `VitiatePluginOptions` with a `fuzz` section accepting project-wide defaults: `maxLen`, `timeoutMs`, `maxTotalTimeMs`, `runs`, `seed`, and `cacheDir`.
- The plugin's `config()` hook injects these defaults into `process.env` (as `VITIATE_FUZZ_OPTIONS` and `VITIATE_CACHE_DIR`), preserving backward compatibility with the env-var-based approach. Explicit env vars take precedence over plugin config.
- Change `getCacheDir()` to anchor the default `.vitiate-corpus/` directory to the Vite-resolved project root instead of `process.cwd()`. The `VITIATE_CACHE_DIR` env var remains as an escape hatch.
- The plugin resolves the project root from Vite's `config.root` (available in the `config()` hook) and communicates it to the corpus module via an env var (`VITIATE_PROJECT_ROOT`), keeping the corpus module free of Vite dependencies.

## Capabilities

### New Capabilities

_None - this change extends existing capabilities rather than introducing new ones._

### Modified Capabilities

- `vitest-plugin`: The plugin factory function accepts an expanded `options.fuzz` object and injects resolved defaults into the environment via `config()`.
- `corpus-management`: Cache directory resolution changes from `cwd()`-relative to project-root-relative by default.

## Impact

- **Files modified**: `vitiate/src/config.ts`, `vitiate/src/plugin.ts`, `vitiate/src/corpus.ts`, and their corresponding test files.
- **API**: `VitiatePluginOptions` gains an optional `fuzz` field. Fully backward compatible - existing code that passes no `fuzz` option behaves identically.
- **Behavior change**: The default cache directory location may change for users who run Vitest from a directory other than the project root. This is intentional - it fixes corpus fragmentation. Users with `VITIATE_CACHE_DIR` set are unaffected.
- **Dependencies**: No new dependencies. The Vite `config.root` is already available in the plugin's `config()` hook.
