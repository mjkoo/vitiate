---
title: "Tutorial: Finding Your First Bug"
description: A guided walkthrough of fuzzing a URL parser from setup to crash to regression test.
---

This tutorial walks through the full fuzzing workflow using a URL parser as the target. You will set up instrumentation, write a fuzz target, run the fuzzer, investigate a crash, and add it as a regression test.

## The Target

Suppose you have a URL parser module at `src/url-parser.ts` that parses URL strings into structured objects:

```ts
// src/url-parser.ts
export interface ParsedUrl {
  protocol: string;
  hostname: string;
  port: number | undefined;
  pathname: string;
  query: Record<string, string>;
}

export function parseUrl(input: string): ParsedUrl {
  // ... parsing logic
}
```

This is a classic fuzzing target: it takes untrusted string input and does complex parsing with many edge cases.

## Step 1: Set Up the Project

If you have not already, install the packages and configure Vitest as described in the [Quickstart](/vitiate/getting-started/quickstart/).

## Step 2: Write the Fuzz Target

Create `test/url-parser.fuzz.ts`:

```ts
import { fuzz } from "@vitiate/core";
import { parseUrl } from "../src/url-parser.js";

fuzz("parseUrl does not crash on arbitrary input", (data: Buffer) => {
  const input = data.toString("utf-8");
  parseUrl(input);
});
```

This is the simplest form: pass every input to the parser and let any uncaught exception surface as a crash. We are not catching any errors here because *any* unhandled exception from `parseUrl` is a bug worth investigating.

## Step 3: Add Seed Inputs

Seed inputs give the fuzzer a head start. First, run the fuzzer briefly so it creates the seed directory (the directory name includes a hash prefix derived from the test name):

```bash
VITIATE_FUZZ=1 npx vitest run test/url-parser.fuzz.ts
```

Press `Ctrl+C` after a few seconds, or set a limit with the `fuzzExecs` option in your test.

Check the created directory name:

```bash
ls test/testdata/fuzz/
# Example output: a1b2c3d4-parseUrl_does_not_crash_on_arbitrary_input
```

Then add seed files to that directory:

```bash
SEED_DIR=$(ls -d test/testdata/fuzz/*parseUrl*)
echo -n 'https://example.com' > "$SEED_DIR/seed-basic"
echo -n 'http://user:pass@host.com:8080/path?key=value&foo=bar#section' > "$SEED_DIR/seed-full"
echo -n 'ftp://[::1]:21/file' > "$SEED_DIR/seed-ipv6"
```

Seeds do not need to trigger bugs - they just need to exercise different code paths so the fuzzer can mutate from diverse starting points.

## Step 4: Run the Fuzzer

```bash
VITIATE_FUZZ=1 npx vitest run test/url-parser.fuzz.ts
```

Watch the output. The `edges` counter shows how many unique code edges the fuzzer has reached. The `corpus` counter shows how many inputs have been kept because they found new coverage.

```
fuzz: elapsed: 1s, execs: 512 (2841/sec), corpus: 15 (15 new), edges: 89
fuzz: elapsed: 4s, execs: 2048 (3120/sec), corpus: 34 (19 new), edges: 127
fuzz: elapsed: 10s, execs: 8192 (3254/sec), corpus: 41 (7 new), edges: 143
```

When a crash is found, the fuzzer prints the error, minimizes the crashing input to its smallest reproducing form, and writes it to disk.

## Step 5: Examine the Crash

Look at the crash artifact (the path is printed in the crash output):

```bash
ls test/testdata/fuzz/*parseUrl*/crash-*
xxd test/testdata/fuzz/*parseUrl*/crash-*
```

The file contains the raw bytes that triggered the crash. The filename includes a SHA-256 hash for deduplication - if the fuzzer finds the same crash twice, it will not create a duplicate file.

## Step 6: Fix the Bug

Examine the stack trace from the fuzzer output to understand the root cause. Fix the parser, then verify the fix by running the fuzzer again. The crash artifact remains on disk as a regression test.

## Step 7: Run Regression Tests

```bash
npx vitest run
```

Vitest runs your fuzz tests in regression mode, replaying every file in the seed corpus directory (including crash artifacts) and every cached corpus entry. If your fix is correct, the crash artifact no longer throws and the test passes.

If you revert the fix, the test fails immediately - the crash artifact is a permanent guard against regression.

## Step 8: Add a Dictionary (Optional)

If the fuzzer is slow to find coverage, add domain-specific tokens. Create a dictionary file next to the seed directory (same name with `.dict` extension):

```
"://"
"http"
"https"
"ftp"
"@"
":"
"/"
"?"
"&"
"="
"#"
"%20"
"[::1]"
"localhost"
```

The fuzzer will use these tokens during mutation, making it much more likely to generate structurally valid URLs that exercise deep parsing paths. See [Dictionaries and Seeds](/vitiate/guides/dictionaries-and-seeds/) for the full dictionary syntax, hex escapes for binary tokens, and links to premade dictionaries for common formats.

## Step 9: Tighten the Target (Optional)

Once the parser handles arbitrary input without crashing, you can add assertions to check semantic correctness:

```ts
fuzz("parseUrl round-trips", (data: Buffer) => {
  const input = data.toString("utf-8");
  let parsed;
  try {
    parsed = parseUrl(input);
  } catch {
    return; // parsing failures are acceptable
  }

  // If parsing succeeds, the result should be consistent
  if (parsed.port !== undefined) {
    assert(parsed.port >= 0 && parsed.port <= 65535, `invalid port: ${parsed.port}`);
  }
  if (parsed.protocol) {
    assert(parsed.protocol.endsWith(":"), `protocol missing colon: ${parsed.protocol}`);
  }
});
```

This finds a different class of bugs: inputs that parse successfully but produce invalid results.

## Summary

The fuzzing workflow is:

1. Write a fuzz target that exercises the code under test
2. Optionally add seed inputs and a dictionary
3. Run `VITIATE_FUZZ=1 npx vitest run` and let it find crashes
4. Fix the bugs; crash artifacts become regression tests automatically
5. Tighten assertions over time as the code matures
