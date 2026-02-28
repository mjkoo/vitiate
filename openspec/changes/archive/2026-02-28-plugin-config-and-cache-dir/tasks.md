## 1. Expand Plugin Options Type

- [x] 1.1 Add `FuzzDefaults` type to `config.ts`: `FuzzOptions & { cacheDir?: string }`
- [x] 1.2 Add optional `fuzz?: FuzzDefaults` field to `VitiatePluginOptions`
- [x] 1.3 Export `FuzzDefaults` from `index.ts`

## 2. Plugin Config Hook - Inject Defaults

- [x] 2.1 Extend `vitiatePlugin()` in `plugin.ts` to accept and destructure `options.fuzz`
- [x] 2.2 In the `config()` hook, resolve the Vite project root from the incoming config's `root` (default `process.cwd()`) and set `VITIATE_PROJECT_ROOT` if not already set
- [x] 2.3 In the `config()` hook, if `fuzz.cacheDir` is provided, resolve it relative to the project root and set `VITIATE_CACHE_DIR` if not already set
- [x] 2.4 In the `config()` hook, if any `FuzzOptions` fields are provided in `fuzz`, serialize them as JSON and set `VITIATE_FUZZ_OPTIONS` if not already set
- [x] 2.5 Write unit tests for the config hook: verify env vars are set when absent, verify env vars are not overwritten when already set, verify cacheDir is resolved against project root

## 3. Cache Directory Resolution

- [x] 3.1 Update `getCacheDir()` in `corpus.ts` to use `VITIATE_PROJECT_ROOT` as the base for the default `.vitiate-corpus` path when available
- [x] 3.2 When `VITIATE_CACHE_DIR` is a relative path, resolve it against `VITIATE_PROJECT_ROOT` (if set) rather than cwd
- [x] 3.3 Update existing `getCacheDir` tests to cover: project-root-anchored default, relative VITIATE_CACHE_DIR resolved against project root, absolute VITIATE_CACHE_DIR used as-is, fallback to cwd when no project root

## 4. Integration Verification

- [x] 4.1 Update the plugin unit tests to verify the full options shape is accepted (fuzz + instrument)
- [x] 4.2 Verify the e2e test continues to pass (it sets VITIATE_CACHE_DIR explicitly, so behavior is unchanged)
- [x] 4.3 Run the full test suite (`pnpm test`) and confirm no regressions
