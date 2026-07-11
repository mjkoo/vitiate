---
title: CLI Flags
description: Complete reference for all vitiate CLI flags and arguments.
---

## Usage

```
npx vitiate <subcommand> [options]
```

### Subcommands

| Subcommand | Description |
|------------|-------------|
| `fuzz` | Run fuzz tests via vitest |
| `regression` | Run regression tests against saved corpus via vitest |
| `reproduce <file> [flags]` | Replay a single input file once through a fuzz target |
| `optimize` | Minimize cached corpus via set cover |
| `libfuzzer <test-file> [corpus-dirs...] [flags]` | libFuzzer-compatible mode |
| `init` | Discover fuzz tests and create seed directories |
| `paths [pattern] [flags]` | Show the test-to-directory mapping and corpus counts |

---

## fuzz

```
npx vitiate fuzz [flags] [-- vitest-args...]
```

Sets `VITIATE_FUZZ=1` and spawns `vitest run` filtered to fuzz test files (`*.fuzz.*`). Unrecognized flags are forwarded to vitest.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--fuzz-time <N>` | integer | - | Total fuzzing time limit in seconds |
| `--fuzz-execs <N>` | integer | - | Total number of fuzzing iterations |
| `--max-crashes <N>` | integer | - | Maximum crashes to collect |
| `--detectors <spec>` | string | tier 1 | Comma-separated list of bug detectors to enable (see [Detectors syntax](#detectors-syntax)) |

---

## regression

```
npx vitiate regression [flags] [-- vitest-args...]
```

Spawns `vitest run` filtered to fuzz test files (`*.fuzz.*`) with no special environment variables. Runs saved corpus and crash inputs as regression tests. Unrecognized flags are forwarded to vitest.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--detectors <spec>` | string | tier 1 | Comma-separated list of bug detectors to enable (see [Detectors syntax](#detectors-syntax)) |

---

## reproduce

```
npx vitiate reproduce <file> [flags]
```

Replays a single input file **once** through a fuzz target: `0` on a clean run, and `77` when the input crashes, trips a detector, or times out (the failure's stack trace is printed), matching libFuzzer's single-input reproduce contract. Unlike `regression`, which replays the entire saved corpus, `reproduce` runs exactly one input, making it the tool for reproducing a specific crash artifact.

If the project defines more than one fuzz test, disambiguate with `-test`; otherwise `reproduce` lists the candidates and exits non-zero.

### Positional arguments

| Argument | Description |
|----------|-------------|
| `file` | Path to the input byte-file to replay (required) |

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-test <name>` | string | - | Run only the named fuzz test (required when the project has multiple fuzz tests) |
| `-timeout <N>` | integer | - | Per-execution timeout in seconds (0 = disabled) |

Example: reproduce a crash artifact written by a fuzzing run.

```
npx vitiate reproduce .vitiate/testdata/<hashdir>/crashes/crash-<hash> -test parse-url
```

---

## optimize

```
npx vitiate optimize [flags] [-- vitest-args...]
```

Sets `VITIATE_OPTIMIZE=1` and spawns `vitest run` filtered to fuzz test files (`*.fuzz.*`). Minimizes the cached corpus via set cover. Unrecognized flags are forwarded to vitest.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--detectors <spec>` | string | tier 1 | Comma-separated list of bug detectors to enable (see [Detectors syntax](#detectors-syntax)) |
| `--timeout <seconds>` | integer | per-test `timeoutMs` | Per-entry replay timeout in seconds; a slower entry is skipped with a warning. Overrides the per-test `timeoutMs`. `0` disables the watchdog. |

---

## libfuzzer

```
npx vitiate libfuzzer <test-file> [corpus-dirs...] [flags]
```

Runs in libFuzzer-compatible mode. Instruments JS/TS source with edge coverage counters via SWC and drives mutation-based fuzzing via LibAFL. Accepts libFuzzer-compatible flags. This is the mode intended for fuzzing platform integration.

### Positional arguments

| Argument | Description |
|----------|-------------|
| `test-file` | Path to the fuzz test file (required) |
| `corpus-dirs` | Additional corpus directories to load (optional, multiple allowed) |

### Input flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-max_len <N>` | integer | `4096` | Maximum input length in bytes |
| `-seed <N>` | integer | random | RNG seed for reproducible fuzzing |
| `-dict <path>` | string | - | Path to dictionary file (AFL/libFuzzer format) |

### Execution flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-timeout <N>` | integer | `0` | Per-execution timeout in seconds (0 = disabled) |
| `-runs <N>` | integer | unset | Total fuzzing iterations. A positive value caps main-loop iterations. An explicit `-runs=0` replays the loaded corpus once (no mutation) and exits, matching libFuzzer. Omitting the flag fuzzes without an iteration limit. |
| `-max_total_time <N>` | integer | `0` | Total fuzzing time limit in seconds (0 = unlimited) |
| `-test <name>` | string | - | Run only the named fuzz test |

### Output flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-artifact_prefix <path>` | string | `./` | Path prefix for crash artifact output. When using `vitiate fuzz`, defaults to `.vitiate/testdata/<hashdir>/crashes/`. |

### Crash minimization flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-minimize_budget <N>` | integer | `10000` | Maximum re-executions during crash minimization |
| `-minimize_time_limit <N>` | integer | `5` | Time limit for minimization in seconds |

### Detector flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-detectors <spec>` | string | tier 1 | Comma-separated list of bug detectors to enable (see [Detectors syntax](#detectors-syntax)) |

### Corpus management flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-merge <0\|1>` | integer | `0` | Corpus minimization mode. Reads all inputs from corpus directories, evaluates coverage, writes minimal set to the first directory. |

### Exit-code flags

Vitiate follows libFuzzer's exit-code conventions out of the box; these flags override the defaults (see [Exit codes](#exit-codes)):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-error_exitcode <N>` | integer | `77` | Process exit code when a crash is found. |
| `-timeout_exitcode <N>` | integer | `70` | Process exit code when a timeout is found. |

### Compatibility flags

These flags are parsed for libFuzzer compatibility but ignored, so invocations from a fuzzing platform do not abort on an unrecognized flag:

| Flag | Behavior |
|------|----------|
| `-fork <N>` | Parsed, ignored (always 1 - Vitiate always uses a single supervised worker) |
| `-jobs <N>` | Parsed, ignored (always 1 - Vitiate runs a single job at a time) |
| `-rss_limit_mb <N>` | Parsed, ignored (Vitiate does not enforce an in-process RSS limit) |
| `-print_final_stats <0\|1>` | Parsed, ignored (Vitiate always prints a run summary) |
| `-close_fd_mask <N>` | Parsed, ignored (Vitiate does not suppress target stdout/stderr; a non-0 value warns) |
| `-reload <N>` | Parsed, ignored (single-worker mode has no external corpus to reload) |

---

## init

```
npx vitiate init
```

Discovers fuzz test files (`*.fuzz.ts`, `*.fuzz.js`, etc.), creates seed directories under `.vitiate/testdata/`, and ensures `.vitiate/corpus/` is in `.gitignore`. No flags.

---

## paths

```
npx vitiate paths [pattern] [flags]
```

Read-only inspector that maps each discovered fuzz test to its `.vitiate/testdata/` and `.vitiate/corpus/` directory, with per-bucket entry counts. Creates nothing. Also detects and (opt-in) prunes orphaned directories left behind by renamed or deleted tests.

### Positional arguments

| Argument | Description |
|----------|-------------|
| `pattern` | Optional. Case-insensitive substring; keeps tests whose file path, test name, or hash directory contains it. |

### Flags

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON (includes an `orphans` array) instead of a table. Always uses absolute paths. |
| `--absolute` | Print absolute directory paths instead of project-root-relative ones (affects the table and `--orphans` list). |
| `--dir` | Print only the matched test's testdata directory (absolute). Requires the pattern to match exactly one test; errors otherwise. |
| `--orphans` | Also list on-disk `testdata/`+`corpus/` directories that match no discovered test. |
| `--prune` | Delete orphaned `corpus/` directories. Prompts for confirmation first. |
| `--all` | With `--prune`, also delete orphaned `testdata/` directories (which may hold committed crashes/seeds). |
| `--force` / `-f` | With `--prune`, skip the confirmation prompt. |

`--dir`, `--json`, and `--prune` are mutually-exclusive modes; combining them is an error. `--prune` refuses to delete when stdin is not a TTY unless `--force` is given. `--orphans` and `--prune` refuse entirely when the current test set cannot be determined - Vitest not installed, or no fuzz tests discovered at all (for example, run from the wrong directory) - since every directory would otherwise appear orphaned. `--all` and `--force` are only valid together with `--prune`.

---

## Exit codes

The `libfuzzer` subcommand (and the `reproduce` subcommand) run your target under a supervisor process and follow libFuzzer's exit-code conventions, so a fuzzing platform can react appropriately:

| Code | Meaning |
|------|---------|
| `0` | Campaign completed with no finding (or a `regression`/`-merge` run succeeded). |
| `77` | A crash was found. A `crash-*` artifact was written under the artifact prefix. Override with `-error_exitcode`. |
| `70` | A timeout was found. A `timeout-*` artifact was written. Override with `-timeout_exitcode`. |
| `78` | vitiate's own fuzzing engine panicked - a bug in vitiate, **not** a crash in your target. No crash artifact is written. Please report it. |
| `137` | The worker was killed by `SIGKILL` (128 + 9) - typically the OS OOM-killer, a container/cgroup memory limit, a Kubernetes eviction, or a CI step timeout. Treated as an **infrastructure failure**, not a crash. Any in-flight input is preserved under `ooms/` (or `<prefix>oom-*`) for investigation; vitiate does not respawn. |

`77`/`70` match libFuzzer's `error_exitcode`/`timeout_exitcode` defaults. The vitest-driven subcommands (`fuzz`, `regression`) instead exit with vitest's native `0`/`1`, since a failing multi-test run cannot be attributed to a single confirmed crash.

If the worker crashes repeatedly **at startup**, before it ever runs a fuzz input (for example a broken instrumentation step or a module-load error), vitiate stops early - rather than looping up to the respawn limit - and exits with the worker's non-zero exit code. The accompanying stderr message identifies it as a startup/setup failure rather than a target crash.

**Reserved codes.** Internally the worker signals the supervisor with `77` (hard watchdog timeout) and `78` (engine panic), and `134` (`SIGABRT`) / `137` (`SIGKILL`/OOM) are interpreted as above. These are separate from the final process exit code (the supervisor translates them). Avoid having your fuzz target deliberately call `process.exit()` with these values, or the supervisor will interpret the exit specially.

---

## Detectors syntax

The `--detectors` (vitest subcommands) and `-detectors` (libfuzzer subcommand) flags share the same syntax. When specified, all default detectors are disabled and only the listed detectors are active.

```
--detectors prototypePollution,ssrf
--detectors pathTraversal.deniedPaths=/etc/passwd:/etc/shadow
```

- `name` - enable the detector with default options
- `name.key=value` - enable the detector with the given option

The `pathTraversal` detector accepts `allowedPaths` and `deniedPaths` options. Use the platform path separator (`:` on POSIX, `;` on Windows) to specify multiple paths in a single value.

Pass an empty string to disable all detectors.
