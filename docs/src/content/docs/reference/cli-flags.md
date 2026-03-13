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
| `optimize` | Minimize cached corpus via set cover |
| `libfuzzer <test-file> [corpus-dirs...] [flags]` | libFuzzer-compatible mode |
| `init` | Discover fuzz tests and create seed directories |

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

## optimize

```
npx vitiate optimize [flags] [-- vitest-args...]
```

Sets `VITIATE_OPTIMIZE=1` and spawns `vitest run` filtered to fuzz test files (`*.fuzz.*`). Minimizes the cached corpus via set cover. Unrecognized flags are forwarded to vitest.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--detectors <spec>` | string | tier 1 | Comma-separated list of bug detectors to enable (see [Detectors syntax](#detectors-syntax)) |

---

## libfuzzer

```
npx vitiate libfuzzer <test-file> [corpus-dirs...] [flags]
```

Runs in libFuzzer-compatible mode. Instruments JS/TS source with edge coverage counters via SWC and drives mutation-based fuzzing via LibAFL. Accepts libFuzzer-compatible flags. This is the mode used by OSS-Fuzz.

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
| `-runs <N>` | integer | `0` | Total fuzzing iterations (0 = unlimited) |
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

### Compatibility flags

These flags are parsed for libFuzzer/OSS-Fuzz compatibility but ignored:

| Flag | Behavior |
|------|----------|
| `-fork <N>` | Parsed, ignored (always 1 - Vitiate always uses a single supervised worker) |
| `-jobs <N>` | Parsed, ignored (always 1 - Vitiate runs a single job at a time) |

---

## init

```
npx vitiate init
```

Discovers fuzz test files (`*.fuzz.ts`, `*.fuzz.js`, etc.), creates seed directories under `.vitiate/testdata/`, and ensures `.vitiate/corpus/` is in `.gitignore`. No flags.

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
