## 1. Unify filter usage across both plugins

- [x] 1.1 Create two `createFilter` instances from the resolved options: one with include+exclude for the instrument plugin, one with exclude-only for the hooks plugin. Both share the same resolved exclude array and vitiate-package exclusions.
- [x] 1.2 Replace the hardcoded `id.includes("/node_modules/") || id.includes("\\node_modules\\")` check in the hooks plugin's `transform` with the exclude-only filter (keeping the virtual module `\0` and JS/TS extension checks)
- [x] 1.3 Write tests: hooks plugin processes a node_modules file when `exclude: []` is set
- [x] 1.4 Write tests: hooks plugin skips node_modules files with default config
- [x] 1.5 Write tests: vitiate's own packages are excluded even when `exclude: []`
- [x] 1.6 Write tests: narrowing `include` (e.g., `["src/**/*.ts"]`) does not prevent the hooks plugin from rewriting imports in files outside the include scope (e.g., test files)

## 2. Auto-configure Vitest dependency inlining

- [x] 2.1 Add heuristic in `resolveInstrumentOptions` (or plugin `config()`) that checks whether any resolved exclude pattern contains the substring `node_modules`
- [x] 2.2 When no exclude pattern mentions `node_modules`, return `server: { deps: { inline: true } }` from the instrument plugin's `config()` hook
- [x] 2.3 Write tests: `config()` returns `server.deps.inline: true` when `exclude: []`
- [x] 2.4 Write tests: `config()` does not set `server.deps` with default exclude
- [x] 2.5 Write tests: `config()` does not set `server.deps` when exclude contains a narrower node_modules pattern (e.g., `["**/node_modules/lodash/**"]`)

## 3. Update specs and docs

- [x] 3.1 Sync the delta spec to `openspec/specs/vitest-plugin/spec.md`
- [x] 3.2 Add a section to the detectors/instrumentation docs explaining how to instrument node_modules, including performance caveats (build time, coverage map saturation, `coverageMapSize`)
