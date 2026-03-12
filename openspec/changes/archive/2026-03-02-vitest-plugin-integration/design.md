## Context

The vitiate Vite plugin (`plugin.ts`) currently implements two hooks: `config()` for setupFiles injection and environment variable setup, and `transform()` for SWC instrumentation. Fuzzing mode is activated exclusively via the `VITIATE_FUZZ=1` environment variable. The vitest-plugin spec incorrectly requires a `configureVitest` hook for setupFiles injection - this hook fires after Vitest's project config is frozen and cannot modify `setupFiles`.

The standalone CLI (`cli.ts`) already wraps `startVitest()` and sets `VITIATE_FUZZ=1` internally, so CLI users don't encounter the env var directly. But users running `vitest` with the plugin must set the env var manually: `VITIATE_FUZZ=1 vitest`.

## Goals / Non-Goals

**Goals:**

- Let users write `vitest --fuzz` (or `vitest --fuzz=pattern`) instead of `VITIATE_FUZZ=1 vitest`
- Correct the vitest-plugin spec to match Vitest's actual plugin API lifecycle
- Correct the vitest-plugin spec's `configureVitest` requirement to reflect the correct `config()` mechanism

**Non-Goals:**

- Vitest reporter pipeline integration - the fuzz loop runs in a worker process/thread that cannot access the main-process Vitest instance. Direct stderr writes are the correct approach.
- Custom Vitest reporter implementation for fuzz output
- Any changes to the standalone CLI (`cli.ts`) - it already handles activation correctly

## Decisions

### 1. Parse `process.argv` in `config()` for `--fuzz` detection

**Decision:** The plugin's `config()` hook scans `process.argv` for `--fuzz` or `--fuzz=<pattern>` and sets `process.env.VITIATE_FUZZ` if not already set.

**Rationale:** Vitest has no plugin extension point for custom CLI flags (the CLI is built with `cac` with a fixed option set). However, `process.argv` is available in the `config()` hook, and Vitest's `cac` CLI does not reject unknown flags (they're silently ignored). This gives us `--fuzz` support without any Vitest framework changes.

**Alternatives considered:**

- *Vitest `--define` flag*: Users could write `vitest --define.__VITIATE_FUZZ__=true`, but this is worse UX than the env var.
- *Custom Vitest config option*: Users could set `process.env.VITIATE_FUZZ=1` in their `vite.config.ts`, but this requires code changes rather than a CLI flag.
- *`configureVitest` hook for argv parsing*: This hook fires after setup files have already been resolved and potentially loaded. Setting `VITIATE_FUZZ` there would be too late - `setup.ts` reads `isFuzzingMode()` at import time to decide whether to connect to the napi coverage map.

### 2. Argv parsing approach: simple sequential scan

**Decision:** Use a simple `process.argv` scan (find first arg matching `--fuzz` or `--fuzz=*`) rather than a full CLI parser.

**Rationale:** We only need one flag. A full parser (e.g., `minimist`, `cac`) would be a new dependency for a single boolean/string argument. The `--fuzz` flag has no interactions with other flags; it just sets an env var.

The scan handles three forms:
- `--fuzz` → sets `VITIATE_FUZZ=1`
- `--fuzz=pattern` → sets `VITIATE_FUZZ=pattern`
- `--fuzz pattern` → not supported (ambiguous with Vitest file args)

### 3. Remove `configureVitest` requirement from spec

**Decision:** Replace the `configureVitest` setupFiles requirement with a `config()` hook requirement (which matches the working implementation).

**Rationale:** Vitest's `configureVitest` hook fires at project initialization time, after the `config()` and `configResolved()` hooks have already merged plugin configs and resolved `setupFiles`. The `config()` hook is the correct Vite-idiomatic mechanism for injecting configuration - it runs during config resolution and its return value is deep-merged into the final config.

The original spec was written based on the PRD's description of `configureVitest`, but Vitest's actual lifecycle makes this hook unsuitable for config injection.

### 4. Dismiss reporter interleaving as a non-issue

**Decision:** Keep direct stderr writes in the progress reporter. Do not attempt Vitest reporter integration.

**Rationale:** The fuzz loop executes inside a Vitest worker (thread or child process). The `configureVitest` hook runs in the main Vitest process. There is no mechanism to pass the `vitest` instance or its logger across the process/thread boundary. Even if there were, Vitest does not produce output during test execution - it collects results and reports them after tests complete. Interleaving is not a practical concern.

### 5. Env var precedence: explicit env vars always win

**Decision:** The `--fuzz` flag only sets `VITIATE_FUZZ` if the env var is not already set. This is consistent with how `config()` handles all other env vars (`VITIATE_PROJECT_ROOT`, `VITIATE_CACHE_DIR`, `VITIATE_FUZZ_OPTIONS`).

**Rationale:** Explicit env vars represent deliberate user intent and should not be silently overridden by a CLI flag. The standalone CLI sets `VITIATE_FUZZ=1` before calling `startVitest()`, so this precedence rule also prevents double-setting.

## Risks / Trade-offs

**[Risk] Vitest rejects `--fuzz` as an unknown flag in a future version** → Vitest currently uses `cac` which silently ignores unknown options on the default command. If Vitest adds strict argument validation in a future version, `vitest --fuzz` would error. Mitigation: the env var approach remains the primary activation mechanism; `--fuzz` is documented as a convenience alias. If Vitest adds a plugin CLI extension API in the future, we can adopt it.

**[Risk] `process.argv` parsing is fragile across invocation methods** → When Vitest is invoked programmatically (e.g., via `startVitest()` in the standalone CLI), `process.argv` may not contain `--fuzz`. Mitigation: the argv scan only sets `VITIATE_FUZZ` if not already set, so programmatic callers that set the env var directly are unaffected. The argv scan is purely for the `vitest` CLI invocation path.
