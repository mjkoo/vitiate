## Context

Vitiate's detector framework is fully operational with three Tier 1 detectors (prototype pollution, command injection, path traversal). The framework provides: a `Detector` interface with lifecycle hooks, a `VulnerabilityError` type, a `DetectorManager` for orchestration, a module-hook utility with iteration-window gating and error stashing, configuration via `DetectorsSchema` (Valibot), and CLI flag parsing. All Tier 1 detectors follow one of two patterns: snapshot-based (prototype pollution) or module-hook-based (command injection, path traversal).

This change adds three Tier 2 detectors: ReDoS attribution, SSRF, and unsafe eval. All infrastructure needed (interface, manager, hooking, config plumbing) already exists - the work is implementing the detectors themselves and extending the config/CLI to recognize them.

## Goals / Non-Goals

**Goals:**

- Implement ReDoS attribution, SSRF, and unsafe eval detectors following existing patterns
- SSRF detector supports a rich host-specification format: CIDR ranges, bare IPs (v4/v6), hostnames, and wildcard domains - in both blocklist and allowlist
- All three detectors are Tier 2 (opt-in, default off)
- Each detector pre-seeds the mutation dictionary with vulnerability-class-specific tokens
- Extend config schema and CLI flag parser to support the new detectors and their options

**Non-Goals:**

