---
title: Environment Variables
description: All environment variables recognized by Vitiate.
---

## Mode Selection

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ` | `1` | Enables [fuzzing mode](/concepts/corpus/#fuzzing-mode). Each `fuzz()` call becomes a supervisor and enters the mutation-driven fuzz loop. Also set internally by the `npx vitiate` CLI. |
| `VITIATE_OPTIMIZE` | `1` | Enables [corpus minimization mode](/concepts/corpus/#corpus-minimization). Replays all corpus entries, runs set cover, and deletes redundant cached entries. |

When neither is set, `fuzz()` runs in [regression mode](/concepts/corpus/#regression-mode) - replaying saved corpus entries as test cases.

## Configuration

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ_TIME` | integer | Total fuzzing time in seconds. Overrides `fuzzTimeMs` from code and `-max_total_time` from CLI. |
| `VITIATE_FUZZ_EXECS` | integer | Maximum fuzzing iterations. Overrides `fuzzExecs` from code and `-runs` from CLI. |
| `VITIATE_DEBUG` | `1` | Enable debug output (logs mode, coverage map size, and internal state). |
| `VITIATE_MAX_CRASHES` | integer | Maximum crashes to collect before stopping. Overrides `maxCrashes` from code. |
| `VITIATE_RESULTS_FILE` | string (path) | When set to a non-empty path, the fuzz loop writes a JSON results summary (crash count, artifact paths, exec and coverage counts, elapsed time) to this file after the campaign finishes. Unset or empty disables it. |
| `VITIATE_OPTIONS` | JSON object | A `FuzzOptions` object encoded as JSON, merged over per-test options. Invalid JSON, non-objects, and schema-invalid keys are dropped with a warning. Usually set by the CLI from parsed flags; may be set manually to pass options to worker processes. |

## Internal

These are set by Vitiate internally. Do not set them manually unless building a custom runner.

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_SUPERVISOR` | `1` | Indicates the process is a supervised child worker. Set by the supervisor. |
| `VITIATE_SHMEM` | string | Shared memory handle for coverage map. Set by the supervisor. |
| `VITIATE_SHMEM_SIZE` | integer | Byte size of the shared-memory region named by `VITIATE_SHMEM`, set as its companion when the supervisor exports the region and read when the worker attaches. Set automatically; do not set manually. |
| `VITIATE_PROJECT_ROOT` | string | Resolved project root. Exported by the plugin's `config` hook so test worker processes (where no plugin hook runs) resolve the same root as the main process. Set automatically; do not set manually. |
| `VITIATE_DATA_DIR` | string | Resolved test data directory (absolute). Exported by the plugin's `config` hook so worker processes read and write artifacts under the same directory. Set automatically; do not set manually. |
| `VITIATE_COVERAGE_MAP_SIZE` | integer | Resolved [`coverageMapSize`](/reference/plugin-options/#coveragemapsize). Exported by the plugin's `config` hook so worker processes allocate a coverage map matching the size the instrumentation was compiled against. Set automatically; do not set manually. |
| `VITIATE_CLI_IPC` | JSON object | Internal CLI-to-worker channel carrying fields such as the reproduce input file and merge control file. Invalid JSON or non-object values are ignored with a warning. Set automatically; do not set manually. |

## Precedence

### `fuzz`, `regression`, and `optimize` subcommands

Configuration is resolved in this order (highest priority first):

1. CLI flags (`--fuzz-time`, `--fuzz-execs`, `--max-crashes`)
2. Environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`)
3. Per-test `FuzzOptions` in code
4. Plugin-level `fuzz` defaults
5. Built-in defaults

### `libfuzzer` subcommand

For the libFuzzer-compatible CLI, environment variables take highest priority to match libFuzzer conventions:

1. Environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`)
2. CLI flags (`-max_total_time`, `-runs`)
3. Per-test `FuzzOptions` in code
4. Plugin-level `fuzz` defaults
5. Built-in defaults
