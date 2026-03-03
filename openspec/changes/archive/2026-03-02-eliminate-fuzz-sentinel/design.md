## Context

`VITIATE_FUZZ` currently carries two pieces of information in a single env var: a boolean "is fuzzing active?" signal and an optional regex filter pattern. The value `"1"` is a magic sentinel meaning "fuzz all tests" while any other truthy string is treated as a filter pattern. This forces `getFuzzPattern()` to special-case `"1"`, and means a test literally named `"1"` could never be used as a filter value.

The pattern was set in the `vitest-plugin-integration` change when `--fuzz=<pattern>` support was added to the plugin's `config()` hook. The sentinel propagated to `parseFuzzFlag()`, `getFuzzPattern()`, and test expectations throughout the codebase.

## Goals / Non-Goals

**Goals:**

- Eliminate the `"1"` magic sentinel by giving the filter pattern its own env var (`VITIATE_FUZZ_PATTERN`)
- `VITIATE_FUZZ` becomes a pure boolean: set to `"1"` when fuzzing is active, absent otherwise
- `parseFuzzFlag()` returns a structured type that makes the distinction explicit in code
- No behavior change for end users — `vitest --fuzz` and `vitest --fuzz=pattern` work identically

**Non-Goals:**

- Changing `isFuzzingMode()` semantics — it already does a pure boolean check and needs no changes
- Modifying the standalone CLI or supervisor spawn — they already set `VITIATE_FUZZ="1"` with no pattern

## Decisions

### 1. Separate env var for the filter pattern

**Decision:** Introduce `VITIATE_FUZZ_PATTERN` as a new env var. When `--fuzz=<pattern>` is used, the plugin sets both `VITIATE_FUZZ="1"` and `VITIATE_FUZZ_PATTERN="<pattern>"`. When bare `--fuzz` is used, only `VITIATE_FUZZ="1"` is set.

**Rationale:** Env vars are the transport layer between the plugin `config()` hook and the runtime consumers (`isFuzzingMode()`, `getFuzzPattern()`, child process spawning). Splitting concerns across two vars makes each one single-purpose and eliminates the sentinel. This matches the existing pattern where `VITIATE_FUZZ_OPTIONS` is already a separate var for structured fuzz configuration.

**Alternatives considered:**

- *Prefix encoding* (`VITIATE_FUZZ=pattern:<value>` / `VITIATE_FUZZ=all`): Adds parsing complexity, still one var with two meanings.
- *JSON in VITIATE_FUZZ* (`{"enabled":true,"pattern":"foo"}`): Overweight for a boolean + optional string, and `isFuzzingMode()` would need JSON parsing.

### 2. Structured return type for `parseFuzzFlag`

**Decision:** Change `parseFuzzFlag` from returning `string | undefined` to returning `{ pattern?: string } | undefined`. Presence of the return value means `--fuzz` was found; the optional `pattern` field carries the filter.

**Rationale:** The structured type makes it impossible to confuse "flag present with no pattern" and "flag present with value `1`". The caller in `config()` destructures cleanly: always set `VITIATE_FUZZ="1"`, and set `VITIATE_FUZZ_PATTERN` only when `pattern` is present.

### 3. `getFuzzPattern()` reads `VITIATE_FUZZ_PATTERN` directly

**Decision:** `getFuzzPattern()` reads `process.env["VITIATE_FUZZ_PATTERN"]` and returns it if non-empty, or `null` otherwise. The `"1"` special-case logic is removed entirely.

**Rationale:** With the pattern in its own var, there is no sentinel to check. The function becomes trivial.

### 4. Child process spawning sets `VITIATE_FUZZ_PATTERN` when applicable

**Decision:** The `fuzz()` parent-mode supervisor in `fuzz.ts` continues to set `VITIATE_FUZZ="1"` in the child env. It does not set `VITIATE_FUZZ_PATTERN` because the child is already filtered to a single test via `--test-name-pattern`. The parent inherits `VITIATE_FUZZ_PATTERN` from its own env (via `...process.env`), but the child's fuzz test will always match because Vitest's name filter ensures only the targeted test runs.

**Rationale:** The child process pattern was already effectively "run this one test" — the regex filter is irrelevant at that level. No change needed.

## Risks / Trade-offs

**[Risk] External tools depend on `VITIATE_FUZZ` carrying the pattern** — If any external scripts or CI configs set `VITIATE_FUZZ=mypattern` to filter tests, they would need to switch to `VITIATE_FUZZ=1 VITIATE_FUZZ_PATTERN=mypattern`. Mitigation: this is an internal API, not documented for external use. The `--fuzz` CLI flag and `vitiatePlugin()` options are the public interfaces.
