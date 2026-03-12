---
title: Quickstart
description: Get from zero to your first fuzz-discovered bug in five minutes.
---

## 1. Install

```bash
npm install --save-dev vitiate
```

This installs the Vitest plugin, the standalone CLI, and all required dependencies.
If you only need the Vitest plugin and not the CLI, you can install `@vitiate/core` instead.

## 2. Configure Vitest

Create or update your `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [vitiatePlugin()],
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["test/**/*.test.ts"] } },
      { extends: true, test: { name: "fuzz", include: ["test/**/*.fuzz.ts"] } },
    ],
  },
});
```

The `vitiatePlugin()` call registers the SWC instrumentation plugin with Vite and automatically configures the setup file that initializes coverage map and comparison tracing globals. The two test projects keep your unit tests and fuzz tests separate - Vitest runs them in different contexts.

## 3. Write a Fuzz Test

Create `test/parser.fuzz.ts`:

```ts
import { fuzz } from "@vitiate/core";
import { parse, ParseError } from "../src/parser.js";

fuzz("parse does not crash", (data: Buffer) => {
  try {
    parse(data.toString("utf-8"));
  } catch (error) {
    if (!(error instanceof ParseError)) {
      throw error; // re-throw unexpected errors
    }
  }
});
```

The `fuzz()` function works like Vitest's `test()`. It receives a name, a target function that takes a `Buffer`, and optional configuration. The fuzzer will call your target with thousands of generated inputs, looking for uncaught exceptions.

Catch expected errors (like `ParseError` above) and let unexpected ones propagate - those are the bugs you want to find.

## 4. Run the Fuzzer

Use the `vitiate fuzz` command to activate fuzzing mode:

```bash
npx vitiate fuzz
```

Or set `VITIATE_FUZZ=1` directly:

```bash
VITIATE_FUZZ=1 npx vitest run
```

You will see a startup banner followed by periodic status updates showing execution count, corpus size, and coverage edges discovered:

```
fuzz: elapsed: 3s, execs: 1024 (3412/sec), corpus: 23 (5 new), edges: 142
fuzz: elapsed: 6s, execs: 2048 (3506/sec), corpus: 31 (8 new), edges: 158
```

When the fuzzer finds a crash, it prints the error, minimizes the input, and saves it:

```
fuzz: CRASH FOUND: TypeError: Cannot read properties of undefined (reading 'length')
fuzz: crash artifact written to: .vitiate/testdata/vxr4kpqyb12fza1gv81bjj8k3i64mlqn-parse_does_not_crash/crashes/crash-e5f6...
```

Press `Ctrl+C` to stop fuzzing at any time. Add `.vitiate/corpus/` to your `.gitignore` - this directory can grow large and is regenerated automatically.

## 5. Replay as Regression Tests

Run your test suite normally (without `VITIATE_FUZZ`):

```bash
npx vitest run
```

Vitiate automatically replays saved crash artifacts and corpus entries in regression mode. The crash you just found is now a permanent regression test - no extra code needed.

## Next Steps

- Read the [Fuzzing Primer](/concepts/fuzzing-primer/) if you are new to coverage-guided fuzzing
- Follow the [Tutorial](/getting-started/tutorial/) for a longer guided walkthrough
- Learn about [Structure-Aware Fuzzing](/guides/structure-aware-fuzzing/) for targets that need typed inputs
- Enable [Vulnerability Detectors](/guides/detectors/) to find security issues beyond crashes