- DNS resolution in the SSRF detector (matching is on the raw hostname string to avoid TOCTOU races and network overhead)
- Regex static analysis for ReDoS (the detector measures wall-clock time, it doesn't analyze patterns for vulnerability)
- Hooking third-party HTTP clients (axios, got, node-fetch, undici) - only Node built-in APIs
- Changing the fuzz loop, SWC plugin, or Rust engine

## Decisions

### Decision 1: ReDoS uses wall-clock timing, not regex analysis

**Choice:** Measure `performance.now()` around each regex call and fire when a single call exceeds a threshold.

**Alternatives considered:**
- **Static regex analysis** (e.g., safe-regex2): Would identify vulnerable patterns without runtime cost, but misses regexes constructed dynamically and can't tell whether the fuzz input actually triggers backtracking. Also adds a dependency.
- **V8 interrupt-based measurement:** V8's `TerminateExecution` is already used by the watchdog. A finer-grained interrupt would be complex and duplicates existing functionality.

**Rationale:** Wall-clock timing is simple, requires no dependencies, and catches the actual behavior the user cares about (a regex that hangs on this input). The existing watchdog already catches the timeout - this detector adds *attribution* (which regex, which pattern, which input) and fires at a lower threshold than the full iteration timeout.

### Decision 2: ReDoS hooks regex methods via direct prototype replacement, not module hooks

**Choice:** Wrap `RegExp.prototype.exec`, `RegExp.prototype.test`, and `String.prototype.match/matchAll/replace/replaceAll/search/split` by replacing the prototype methods directly, using the same iteration-window gating and stash-and-rethrow pattern as module hooks.

**Alternatives considered:**
- **Module hooking on `node:string_decoder` or similar:** Regex methods are prototype methods on global builtins, not module exports. The module-hook utility doesn't apply.
- **Proxy on RegExp instances:** Would intercept per-instance but is far too expensive to wrap every RegExp.

**Rationale:** Prototype method replacement is the only viable interception point. Unlike the prototype *pollution* detector (which watches for unintended changes), this detector intentionally wraps prototype methods. The wrapper must be installed in `setup()` and restored in `teardown()`. The iteration-window flag prevents timing during non-fuzz code. The wrapper stores the original methods and restores them on teardown, following the same pattern as module hooks but operating on builtins instead of module exports. To support finding recovery when targets swallow thrown errors, the stash-and-rethrow logic from `installHook` is extracted into a shared helper that these direct-replacement hooks also use.

### Decision 3: SSRF host matching is a standalone utility with a `HostMatcher` abstraction

**Choice:** Create a `HostMatcher` class that compiles a list of host specifications (CIDR, IP, hostname, wildcard domain) into an efficient matching structure at construction time. The SSRF detector instantiates two matchers: one for `blockedHosts`, one for `allowedHosts`.

**Supported host specification formats:**
| Format | Example | Matches |
|---|---|---|
| IPv4 address | `192.168.1.1` | Exact IP match |
| IPv6 address | `::1`, `[::1]` | Exact IP match (brackets stripped) |
| IPv4 CIDR | `10.0.0.0/8` | Any IP in range |
| IPv6 CIDR | `fe80::/10` | Any IP in range |
| Hostname | `metadata.google.internal` | Exact hostname match (case-insensitive) |
| Wildcard domain | `*.corp.example.com` | Any subdomain (e.g., `foo.corp.example.com`) but NOT `corp.example.com` itself |

The `matches(hostname)` method returns the specification string of the first matching rule (e.g., `"10.0.0.0/8"`) or `null` - this provides the `matchedRule` for `VulnerabilityError` context without a second lookup.

**Matching algorithm:**
1. Parse the request URL/options to extract hostname (with IPv6-aware port stripping for options `host` field).
2. Strip brackets from IPv6 literals (e.g., `[::1]` → `::1`).
3. Try to parse hostname as an IP address. If it is an IP:
   - Check against all IP-based rules (exact match and CIDR containment).
4. If hostname is not an IP:
   - Check against exact hostname rules (case-insensitive).
   - Check against wildcard domain rules (dot-separated suffix match).

**Alternatives considered:**
- **Single regex per rule:** Fragile for CIDR ranges, requires IP-to-integer math for containment checks anyway.
- **Inline matching in the hook callback:** Would work for a few rules but becomes unreadable with CIDR + wildcard + IPv6. A dedicated utility is testable in isolation and composable.
- **Third-party CIDR library (e.g., `ip-cidr`, `netmask`):** Adds a dependency. CIDR containment for IPv4 is ~10 lines of bit arithmetic. IPv6 is larger but still tractable with a `BigInt`-based implementation. Keeping it in-house avoids supply chain risk in a security tool.

**Rationale:** The `HostMatcher` abstraction separates parsing/compilation from the hook callback. It's testable with unit tests covering each format independently. The built-in blocklist (RFC 1918, loopback, link-local, cloud metadata) is compiled once at detector construction, and user-configured hosts are added on top.

### Decision 4: SSRF built-in blocklist covers standard private/reserved ranges

The detector ships with a default blocklist that is always active (not configurable away). User-configured `blockedHosts` extend this list; `allowedHosts` can carve out exceptions.

**Built-in blocklist:**
- `127.0.0.0/8` - IPv4 loopback
- `10.0.0.0/8` - RFC 1918 private
- `172.16.0.0/12` - RFC 1918 private
- `192.168.0.0/16` - RFC 1918 private
- `169.254.0.0/16` - IPv4 link-local
- `100.64.0.0/10` - RFC 6598 shared address space (CGN)
- `0.0.0.0/8` - "this network"
- `::1/128` - IPv6 loopback
- `fc00::/7` - IPv6 unique local address
- `fe80::/10` - IPv6 link-local
- `localhost` - loopback hostname (CIDR rules match IPs only; this catches the hostname form)
- `169.254.169.254` - cloud metadata endpoint (AWS, GCP, Azure)
- `metadata.google.internal` - GCP metadata hostname

**Policy evaluation order:** `allowedHosts` > `blockedHosts` (including built-ins) > allow. This lets users carve exceptions for hosts they know are safe (e.g., an internal service the target legitimately calls during fuzzing). This is the opposite priority order from path traversal (where denied > allowed > deny) because the use cases differ: path traversal blocks known-bad paths, while SSRF blocks known-internal networks with user exceptions.

### Decision 5: SSRF hooks Node built-in HTTP APIs only

**Hooked functions:**
- `http.request()` and `http.get()` - four separate `installHook` calls (two per module). Node's `http.get()` captures a closure-local reference to `request`, not `module.exports.request`, so patching the `request` export alone would miss `get()` calls. The separate hooks do not double-fire for the same reason.
- `https.request()` and `https.get()` - same pattern as `http`.
- Global `fetch()` - via direct replacement on `globalThis` (not a module export), using `stashAndRethrow` for finding recovery.

Each hook extracts the URL from the first argument, which can be a string URL, a `URL` object, or an options object with `hostname`/`host`/`port` fields. The hook normalizes to a hostname string and runs it through the `HostMatcher`.

**Not hooked:** Third-party HTTP clients (`axios`, `got`, `node-fetch`, `undici`). These ultimately call the Node built-in APIs (or `undici` in newer Node versions), so the built-in hooks catch most cases. Direct `undici` usage via `net.connect` is out of scope.

### Decision 6: Unsafe eval follows the command injection goal-string pattern

**Choice:** Goal-string detection with direct global replacement, structurally similar to the command injection detector but hooking `globalThis` properties instead of module exports (since `eval` and `Function` are global builtins, not module exports).

- Hook `eval` on `globalThis` via direct replacement (same approach as ReDoS). Only check string arguments (`typeof arg === "string"`); non-string eval arguments pass through.
- Hook `Function` constructor by wrapping `globalThis.Function`. Must handle both `new Function(...)` and `Function(...)` calling conventions.
- Goal string: `vitiate_eval_inject`
- Check if the code argument contains the goal string
- Use the shared `stashAndRethrow` helper for finding recovery

This is the simplest detector. No options, no complex matching, no per-iteration state.

### Decision 7: Config schema uses `boolean | OptionsObject` union pattern

Following the established pattern from path traversal:

```typescript
// redos: boolean or { thresholdMs?: number }
// ssrf: boolean or { blockedHosts?: string[], allowedHosts?: string[] }
// unsafeEval: boolean only (no options needed)
```

The `DetectorsSchema` transform gains three new known keys. The `DETECTOR_REGISTRY` in `manager.ts` gains three new entries with factory functions that parse their respective options.

## Risks / Trade-offs

**[ReDoS timing overhead]** → Wrapping every regex call with `performance.now()` adds ~50-100ns per call. For targets with thousands of regex operations per iteration, this could be measurable. Mitigation: Tier 2 (opt-in only), so users accept the overhead explicitly. The wrapper is a no-op outside the iteration window.

**[ReDoS false positives on legitimate slow regexes]** → Some regexes are intentionally expensive on large inputs (e.g., log parsing). The configurable `thresholdMs` (default 100ms) provides an escape hatch. At 100ms the threshold is well above normal regex execution but well below the iteration timeout (typically 1-5 seconds).

**[SSRF hostname-only matching misses IP-based bypasses]** → An attacker could use decimal IP notation (`2130706433` for `127.0.0.1`), octal (`0177.0.0.1`), or DNS rebinding. Mitigation: We match the raw hostname string, not the resolved IP. Decimal/octal bypasses are out of scope - they require DNS resolution to detect, which we explicitly avoid. This is a known limitation documented in the spec. The detector catches the common case (direct use of private IPs/hostnames).

**[SSRF `fetch` hooking on newer Node versions]** → Node 18+ ships `fetch` via `undici`. Patching `globalThis.fetch` works but if the target imports `undici` directly and calls `request()`, the hook is bypassed. Mitigation: Document this limitation. The built-in `fetch`/`http`/`https` hooks cover the vast majority of real-world usage.

**[Eval hooking on `globalThis`]** → Patching `globalThis.eval` works for direct `eval()` calls but not for indirect eval (`(0, eval)("code")` or `window.eval`). Similarly, patching `globalThis.Function` does not cover access via the prototype chain (`({}).constructor.constructor("code")()`). Mitigation: The goal-string approach means the input still needs to reach some eval path - indirect eval with the goal string is still a finding. The detector catches the common case. Both limitations are documented in the spec.

**[IPv6 CIDR matching complexity]** → IPv6 addresses are 128-bit, requiring `BigInt` for containment checks. This adds some code complexity. Mitigation: The matching is done at hook-check time (once per HTTP call, not once per iteration), so the cost is negligible. The implementation is straightforward with `BigInt` bitwise operations.

## Open Questions

None - the design follows established patterns and all decisions are straightforward extensions of existing infrastructure.
