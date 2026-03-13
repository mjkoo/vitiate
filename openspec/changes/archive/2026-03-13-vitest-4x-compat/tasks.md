## 1. Fix resolveVitestCli() for vitest 4.x

- [x] 1.1 Update `resolveVitestCli()` in `vitiate-core/src/config.ts` to resolve `vitest/package.json`, read `bin.vitest`, and construct the absolute CLI path
- [x] 1.2 Update the existing test in `vitiate-core/src/fuzz-api.test.ts` to validate the new resolution logic (path exists, is executable)

## 2. Fix vitiate init test discovery with multi-project configs

- [x] 2.1 Add `.fuzz.ts` file extension filter in `runInitSubcommand()` in `vitiate-core/src/cli.ts` after `getTestModules()` to skip non-fuzz test modules
- [x] 2.2 Add test for init filtering: mock `getTestModules()` returning modules with both `.fuzz.ts` and `.test.ts` file paths, assert only `.fuzz.ts` modules produce seed directories

## 3. Bump vitest to 4.x

- [x] 3.1 Update `vitiate-core/package.json` devDependency from `"vitest": "^3.1.0"` to `"vitest": "^4.1.0"`
- [x] 3.2 Update `examples/*/package.json` vitest dependencies to `"^4.1.0"`
- [x] 3.3 Update `vitiate-fuzzed-data-provider/package.json` vitest devDependency to `"^4.1.0"`
- [x] 3.4 Run `pnpm install` and resolve any dependency conflicts
- [x] 3.5 Run full test suite and fix any vitest 4.x breakage

## 4. Update specs and docs

- [x] 4.1 Update `openspec/specs/test-fuzz-api/spec.md` to replace the `require.resolve('vitest/vitest.mjs')` language with the bin-field resolution strategy
