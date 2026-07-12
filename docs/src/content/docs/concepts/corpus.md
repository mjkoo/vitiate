---
title: Corpus and Regression Testing
description: How Vitiate manages test inputs across fuzzing and regression modes.
---

The corpus is the set of inputs that the fuzzer has found useful. Understanding how it works will help you get the most out of Vitiate.

## Corpus Locations

Vitiate loads inputs from two locations. Both use a **hash directory** name: a base32 encoded hash followed by the test name (e.g., `vxr4kpqyb12fza1gv81bjj8k3i64mlqn-parse_url` for a test named `"parse-url"`).

### Seed Corpus

```
.vitiate/testdata/<hashdir>/seeds/
```

For example, a test named `"parse does not crash"` would have its seed corpus at `.vitiate/testdata/vxr4kpqyb12fza1gv81bjj8k3i64mlqn-parse_does_not_crash/seeds/`.

Files you create manually to give the fuzzer a starting point. Good seeds exercise different code paths in your target. Crash, timeout, and out-of-memory artifacts are stored in sibling directories (`crashes/`, `timeouts/`, and `ooms/`).

The easiest way to discover the directory path is to run `npx vitiate init`, which creates seed directories for all discovered fuzz tests. You can also list existing directories with `ls .vitiate/testdata/` (see the [Tutorial](/getting-started/tutorial/#step-7-add-seed-inputs-optional) for a walkthrough).

### Cached Corpus

```
.vitiate/corpus/<hashdir>/
```

For example, a test named `"parse does not crash"` would have its cached corpus at:

```
.vitiate/corpus/vxr4kpqyb12fza1gv81bjj8k3i64mlqn-parse_does_not_crash/
```

Generated automatically during fuzzing. Each file is named by its SHA-256 hash for deduplication. This directory grows as the fuzzer discovers new coverage and can be deleted safely - the fuzzer will rebuild it. Add `.vitiate/corpus/` to your `.gitignore`.

## Two Modes

Vitiate's `fuzz()` function behaves differently depending on the environment. The same test file serves both modes with no code changes.

### Fuzzing Mode

Activated by `npx vitiate fuzz` or by setting the `VITIATE_FUZZ` environment variable:

```bash
npx vitiate fuzz test/parser.fuzz.ts
```

In fuzzing mode, each `fuzz()` call becomes a supervisor that spawns a child Vitest process and enters the fuzz loop. The fuzzer:

1. Loads all seed and cached corpus entries
2. Evaluates each seed to establish initial coverage
3. Mutates corpus entries to generate new inputs
4. Saves interesting new inputs to the cached corpus
5. Saves crash artifacts to the seed corpus directory

If a crash is found, the test fails with the crash details and artifact path.

### Regression Mode

Activated by running your tests normally (the default when `VITIATE_FUZZ` is not set):

```bash
npx vitest run
```

Each `fuzz()` call:

1. Loads all seed and cached corpus entries
2. Runs the target once per entry, in order
3. Fails the test if any entry throws an unexpected error

This means every crash artifact and every interesting input the fuzzer has ever found is replayed as a test case. Crash artifacts are permanent regression guards - if someone reintroduces the bug, the test fails.

When the test has a `timeoutMs` option, regression entries (including saved `timeout-*` artifacts) replay under the same native watchdog used in fuzzing mode: a hung entry - even a synchronous infinite loop that blocks the event loop - fails with a message naming the offending corpus file instead of hanging the worker. Vitest's own per-test timeout is disabled for that test since the watchdog bounds each entry individually. Two caveats:

- An async target that hangs while idle (awaiting a promise that never settles) cannot be interrupted in-process; it is bounded only by the watchdog's fallback, which exits the whole worker.
- Without `timeoutMs` configured, entries replay unprotected and Vitest's default test timeout applies to the whole replay loop.

## Crash Artifacts

When the fuzzer finds a crashing input, it:

1. Minimizes the input (removes bytes while preserving the crash)
2. Writes the minimized input to `.vitiate/testdata/<hashdir>/crashes/crash-<sha256>`
3. Continues fuzzing for more crashes (configurable via `stopOnCrash`)

Commit crash artifacts to version control. They are small, deterministic, and serve as documentation of bugs that were found and fixed.

Timeout artifacts follow the same pattern: `.vitiate/testdata/<hashdir>/timeouts/timeout-<sha256>`.

Out-of-memory artifacts (inputs that triggered a SIGKILL/OOM) go to `.vitiate/testdata/<hashdir>/ooms/oom-<sha256>`. Unlike seeds, crashes, and timeouts, `ooms/` entries are not replayed during regression or reseeding: a SIGKILL/OOM is ambiguous (a real memory-exhaustion input versus an environmental kill) and is not a confirmed reproducer, so inspect these inputs by hand rather than gating the regression suite on them.

A crash artifact is written even when the crash did not reproduce on the fuzzer's immediate replay of the same input (the fuzz failure will say "crash not reproduced on replay"). Replay determinism is the target's responsibility - if your target depends on `Math.random()`, the clock, or accumulated state, pin those down (e.g. a seeded RNG) or the saved artifact may fail regression runs intermittently. A persistently flaky artifact should be inspected and, if the underlying bug is fixed or unreproducible, removed by hand.

## Corpus Minimization

Over time the cached corpus grows as the fuzzer discovers new coverage. Many of these entries become redundant - later inputs may cover the same edges as earlier ones. Minimization finds the smallest subset that maintains the same total coverage.

Run optimize mode to minimize the cached corpus in place:

```bash
npx vitiate optimize
```

Optimize mode works as follows for each `fuzz()` test:

1. **Replays seed corpus** entries (`.vitiate/testdata/<hashdir>/seeds/`) to establish a baseline of pre-covered edges
2. **Replays cached corpus** entries (`.vitiate/corpus/<hashdir>/`) and records the edges each one covers
3. **Runs set cover** over cached entries only, treating seed edges as already covered - cached entries that are fully redundant with seeds or other survivors are eliminated
4. **Deletes non-surviving cached entries** in place from `.vitiate/corpus/`

Seed corpus entries are never deleted - they serve as the coverage baseline. Only cached entries are subject to minimization.

When the test has a `timeoutMs` option, optimize and merge replay each entry under the vitiate watchdog, like regression mode: a hanging entry is skipped with a warning instead of hanging the run.

Minimize periodically, especially after long fuzzing sessions. A smaller corpus means faster regression test runs and faster seed evaluation at the start of the next fuzzing session.

For libFuzzer-compatible corpus minimization across arbitrary directories, see the [standalone CLI's merge mode](/guides/cli/#merge-mode).

### Checkpointing Fuzzer Progress

After a long fuzzing session, you can checkpoint the fuzzer's progress by promoting surviving cached entries to the seed corpus. This makes the coverage gains permanent - they survive even if `.vitiate/corpus/` is deleted or the project is cloned fresh.

```bash
# 1. Optimize to keep only the minimal covering set
npx vitiate optimize

# 2. Copy surviving cached entries to the seed corpus
cp .vitiate/corpus/<hashdir>/* \
   .vitiate/testdata/<hashdir>/seeds/

# 3. Commit the new seeds
git add .vitiate/testdata/
git commit -m "chore: checkpoint fuzzer corpus"
```

After checkpointing, you can safely delete `.vitiate/corpus/` and start the next fuzzing session from the enriched seed corpus.

## Tips

- **Commit seed corpus and crash artifacts.** They are small and valuable. Other developers get the fuzzer's accumulated knowledge when they clone the repository.
- **Do not commit the cached corpus.** It can be large and is regenerated automatically. Add `.vitiate/corpus/` to `.gitignore`.
- **Checkpoint after long sessions.** Run `npx vitiate optimize`, then copy surviving cached entries to the seed corpus and commit them. This preserves coverage gains permanently.
- **Integrate fuzzing into CI.** Run regression tests on every PR and long fuzzing sessions nightly on main. See [CI Fuzzing](/guides/ci-fuzzing/) for setup details.
