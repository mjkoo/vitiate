---
title: Vulnerability Detectors
description: Finding security vulnerabilities beyond crashes with built-in detectors.
---

Vitiate includes runtime vulnerability detectors that hook into Node.js APIs to find security issues that do not necessarily cause crashes. Detectors work in both fuzzing and regression modes.

## Overview

Detectors are organized into two tiers:

**Tier 1 (enabled by default):**

| Detector | What It Finds |
|----------|---------------|
| `prototypePollution` | Modifications to `Object.prototype`, `Array.prototype`, and other built-in prototypes |
| `commandInjection` | Attacker-controlled strings reaching `child_process.exec()` and friends |
| `pathTraversal` | File system access outside allowed directories via `../` sequences (Tier 2 on Windows) |

**Tier 2 (disabled by default):**

| Detector | What It Finds |
|----------|---------------|
| `redos` | Regular expressions that take excessive time on crafted input |
| `ssrf` | HTTP requests to internal/private network addresses |
| `unsafeEval` | Attacker-controlled strings reaching `eval()` or `Function()` |

Tier 2 detectors are off by default because they hook sensitive APIs and may produce false positives in code that legitimately makes HTTP requests or uses `eval()`.

## How Detectors Work

Each detector follows a lifecycle for every fuzzing iteration:

1. **Before iteration:** Snapshot the current state (e.g., capture `Object.prototype` properties)
2. **Run the target:** Your fuzz target executes with the hooks active
3. **After iteration:** Check for violations (e.g., compare `Object.prototype` against the snapshot)
4. **Reset:** Restore state for the next iteration

When a detector finds a violation, it throws an error that the fuzzer treats as a crash. The crashing input is saved as an artifact just like any other crash.

### Dictionary Tokens

Each detector contributes **tokens** to the fuzzer's mutation dictionary. For example, the prototype pollution detector adds tokens like `__proto__`, `constructor`, and `prototype`. This helps the fuzzer generate inputs that are more likely to trigger the vulnerability patterns the detector is looking for.

## Enabling and Disabling Detectors

### Per-Test Configuration

```ts
fuzz("process user input", handler, {
  detectors: {
    // Explicitly enable a Tier 2 detector
    ssrf: true,

    // Disable a Tier 2 detector
    redos: false,

    // Configure detector options
    pathTraversal: {
      allowedPaths: ["/app/uploads"],
      deniedPaths: ["/etc/passwd", "/etc/shadow"],
    },
  },
});
```

### Standalone CLI Configuration

When using the [standalone CLI](/vitiate/guides/cli/), you can configure detectors via flags:

```bash
# Enable specific detectors (disables all defaults)
npx vitiate test.fuzz.ts -detectors prototypePollution,ssrf

# Configure detector options
npx vitiate test.fuzz.ts -detectors pathTraversal.deniedPaths=/etc/passwd:/etc/shadow
```

When you specify `-detectors` on the CLI, **all defaults are turned off** and only the listed detectors are active. This lets you focus a fuzzing run on a specific vulnerability class.

## Detector Details

### Prototype Pollution

Snapshots all built-in prototypes (Object, Array, String, Number, Function, etc.) before each iteration and diffs after. Any added, modified, or deleted properties are flagged.

Common finding: libraries that recursively merge objects without checking for `__proto__` or `constructor` keys.

### Command Injection

Hooks all `child_process` functions (`exec`, `execSync`, `spawn`, `spawnSync`, `fork`, `execFile`, `execFileSync`). Checks if the fuzzer's input appears in the command string or arguments. Uses a goal string (`vitiate_cmd_inject`) seeded into the mutation dictionary.

Common finding: user input interpolated into shell commands without escaping.

### Path Traversal

Hooks `fs` and `fs/promises` functions (`readFile`, `writeFile`, `mkdir`, `unlink`, `stat`, etc.). Checks resolved paths against allow/deny lists. The default policy denies access outside the project directory.

Options:
- `allowedPaths`: Array of allowed path prefixes
- `deniedPaths`: Array of explicitly denied paths (checked before allowed)

Common finding: user-controlled filenames joined with `path.join()` without validation.

### ReDoS (Regular Expression Denial of Service)

Hooks `RegExp.prototype` methods (`exec`, `test`) and `String.prototype` methods (`match`, `split`, `replace`, `replaceAll`, `search`, `matchAll`). Measures wall-clock time per call and flags any that exceed the threshold.

Options:
- `thresholdMs`: Maximum allowed execution time per regex call (default: 100ms)

Common finding: regexes with nested quantifiers like `(a+)+` that exhibit exponential backtracking.

### SSRF (Server-Side Request Forgery)

Hooks `http.request`, `https.request`, and `fetch`. Checks request targets against a built-in blocklist of private/internal addresses (`127.0.0.0/8`, `10.0.0.0/8`, `169.254.0.0/16`, `localhost`, metadata endpoints).

Options:
- `blockedHosts`: Additional hosts/CIDRs to block
- `allowedHosts`: Hosts to explicitly allow (overrides blocklist)

Common finding: user-controlled URLs that can reach internal services or cloud metadata endpoints.

### Unsafe Eval

Hooks `eval()`, the `Function` constructor, and `setTimeout`/`setInterval` with string arguments. Checks if attacker-controlled strings are being evaluated as code. Uses a goal string (`vitiate_eval_inject`).

Common finding: template engines or config parsers that `eval()` user input.

## Example: Fuzzing an HTTP Handler with Detectors

```ts
import { fuzz } from "@vitiate/core";
import { FuzzedDataProvider } from "@vitiate/fuzzed-data-provider";
import { handleRequest } from "../src/handler.js";

fuzz("HTTP handler security", (data: Buffer) => {
  const fdp = new FuzzedDataProvider(data);

  const request = {
    method: fdp.pickValue(["GET", "POST", "PUT"]),
    path: fdp.consumeString(500),
    body: fdp.consumeRemainingAsString(),
  };

  handleRequest(request);
}, {
  detectors: {
    prototypePollution: true,
    commandInjection: true,
    pathTraversal: true,
    ssrf: true,
  },
});
```

This target enables four detectors simultaneously. The fuzzer will try to find inputs where the HTTP handler:
- Pollutes built-in prototypes (e.g., via JSON body merging)
- Passes user input to shell commands
- Accesses files outside the allowed directory
- Makes requests to internal network addresses
