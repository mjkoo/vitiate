## Why

Vitiate currently detects only crashes and timeouts - it has no awareness of JavaScript-specific vulnerability classes like prototype pollution, command injection, or path traversal. These are the most prevalent security bugs in the npm ecosystem, and coverage-guided fuzzing is well-positioned to find them if the fuzzer has vulnerability-specific oracles. Jazzer.js validates this approach with three shipped detectors, each under 200 lines. Adding detectors to Vitiate makes it a security fuzzer, not just a crash finder.

## What Changes

- Add a **detector framework** with lifecycle hooks (`setup`, `beforeIteration`, `afterIteration`, `teardown`) and a `VulnerabilityError` type that integrates with the existing crash reporting path.
- Add a **module hooking utility** for safe monkey-patching of Node built-in modules (`child_process`, `fs`) with restore-on-teardown semantics.
- Implement three **Tier 1 detectors** (on by default): prototype pollution (snapshot-diff built-in prototypes), command injection (hook `child_process`, check for goal string), and path traversal (hook `fs`, check for directory escape).
- **Define** three Tier 2 detectors (ReDoS, SSRF, unsafe eval) in the design but defer their implementation and config schema to a follow-up change.
- Add **detector configuration** to `FuzzOptions` - per-detector enable/disable with optional config objects (e.g., `sandboxRoot` for path traversal). Schema ignores unknown keys for forward-compatible Tier 2 configuration.
- Add **dictionary pre-seeding** - active detectors contribute tokens (e.g., `__proto__`, `../`, shell metacharacters) to the mutation dictionary at fuzzer startup.
- Add a `-detectors` **CLI flag** (single-hyphen, matching libFuzzer convention) with comma-separated enable/disable and dotted option syntax.
- Detector findings use the existing `crash-{hash}` artifact naming - no special artifact types needed.

## Capabilities

### New Capabilities

- `detector-framework`: Detector interface, lifecycle hooks, VulnerabilityError type, module hooking utility, and detector registration/configuration system.
- `prototype-pollution-detector`: Tier 1 detector that snapshots built-in prototypes before each iteration and reports modifications as findings.
- `command-injection-detector`: Tier 1 detector that hooks `child_process` functions and reports fuzz input reaching shell execution.
- `path-traversal-detector`: Tier 1 detector that hooks `fs` functions and reports fuzz-controlled paths escaping a sandbox root.
- `detector-dictionary-seeding`: Pre-seeding the mutation dictionary with vulnerability-class-specific tokens from active detectors.

### Modified Capabilities

- `fuzz-loop`: Detector lifecycle integration - call `beforeIteration()`/`afterIteration()` around target execution (including calibration and stage execution), handle `VulnerabilityError` throws.
- `test-fuzz-api`: Add `detectors` key to `FuzzOptions` schema for per-test detector configuration.
- `standalone-cli`: Add `-detectors` CLI flag and pass detector config through `VITIATE_CLI_IPC`.
- `fuzzing-engine`: Add `detectorTokens` field to `FuzzerConfig` for pre-seeding detector tokens into the mutation dictionary at construction time.

## Impact

- **vitiate/** - New `detectors/` module with framework + individual detector implementations. Changes to `fuzz-loop.ts` (lifecycle integration), `config.ts` (FuzzOptions schema), `cli.ts` (new flag).
- **vitiate-napi/** - New `detector_tokens` field in `FuzzerConfig` to pass pre-seeded tokens from detectors through NAPI. Tokens inserted into LibAFL state metadata alongside user dictionary.
- **No changes to vitiate-instrument/** - Detectors operate at runtime, not at instrumentation time.
- **No new dependencies** - Detectors are pure TypeScript using Node built-in APIs.
