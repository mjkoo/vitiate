## Context

The CLI has five subcommands (`init`, `fuzz`, `regression`, `optimize`, `libfuzzer`). Only `libfuzzer` uses `@optique` for flag parsing; the other three vitest-wrapper subcommands (`fuzz`, `regression`, `optimize`) do raw `process.argv.slice(3)` and forward everything to vitest. Subcommand dispatch is a manual `switch` on `process.argv[2]`. Key fuzzing parameters are only configurable via environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`).

## Goals / Non-Goals

**Goals:**

- Define optique parsers for `fuzz`, `regression`, and `optimize` subcommands with `--help` support
- Add `--fuzz-time`, `--fuzz-execs`, `--max-crashes` flags to the `fuzz` subcommand
- Add `--detectors` flag to the `fuzz` subcommand (same semantics as libfuzzer's `-detectors`)
- Forward unrecognized flags to vitest transparently
- Rewrite CLI docs to present `vitiate fuzz` as the primary interface
- CLI flags take precedence over env vars; env vars remain supported

**Non-Goals:**

- Changing the `libfuzzer` subcommand (it stays as-is)
- Changing the `init` subcommand
- Adding vitiate-specific flags to `regression` or `optimize` beyond `--detectors`, `--help`, and vitest forwarding
- Removing env var support

## Decisions

### Decision 1: Use `passThrough()` for vitest flag forwarding

optique provides `passThrough()` from `@optique/core/primitives` which collects unrecognized arguments into an array. This is purpose-built for wrapper CLIs.

Use `passThrough({ format: "nextToken" })` which captures unknown `--flag value` pairs as separate tokens. This correctly handles vitest's space-separated flag convention (`--reporter verbose`, `--bail 1`).

The standard `--` separator is also supported automatically by optique (sets `optionsTerminated` in parser context). Users can always write `vitiate fuzz --fuzz-time 60 -- --reporter verbose` for explicit separation if needed.

**Why `nextToken` over alternatives:**
- `"equalsOnly"` only captures `--flag=value` format, misses vitest's `--flag value` convention
- `"greedy"` stops parsing vitiate flags after the first unknown token, breaking `vitiate fuzz --reporter verbose --fuzz-time 60` (the `--fuzz-time` would be swallowed)
- `"nextToken"` handles both `--flag value` and standalone `--flag` tokens correctly

**Alternative considered:** Manual `process.argv` scanning to separate known from unknown flags. Rejected because optique already solves this and gives us `--help` generation for free.

### Decision 2: Fuzz subcommand parser structure

```typescript
const fuzzParser = object({
  fuzzTime: optional(option("--fuzz-time", integer({ min: 1 }), { ... })),
  fuzzExecs: optional(option("--fuzz-execs", integer({ min: 1 }), { ... })),
  maxCrashes: optional(option("--max-crashes", integer({ min: 1 }), { ... })),
  detectors: optional(option("--detectors", string(), { ... })),
  vitestArgs: passThrough({ format: "nextToken" }),
});
```

The parsed `fuzzTime`, `fuzzExecs`, and `maxCrashes` are set as `VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, and `VITIATE_MAX_CRASHES` env vars on the spawned vitest process. The `detectors` value is serialized into `VITIATE_FUZZ_OPTIONS` JSON. The `vitestArgs` array is appended to the vitest command line.

CLI flag takes precedence over env var: if both `--fuzz-time 60` and `VITIATE_FUZZ_TIME=120` are set, the child process receives `VITIATE_FUZZ_TIME=60`.

### Decision 3: Regression and optimize parsers include detectors

All three vitest-wrapper subcommands (`fuzz`, `regression`, `optimize`) accept `--detectors`. Detectors are relevant during regression runs (verifying detector-found bugs still trigger) and optimize runs (coverage evaluation should account for detector-exercised paths). The remaining flags (`--fuzz-time`, `--fuzz-execs`, `--max-crashes`) are fuzz-only.

