## Why

Vitiate's peer dependency declares `vitest: ">=3.1.0"` but two features break under vitest 4.x: CLI resolution (vitest removed its `"./*"` wildcard export) and `vitiate init` test discovery (inline `include` is ignored when the consumer defines `test.projects`). Vitest 4.x has been stable since early 2025 and is what most users run. We should also upgrade our own dev dependency to 4.x to catch these issues in CI.

## What Changes

- Fix `resolveVitestCli()` in `config.ts` to resolve the vitest CLI entry point without relying on the `vitest/vitest.mjs` subpath export (removed in vitest 4.x)
- Fix `vitiate init` test discovery to correctly filter to fuzz tests when the consuming project uses `test.projects` in its vitest config
- Upgrade vitiate's own dev dependency from `vitest ^3.1.0` to `vitest ^4.1.0`
- Update examples to use vitest 4.x

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `test-discovery`: The `init` subcommand's test discovery must work correctly when the consuming project defines `test.projects` in its vitest config, discovering only fuzz tests rather than all tests across all projects
- `test-fuzz-api`: The `resolveVitestCli()` function must resolve the vitest CLI entry point in a way that works with both vitest 3.x and 4.x export maps. Also corrects the `--test-name-pattern` documentation to reflect that the pattern contains only the suite/test hierarchy, not the file path

## Impact

- **`vitiate-core/src/config.ts`**: `resolveVitestCli()` implementation change
- **`vitiate-core/src/cli.ts`**: `runInitSubcommand()` test discovery logic
- **`vitiate-core/src/fuzz.ts`**: Uses `resolveVitestCli()` in parent mode (inherits fix)
- **`vitiate-core/package.json`**: Dev dependency bump `vitest ^3.1.0` to `^4.1.0`
- **`examples/*/package.json`**: Vitest version bump
- **`openspec/specs/test-fuzz-api/spec.md`**: Spec references `require.resolve('vitest/vitest.mjs')` explicitly and needs updating
- **Test suite**: Existing `resolveVitestCli` test validates the resolution path; needs to pass under vitest 4.x
