---
title: CLI Flags
description: Complete reference for all vitiate CLI flags and arguments.
---

## Usage

```
npx vitiate <test-file> [corpus-dirs...] [flags]
```

### Positional Arguments

| Argument | Description |
|----------|-------------|
| `test-file` | Path to the fuzz test file (required) |
| `corpus-dirs` | Additional corpus directories to load (optional, multiple allowed) |

## Flags

### Input

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-max_len <N>` | integer | `4096` | Maximum input length in bytes |
| `-seed <N>` | integer | random | RNG seed for reproducible fuzzing |
| `-dict <path>` | string | - | Path to dictionary file (AFL/libFuzzer format) |

### Execution

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-timeout <N>` | integer | `0` | Per-execution timeout in seconds (0 = disabled) |
| `-runs <N>` | integer | `0` | Total fuzzing iterations (0 = unlimited) |
| `-max_total_time <N>` | integer | `0` | Total fuzzing time limit in seconds (0 = unlimited) |
| `-test <name>` | string | - | Run only the named fuzz test |

### Output

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-artifact_prefix <path>` | string | `./` | Path prefix for crash artifact output. In Vitest-integrated mode, defaults to the seed corpus directory. |

### Crash Minimization

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-minimize_budget <N>` | integer | `10000` | Maximum re-executions during crash minimization |
| `-minimize_time_limit <N>` | integer | `5` | Time limit for minimization in seconds |

### Detectors

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-detectors <spec>` | string | tier 1 | Comma-separated list of detectors to enable |

Detector syntax:

```
-detectors prototypePollution,ssrf
-detectors pathTraversal.deniedPaths=/etc/passwd:/etc/shadow
```

When specified, all defaults are disabled and only listed detectors are active. Detector options are specified with dot notation and colon-separated values.

### Corpus Management

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-merge <0\|1>` | integer | `0` | Corpus minimization mode. Reads all inputs from corpus directories, evaluates coverage, writes minimal set to the first directory. |

### libFuzzer Compatibility

These flags are parsed for compatibility but ignored:

| Flag | Behavior |
|------|----------|
| `-fork <N>` | Parsed, ignored (always 1 - Vitiate always uses a single supervised worker) |
| `-jobs <N>` | Parsed, ignored (always 1 - Vitiate runs a single job at a time) |
