## Why

The path traversal detector's sandbox model (single `sandboxRoot` defaulting to `cwd`) produces false positives in real-world fuzzing and lacks the expressiveness needed for practical use. The token set is coupled to the fuzzer's own filesystem layout rather than generating generic attack payloads. Additionally, `fs/promises` is not hooked, so async-first codebases bypass detection entirely. These issues were identified in a code review (REVIEW2.md) and need to be addressed together since they all touch the same detector.

## What Changes

- **BREAKING**: Replace the single `sandboxRoot` parameter with a two-list policy model: `allowedPaths` (default: `["/"]`) and `deniedPaths` (default: `["/etc/passwd"]`). Policy evaluation: denied > allowed. Both use separator-aware prefix matching on resolved absolute paths.
- **BREAKING**: Remove `sandboxRoot` option entirely - it is equivalent to a single `allowedPaths` entry and adds a redundant concept.
- Replace config-dependent tokens (sandbox path, depth-computed traversal chains) with generic traversal tokens plus all `deniedPaths` entries.
- Hook `fs/promises` module in addition to `fs`, so async filesystem APIs are also intercepted.
- Fix the hook plugin's import bail-out check: `code.includes("fs")` matches any occurrence of "fs" in source code, making the optimization ineffective. Use a more specific pattern.
- Add a path traversal case to the detectors example (`process-input.ts`) with a CmpLog-friendly sentinel gate, and ensure it is covered by the fuzz pipeline test.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `path-traversal-detector`: Policy model changes (allowedPaths/deniedPaths replacing sandboxRoot), fs/promises hooks, token set redesign
- `detector-framework`: Config schema update - remove `sandboxRoot`, add `allowedPaths` and `deniedPaths` arrays
- `vitest-plugin`: Fix hook import bail-out check for "fs" specificity

## Impact

- **Config**: `PathTraversalOptionsSchema` replaces `sandboxRoot` with `allowedPaths` and `deniedPaths`. Existing configs using `sandboxRoot` will fail validation.
- **Code**: `path-traversal.ts` (policy rewrite), `config.ts` (schema), `manager.ts` (option passing), `plugin.ts` (bail-out fix)
- **Example**: `examples/detectors/src/process-input.ts` gains a `read` command case
- **Tests**: `detectors.test.ts` path traversal suite updated for new policy model; new tests for `fs/promises` and policy priority
