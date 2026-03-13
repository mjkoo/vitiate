## MODIFIED Requirements

### Requirement: Child process spawning

The `fuzz()` callback in parent mode SHALL spawn the child Vitest process using the following command:

```
node <vitest-cli-path> run <testFilePath> --test-name-pattern "^<escapedFullTaskName>$"
```

where the full task name follows Vitest's `getTaskFullName` format: `"<suite1> <suite2> ... <testName>"` (space-separated suite hierarchy and test name). The file path is NOT included in the pattern - it is passed as a positional argument to `vitest run`, which restricts execution to that file. The pattern only needs to match the test hierarchy within the file.

- **`process.execPath`** SHALL be used for the Node binary (same version, same flags).
- **Vitest CLI path** SHALL be resolved by reading the `bin` field from `vitest/package.json` and constructing an absolute path relative to the package directory. Specifically: resolve `vitest/package.json` via `createRequire(import.meta.url).resolve('vitest/package.json')`, read the `bin.vitest` (or top-level `bin` if it is a string) field, and join it with the package directory. This avoids reliance on vitest's subpath exports beyond `./package.json`, which is explicitly exported in both vitest 3.x and 4.x.
- **`run`** mode ensures Vitest executes once and exits (no watch mode).
- **`--test-name-pattern`** with anchored regex (`^...$`) filters at the Vitest runner level so only the targeted test runs. All other tests (fuzz and non-fuzz) are skipped - their callbacks never execute.
- **Test file path** SHALL be obtained from `getCurrentTest()?.file?.filepath`.
- **Regex escaping** SHALL use a well-supported library (e.g., `escape-string-regexp`) - custom regex escaping logic SHALL NOT be implemented.

The child's environment SHALL inherit the parent's env vars plus:
- `VITIATE_SUPERVISOR=1` - signals the child's `fuzz()` to enter the fuzz loop directly.
- `VITIATE_FUZZ=1` - activates fuzzing mode.

The child picks up the same `vitest.config.ts` from the working directory, loads the same vitiate plugin, applies the same SWC transforms.

#### Scenario: Vitest CLI resolution across vitest versions

- **WHEN** `resolveVitestCli()` is called in a project using vitest 3.x (with wildcard `"./*"` export)
- **THEN** the function SHALL return an absolute path ending with the vitest CLI entry point
- **AND** the file at the returned path SHALL exist on disk

#### Scenario: Vitest CLI resolution with vitest 4.x

- **WHEN** `resolveVitestCli()` is called in a project using vitest 4.x (without wildcard exports)
- **THEN** the function SHALL return an absolute path ending with the vitest CLI entry point
- **AND** the file at the returned path SHALL exist on disk
- **AND** the resolution SHALL NOT use `require.resolve("vitest/vitest.mjs")` or any subpath export beyond `./package.json`

#### Scenario: Child process command

- **WHEN** `fuzz("parse (JSON)", target)` becomes a supervisor
- **THEN** the child is spawned with `process.execPath` as the Node binary
- **AND** the Vitest CLI path is resolved from the current module's resolution context
- **AND** `--test-name-pattern` receives the escaped full task name (suite hierarchy + test name, without file path) with `^...$` anchors
- **AND** special regex characters in the test name (parentheses, brackets, etc.) are properly escaped using a library function

#### Scenario: Child environment

- **WHEN** the child Vitest process is spawned
- **THEN** `VITIATE_SUPERVISOR=1` is set in the child's environment
- **AND** `VITIATE_FUZZ=1` is set in the child's environment
- **AND** all other parent env vars (including `VITIATE_FUZZ_OPTIONS`) are inherited
