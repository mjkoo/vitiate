## 1. Config Schema

- [x] 1.1 Update `PathTraversalOptionsSchema` in `config.ts`: remove `sandboxRoot`, add `allowedPaths` (optional string array) and `deniedPaths` (optional string array)
- [x] 1.2 Update `DetectorManager` registry in `manager.ts` to pass `allowedPaths` and `deniedPaths` options to `PathTraversalDetector` constructor

## 2. Path Traversal Detector Policy

- [x] 2.1 Write tests for the new policy model: default policy (denies `/etc/passwd`, allows other paths), custom `allowedPaths` restricts access, custom `deniedPaths` overrides allowed, separator-aware prefix matching prevents false positives, null byte detection
- [x] 2.2 Rewrite `PathTraversalDetector` constructor to accept `allowedPaths` (default `["/"]`) and `deniedPaths` (default `["/etc/passwd"]`), resolving all entries to absolute paths
- [x] 2.3 Replace `isPathEscaping` with policy evaluation: denied > allowed > deny. Use separator-aware prefix matching (`resolved === entry || resolved.startsWith(entry + path.sep)`)
- [x] 2.4 Update `checkPath` to use the new policy evaluation instead of sandbox root check

## 3. Token Set

- [x] 3.1 Write tests for the new token set: static traversal tokens present, `deniedPaths` entries present, no sandbox-path-derived tokens
- [x] 3.2 Update `getTokens()`: keep static traversal tokens, add all resolved `deniedPaths` entries, remove sandbox root and depth-computed chain tokens

## 4. fs/promises Hooks

- [x] 4.1 Write tests for `fs/promises` hooks: async readFile denied path throws VulnerabilityError, hooks are independent from `fs` hooks
- [x] 4.2 Add `fs/promises` hook installation in `setup()`: loop over `SINGLE_PATH_FUNCTIONS` and `DUAL_PATH_FUNCTIONS` with `installHook("fs/promises", ...)`, filtering to only functions that exist on the `fs/promises` module
- [x] 4.3 Add `HOOKED_MODULES` entry for `fs/promises` in `plugin.ts` so import rewriting covers `fs/promises` imports

## 5. Plugin Bail-out Fix

- [x] 5.1 Write tests for the bail-out check: source with `import from "fs"` proceeds to parsing, source with `offset` or other "fs" substrings does not trigger parsing, source with `"fs/promises"` proceeds
- [x] 5.2 Replace `code.includes("fs")` in `rewriteHookedImports` bail-out with patterns that check for quoted `"fs"` / `'fs'` / `fs/` to avoid matching arbitrary identifiers containing "fs"

## 6. Detector Example

- [x] 6.1 Add a `read` case to `examples/detectors/src/process-input.ts` that calls `fs.readFileSync()` when the argument equals `/etc/passwd`, gated with strict `===` for CmpLog guidance
- [x] 6.2 Verify the detectors fuzz pipeline test discovers the path traversal vulnerability

## 7. Cleanup

- [x] 7.1 Verify no references to `sandboxRoot` or `isPathEscaping` remain in `path-traversal.ts` (these are removed as part of tasks 2.2-2.3; this is a verification step, not a separate implementation task)
- [x] 7.2 Update or remove any tests that reference the old `sandboxRoot` option
- [x] 7.3 Update the "Options object implies enabled" scenario in the detector-framework spec to use `allowedPaths`/`deniedPaths` instead of `sandboxRoot`
- [x] 7.4 Run full test suite, lints, and checks (eslint, clippy, prettier, cargo fmt, cargo deny, commitlint)
