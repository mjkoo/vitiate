## Why

Vitiate ships three Tier 1 detectors (prototype pollution, command injection, path traversal) that are on by default. Three additional Tier 2 detectors — ReDoS attribution, SSRF, and unsafe eval — cover real vulnerability classes but apply to narrower use cases. Implementing these as opt-in detectors gives users coverage for server-side request forgery, regex denial-of-service attribution, and code injection via eval/Function.

## What Changes

- **New detector: ReDoS attribution** — Hooks `RegExp.prototype.exec`, `RegExp.prototype.test`, and `String.prototype.{match,matchAll,replace,replaceAll,search,split}`. Measures wall-clock time per regex call and throws `VulnerabilityError` when a single operation exceeds a configurable threshold (default: 100ms). Attributes the timeout to the specific regex pattern and input, unlike the existing watchdog which only reports a generic timeout.
- **New detector: SSRF** — Hooks `fetch()`, `http.request()`, `https.request()`, and `http.get()`/`https.get()`. Parses the URL/options argument to extract the target hostname/IP. Checks against a built-in blocklist of private/reserved IP ranges (RFC 1918, RFC 6598, link-local, loopback, cloud metadata) and a configurable set of additional internal hosts. Supports CIDR notation (`10.0.0.0/8`), bare IPs (`192.168.1.1`), hostnames (`metadata.google.internal`), and wildcard domains (`*.corp.example.com`) in both the blocklist and allowlist. Performs DNS-independent matching on the raw hostname string — no DNS resolution, which avoids TOCTOU races and keeps overhead near zero.
- **New detector: Unsafe eval** — Hooks `eval()` and the `Function` constructor. Checks whether the code argument contains a detector goal string (`vitiate_eval_inject`). If fuzz input reaches eval in a position controlling the evaluated code, that's arbitrary code execution.
- **Config schema expansion** — Add `redos`, `ssrf`, and `unsafeEval` keys to the `DetectorsSchema` in `config.ts`. All three are Tier 2 (default off). `ssrf` accepts an options object with `blockedHosts` and `allowedHosts` arrays supporting CIDR ranges, IPs, hostnames, and wildcard domains. `redos` accepts an options object with a `thresholdMs` override.
- **CLI flag expansion** — Extend `parseDetectorsFlag()` to recognize the three new detector names and their dotted options (e.g., `ssrf.blockedHosts=meta.internal:10.200.0.0/24`).
- **Dictionary tokens** — Each new detector pre-seeds the mutation dictionary via `getTokens()`. SSRF seeds private IPs, cloud metadata endpoints, and configured internal hosts. Unsafe eval seeds the goal string and code-injection metacharacters. ReDoS seeds generic backtracking payloads.

## Capabilities

### New Capabilities

- `redos-detector`: ReDoS attribution detector — hooks regex execution methods, measures per-call wall time, reports the specific pattern and input when a threshold is exceeded.
- `ssrf-detector`: SSRF detector — hooks HTTP request APIs, validates target host against configurable blocklist/allowlist supporting CIDR ranges, IPs, hostnames, and wildcard domains.
- `unsafe-eval-detector`: Unsafe eval detector — hooks `eval()` and `Function` constructor, detects fuzz input reaching code evaluation via goal string matching.

### Modified Capabilities

- `detector-framework`: Add Tier 2 detector configuration keys (`redos`, `ssrf`, `unsafeEval`) to the `DetectorsSchema` and CLI flag parser. Extend the `DETECTOR_REGISTRY` in `DetectorManager` with registrations for the three new detectors.

## Impact

- **Config schema** (`vitiate/src/config.ts`): New Valibot schemas for `SsrfOptionsSchema`, `RedosOptionsSchema`; three new keys in `DetectorsSchema`.
- **CLI** (`vitiate/src/cli.ts`): `parseDetectorsFlag()` gains three new known detector names.
- **Detector manager** (`vitiate/src/detectors/manager.ts`): Three new entries in `DETECTOR_REGISTRY`.
- **New files**: `vitiate/src/detectors/redos.ts`, `vitiate/src/detectors/ssrf.ts`, `vitiate/src/detectors/unsafe-eval.ts`, plus a host-matching utility for SSRF CIDR/wildcard parsing.
- **Tests**: New unit tests for each detector, SSRF host-matching logic (CIDR parsing, wildcard matching, edge cases), and integration tests for Tier 2 configuration resolution.
- **No changes** to the SWC plugin, Rust engine, fuzz loop, or existing Tier 1 detectors.
- **No breaking changes**.
