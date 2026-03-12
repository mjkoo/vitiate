## 1. Config Schema and CLI

- [x] 1.1 Add `RedosOptionsSchema` (`{ thresholdMs?: number }`) and `SsrfOptionsSchema` (`{ blockedHosts?: StringOrStringArray, allowedHosts?: StringOrStringArray }`) to `config.ts`
- [x] 1.2 Add `redos`, `ssrf`, and `unsafeEval` keys to `DetectorsSchema` transform and validation object
- [x] 1.3 Extend `parseDetectorsFlag()` in `cli.ts` to recognize `redos`, `ssrf`, `unsafeEval` and their dotted options
- [x] 1.4 Update `KNOWN_DETECTOR_NAMES` set in `cli.ts` to include the three new detector names
- [x] 1.5 Write unit tests for config validation (Tier 2 boolean, options objects, path-delimited strings, unsafeEval options-object rejection) and CLI flag parsing

## 2. Stash Helper for Direct-Replacement Hooks

- [x] 2.1 Create an exported `stashAndRethrow(error: unknown): never` helper in `module-hook.ts` that: if `error` is a `VulnerabilityError`, writes it to the stash slot (first-write-wins); then unconditionally re-throws `error`
- [x] 2.2 Refactor `installHook`'s catch block to call `stashAndRethrow(e)` instead of inline stash logic (the `throw e` after is unreachable since `stashAndRethrow` never returns - remove it). No behavior change.
- [x] 2.3 Write unit test: `stashAndRethrow` stashes VulnerabilityError and re-throws, preserves first-write-wins, re-throws non-VulnerabilityError without stashing

## 3. Host Matching Utility

- [x] 3.1 Create `vitiate/src/detectors/host-matcher.ts` with `HostMatcher` class: `matches(hostname)` returns the matching rule string or `null`
- [x] 3.2 Implement IPv4 exact match and CIDR containment via 32-bit unsigned integer arithmetic
- [x] 3.3 Implement IPv6 exact match and CIDR containment via `BigInt` 128-bit arithmetic
- [x] 3.4 Implement hostname matching (case-insensitive) and wildcard domain matching (`*.example.com`)
- [x] 3.5 Implement IPv6 bracket stripping (`[::1]` → `::1`) in `matches()`
- [x] 3.6 Implement construction-time validation (reject invalid CIDR prefix lengths, malformed IPs)
- [x] 3.7 Write comprehensive unit tests for `HostMatcher`: each format independently, return value is rule string or null, edge cases (empty matcher, invalid specs, boundary CIDR addresses, case insensitivity, deeply nested wildcards)

## 4. SSRF Detector

- [x] 4.1 Create `vitiate/src/detectors/ssrf.ts` implementing the `Detector` interface with `name: "ssrf"`, `tier: 2`
- [x] 4.2 Implement `setup()` hooking `http.request`, `http.get`, `https.request`, `https.get` via `installHook`, and `globalThis.fetch` via direct replacement with `stashAndRethrow`
- [x] 4.3 Implement URL/hostname extraction from string URL, URL object, and options object arguments (with options-override semantics and IPv6-aware port stripping for `host` field)
- [x] 4.4 Instantiate built-in blocklist `HostMatcher` and user-configured blocklist/allowlist matchers; implement policy evaluation (allowed > blocked > allow); use `HostMatcher` return value as `matchedRule` in VulnerabilityError context
- [x] 4.5 Implement `getTokens()` returning static private IP/scheme tokens (including IPv6 ULA and link-local tokens) plus config-dependent blocked host tokens (URL variants only for bare IPs and hostnames, not CIDRs or wildcards)
- [x] 4.6 Implement `teardown()` restoring all hooks including `globalThis.fetch`
- [x] 4.7 Write unit tests: built-in blocklist coverage, allowedHosts override, custom blockedHosts, URL extraction from all argument forms (including IPv6 `host` field with port), options-override semantics, malformed URL passthrough, VulnerabilityError context fields including `matchedRule`

## 5. ReDoS Attribution Detector

- [x] 5.1 Create `vitiate/src/detectors/redos.ts` implementing the `Detector` interface with `name: "redos"`, `tier: 2`
- [x] 5.2 Implement `setup()` wrapping `RegExp.prototype.exec`, `RegExp.prototype.test`, `String.prototype.match/replace/replaceAll/search/split` with timing wrappers gated by `isDetectorActive()`, using `stashAndRethrow` for VulnerabilityErrors
- [x] 5.3 Implement timing logic: `performance.now()` around original call, throw `VulnerabilityError` if elapsed exceeds threshold, with context including pattern, flags, input (truncated to 1024 chars), elapsedMs, method
- [x] 5.4 Skip timing for `String.prototype` methods when the first argument is not a `RegExp` instance (including `undefined`/missing arguments); let original method errors (e.g., `replaceAll` TypeError for non-global regex) propagate naturally
- [x] 5.5 Implement `getTokens()` returning the four generic backtracking payloads
- [x] 5.6 Implement `teardown()` restoring all eight prototype methods
- [x] 5.7 Write unit tests: threshold detection, fast regex passthrough, iteration-window gating, custom threshold, string-argument skip, undefined-argument skip, replaceAll non-global regex TypeError propagation, prototype restoration on teardown, stash recovery when target catches VulnerabilityError

## 6. Unsafe Eval Detector

- [x] 6.1 Create `vitiate/src/detectors/unsafe-eval.ts` implementing the `Detector` interface with `name: "unsafe-eval"`, `tier: 2`
- [x] 6.2 Implement `setup()` wrapping `globalThis.eval` and `globalThis.Function` with goal-string checking wrappers gated by `isDetectorActive()`, using `stashAndRethrow` for VulnerabilityErrors
- [x] 6.3 Implement goal string check in eval wrapper (string arguments only, non-string passes through) and Function wrapper (all string arguments, both `new Function(...)` and `Function(...)` calling conventions)
- [x] 6.4 Implement `getTokens()` returning goal string and code-injection metacharacters
- [x] 6.5 Implement `teardown()` restoring `globalThis.eval` and `globalThis.Function`
- [x] 6.6 Write unit tests: goal string detection in eval, non-string eval passthrough, goal string in Function body, goal string in Function params, Function without `new`, passthrough without goal string, iteration-window gating, teardown restoration, stash recovery

## 7. Detector Manager Registration and Exports

- [x] 7.1 Add three new entries to `DETECTOR_REGISTRY` in `manager.ts` with factory functions parsing options for each Tier 2 detector
- [x] 7.2 Import the three new detector classes in `manager.ts`
- [x] 7.3 Export `stashAndRethrow` from `module-hook.ts` (barrel re-export in `index.ts` omitted - all consumers are internal to `detectors/`)
- [x] 7.4 Update the "Unknown detector keys" scenario example in tests (change `ssrf` to a genuinely unknown key)
- [x] 7.5 Write integration tests: Tier 2 detectors disabled by default, enabled with `true`, enabled with options object, explicit `false` disables

## 8. Full Suite Validation

- [x] 8.1 Run full test suite and fix any regressions
- [x] 8.2 Run lints and checks (eslint, prettier, tsc) and fix any issues