```typescript
const regressionParser = object({
  detectors: optional(option("--detectors", string(), { ... })),
  vitestArgs: passThrough({ format: "nextToken" }),
});
```

This replaces the current `process.argv.slice(3)` with structured forwarding that respects `--help`.

### Decision 4: Detectors flag uses double-dash convention

The `fuzz` subcommand uses `--detectors` (double-dash, kebab-case) while `libfuzzer` uses `-detectors` (single-dash, underscore). The parsing logic (`parseDetectorsFlag()`) is shared - only the flag name differs. This maintains each subcommand's convention: double-dash for vitiate-native commands, single-dash for libFuzzer compatibility.

### Decision 5: spawnVitestWrapper refactor

`spawnVitestWrapper()` currently takes `env: Record<string, string>` and reads `process.argv.slice(3)` directly. Refactor to accept both env vars and forwarded args:

```typescript
function spawnVitestWrapper(
  env: Record<string, string>,
  forwardedArgs: readonly string[],
): void
```

The `fuzz` subcommand calls it with parsed env vars and the passthrough args. `regression` and `optimize` call it with their respective env vars and passthrough args.

### Decision 6: Subcommand dispatch via optique `command()` + `or()`

Replace the manual `switch (process.argv[2])` dispatch with optique's `command()` primitive and `or()` combinator:

```typescript
const cli = or(
  command("fuzz", fuzzParser, { brief: "Run fuzz tests" }),
  command("regression", regressionParser, { brief: "Run regression tests" }),
  command("optimize", optimizeParser, { brief: "Minimize corpus" }),
  command("libfuzzer", libfuzzerParser, { brief: "libFuzzer-compatible mode" }),
  command("init", initParser, { brief: "Discover tests, create seed dirs" }),
);
```

This gives us:
- Auto-generated top-level `--help` with subcommand listing
- Typo suggestions ("Did you mean...?") for unknown subcommands
- Consistent error formatting across the entire CLI
- Eliminates `printUsage()`, the manual `SUBCOMMANDS` record, and the `switch` block

The top-level parser is run via `runSync(cli, { programName: "vitiate" })`. Each `command()` delegates to its subcommand parser which handles its own flags.

`init` is async (uses `createVitest`), but the `command()` result can be dispatched after parsing - the parser itself just matches the subcommand name and parses flags, the async work happens in the handler after parsing completes.

### Decision 7: Documentation structure

The CLI guide (`docs/src/content/docs/guides/cli.md`) is restructured:

1. **Introduction** - `vitiate` as the primary CLI, brief subcommand table
2. **Fuzzing** (`vitiate fuzz`) - Primary workflow, flags, examples. This is the section most users will read.
3. **Regression testing** (`vitiate regression`) - Running saved corpus/crash inputs
4. **Corpus optimization** (`vitiate optimize`) - Minimizing corpus
5. **Project setup** (`vitiate init`) - Initial setup
6. **libFuzzer compatibility** (`vitiate libfuzzer`) - Motivation (OSS-Fuzz, platform integration), flag reference, corpus directories, merge mode, supervisor architecture
7. **Output format** - Reading fuzzer output (shared across modes)
8. **Environment variables** - Complete reference, noting which have CLI flag equivalents

The reference page (`cli-flags.md`) is reorganized with sections per subcommand rather than one flat list of libfuzzer flags.

## Risks / Trade-offs

- **`passThrough` format edge cases** - `"nextToken"` may incorrectly capture a positional argument as a flag's value if the user writes `--unknown-bool-flag some-positional`. Mitigation: vitest flags that the wrapper subcommands forward are almost exclusively `--flag value` pairs, and the `--` escape hatch handles edge cases. In practice, the vitest-wrapper subcommands don't accept positional arguments so this is unlikely to cause issues.

- **Double-dash detectors convention divergence** - `--detectors` (fuzz) vs `-detectors` (libfuzzer) could confuse users who switch between modes. Mitigation: the docs clearly show flag syntax per subcommand, and the `--help` output for each subcommand shows the correct form.

## Open Questions

None at this time.
