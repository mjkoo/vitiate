## Context

Vitiate currently classifies fuzz iteration outcomes into three categories: `ExitKind.Ok` (no issue), `ExitKind.Crash` (target threw an exception), and `ExitKind.Timeout` (watchdog fired). These map to two artifact kinds (`crash-{hash}`, `timeout-{hash}`) and two LibAFL objective feedbacks (`CrashFeedback`, `TimeoutFeedback`).

This is sufficient for finding crashes but misses JavaScript-specific vulnerability classes - prototype pollution, command injection, path traversal - where the target completes successfully but leaves the runtime in a compromised state. These vulnerabilities account for hundreds of annual npm advisories and are well-suited to fuzzer detection because they have unambiguous, mechanically-checkable definitions.

The fuzz loop in `loop.ts` calls `executeTarget()` which wraps target invocation with watchdog protection. The result flows to `fuzzer.reportResult()` on the Rust side, which evaluates coverage feedback and crash/timeout objectives. Detectors need to intercept the gap between "target returned without throwing" and "report result to the engine."

## Goals / Non-Goals

**Goals:**

- Provide a detector framework with clear lifecycle hooks that integrates with the existing fuzz loop without modifying the Rust engine's feedback evaluation
- Ship three Tier 1 detectors (prototype pollution, command injection, path traversal) that are on by default with near-zero false positives
- Define three Tier 2 detectors (ReDoS, SSRF, unsafe eval) as opt-in
- Add per-detector configuration to `FuzzOptions` and `-detectors` CLI flag
- Pre-seed the mutation dictionary with detector-specific tokens
- Detector findings use the existing crash artifact path - no special artifact naming

**Non-Goals:**

- Modifying the SWC instrumentation plugin - detectors operate purely at runtime
- Adding new `ExitKind` variants or feedback types to the Rust engine - detector findings are reported as `ExitKind.Crash` (a `VulnerabilityError` throw is a crash from the engine's perspective)
- Taint tracking or data-flow analysis - detectors use lightweight interception (snapshots, module hooks, goal strings)
- SQL injection, XSS, or SSTI detection - too fragmented across driver/template ecosystems
- Detector-specific crash minimization strategies - the existing minimizer works on detector findings since they produce deterministic throws

## Decisions

### 1. Detectors throw VulnerabilityError, reusing the existing crash path

**Decision:** Detectors signal findings by throwing a `VulnerabilityError` (extends `Error`) during or after target execution. The existing `executeTarget()` catch block sees this as `ExitKind.Crash`, and the Rust engine's `CrashFeedback` objective captures it as a solution.

**Rationale:** This avoids any changes to the Rust engine, the NAPI boundary types, or the LibAFL feedback/objective system. The Rust side doesn't need to know about detectors - it just sees crashes. The TypeScript side can distinguish detector findings from ordinary crashes via `error instanceof VulnerabilityError` for logging purposes, but both produce the same `crash-{hash}` artifact.

**Alternative considered:** Adding new `ExitKind` variants (e.g., `ExitKind.Vulnerability = 3`) and corresponding Rust objectives. This would give the engine separate deduplication for detector findings vs. crashes, but requires changes across the NAPI boundary, LibAFL objective tuple types, and every call site that matches on `ExitKind`. The complexity isn't justified - detector findings are rare events (like crashes), and the existing crash deduplication (coverage-map-based novelty) works for them too.

### 2. Post-execution hook model with beforeIteration/afterIteration lifecycle

**Decision:** Detectors implement a `Detector` interface with lifecycle hooks:

```typescript
interface Detector {
  readonly name: string;
  readonly tier: 1 | 2;
  getTokens(): Uint8Array[];
  setup(): void;
  beforeIteration(): void;
  afterIteration(): void;
  teardown(): void;
}
```

- `setup()`: Called once before fuzzing starts. Module-hook detectors (command injection, path traversal) install their monkey-patches here.
- `beforeIteration()`: Called before each `executeTarget()`. Snapshot detectors (prototype pollution) capture baseline state here.
- `afterIteration()`: Called after `executeTarget()` completes without throwing. Snapshot detectors diff against baseline and throw `VulnerabilityError` if a violation is found. Module-hook detectors don't use this - they throw inline during target execution.
- `teardown()`: Called after fuzzing ends. Restores monkey-patched modules.
- `getTokens()`: Returns dictionary tokens to pre-seed. Called once during setup.

**Rationale:** This separates the two detector mechanisms cleanly:
- **Snapshot detectors** (prototype pollution): Need before/after to diff state. Cannot throw during execution because the pollution happens via normal property assignment, not a hookable function call.
- **Module-hook detectors** (command injection, path traversal, SSRF, unsafe eval): Throw immediately when the hooked function is called with a triggering argument. `afterIteration()` is a no-op for these.

**Alternative considered:** A single `check(input, error?)` post-execution hook. Simpler interface, but doesn't support module-hook detectors that need to throw during execution (when the hooked function is called, the detector must throw immediately to capture the correct stack trace). Splitting into before/after accommodates both patterns.

### 3. Integration point: wrap executeTarget() in the fuzz loop

**Decision:** The detector lifecycle wraps `executeTarget()` in `loop.ts`:

```typescript
// In the main iteration loop:
detectorManager.beforeIteration();
const result = await executeTarget(target, input, watchdog, timeoutMs);
if (result.exitKind === ExitKind.Ok) {
  detectorManager.afterIteration(); // may throw VulnerabilityError
}
```

If `afterIteration()` throws, the result is upgraded to `{ exitKind: ExitKind.Crash, error: vulnerabilityError }`. This upgraded result flows through the normal `reportResult()` → `handleCrash()` path.

Module-hook detectors throw during `executeTarget()` itself, so the result already comes back as `ExitKind.Crash` with the `VulnerabilityError` as the error.

The same `beforeIteration()`/`afterIteration()` wrapping SHALL also apply to calibration re-runs and stage executions. A `VulnerabilityError` during calibration breaks the calibration loop (same as a crash). A `VulnerabilityError` during a stage execution calls `abortStage()` and writes an artifact without minimization (same as a stage crash).

**Rationale:** Minimal changes to the fuzz loop. The detector lifecycle is a thin wrapper around target execution in all three contexts (main loop, calibration, stages), not a restructuring of the loop. The Rust engine and watchdog are unaffected.

### 4. Detector findings use the existing crash artifact path

**Decision:** Detector findings produce standard `crash-{hash}` artifacts, identical to ordinary crashes. No special `vuln-*` naming or `ArtifactKind` extension is needed. The `VulnerabilityError` message in the console output tells the user what category of bug was found.

**Rationale:** From the engine's perspective, a detector finding is just a crash - the `VulnerabilityError` throw is caught the same way as any other exception. Using the same `crash-{hash}` naming keeps the artifact system simple: no type extensions, no special corpus loading logic, no changes to regression replay. The error message logged when the crash is written provides the detector name and vulnerability type, which is sufficient for users to understand what was found. Replaying the artifact re-runs the target with detectors active, so the `VulnerabilityError` is thrown again with full context.

### 5. Module hooking via CJS require patching

**Decision:** Hook Node built-in modules (`child_process`, `fs`, `net`, `http`, `https`) by replacing exported functions on the module object. Since Vitiate runs instrumented code via Vite's module graph (which uses CJS interop for Node built-ins), patching `require("child_process").exec` is sufficient to intercept both `require` and `import` usage of these modules within the Vite-transformed bundle.

The hooking utility saves the original function reference and restores it in `teardown()`. Each hook wraps the original: it runs the detector check (e.g., "does the argument contain the goal string?"), throws `VulnerabilityError` if triggered, and otherwise calls through to the original.

**Rationale:** Vite transforms all ESM imports into its module graph, and Node built-in modules are loaded via CJS interop regardless of whether the user wrote `import` or `require`. This means patching the CJS module export is sufficient - we don't need a custom ESM loader or `--loader` hook.

**Risk:** If Vite's internals change how built-in modules are resolved, the patches might not intercept calls. Mitigated by integration tests that verify hooks fire for both `import { exec } from "child_process"` and `require("child_process").exec` in a Vite-transformed context.

### 6. Dictionary pre-seeding via FuzzerConfig extension

**Decision:** Add a `detectorTokens: Buffer[]` field to `FuzzerConfig` (the NAPI boundary type). The TypeScript side collects tokens from all active detectors via `getTokens()`, serializes them as `Buffer[]`, and passes them through the NAPI constructor. The Rust side inserts them into LibAFL's `Tokens` state metadata alongside user dictionary tokens.

Detector tokens are also added to `TokenTracker.promoted` to prevent CmpLog from re-discovering them and wasting dictionary slots.

**Rationale:** Reuses the existing dictionary infrastructure. The Rust side already knows how to load tokens into state metadata and make them available to `TokenInsert`/`TokenReplace` havoc mutations. The only new code is accepting an additional token source at construction time.

**Alternative considered:** Writing detector tokens to a temporary dictionary file and passing it via `dictionaryPath`. This works but is indirect - it creates a file that needs cleanup, and it doesn't allow detector tokens to be marked as pre-promoted in the `TokenTracker`.

### 7. Configuration: detectors key in FuzzOptions with boolean | options union

**Decision:** Add a `detectors` key to `FuzzOptions`:

```typescript
detectors?: {
  prototypePollution?: boolean;
  commandInjection?: boolean;
  pathTraversal?: boolean | { sandboxRoot?: string };
}
```

Tier 2 detector fields (`redos`, `ssrf`, `unsafeEval`) are deferred - they will be added to the schema when their detectors are implemented. The schema silently ignores unknown keys for forward compatibility.

- Absent `detectors` key = use defaults (Tier 1 on)
- `true` = enable with defaults; `false` = disable; options object = enable with config
- Per-test options in `fuzz()` merge with global config (explicit `false` wins)

**Rationale:** Follows the existing pattern for `grimoire`, `unicode`, `redqueen` - optional boolean fields with sensible defaults. The `boolean | options` union keeps the simple case simple while allowing configuration for detectors that need it (path traversal sandbox root). The `goalString` option for command injection was considered but dropped - there's no practical reason to change the default goal string, and keeping the config simpler is preferred.

### 8. CLI -detectors flag with comma-separated syntax

**Decision:** The standalone CLI accepts `-detectors=<spec>` (single-hyphen, matching libFuzzer flag convention) where `<spec>` is a comma-separated list. When the flag is present, ALL detector defaults are disabled - only explicitly listed detectors are enabled:

```
-detectors=prototypePollution               # enable only prototypePollution
-detectors=                                 # disable all detectors
-detectors=pathTraversal.sandboxRoot=/var/www  # enable with option
```

This is parsed into the `FuzzOptions.detectors` object and passed to the child via `VITIATE_FUZZ_OPTIONS`.

**Rationale:** Consistent with libFuzzer-style CLI conventions. The self-contained semantics (flag presence disables all defaults, you get exactly what you list) avoid the complexity of `-` prefix disable syntax. The dotted syntax for options avoids needing separate flags per detector.

### 9. DetectorManager orchestrates lifecycle and configuration

**Decision:** A `DetectorManager` class owns the detector registry and lifecycle:

```typescript
class DetectorManager {
  constructor(config: FuzzOptions["detectors"]);
  getTokens(): Buffer[];
  setup(): void;
  beforeIteration(): void;
  afterIteration(): void;
  teardown(): void;
}
```

It resolves which detectors are active based on config (defaulting Tier 1 on, Tier 2 off), instantiates them with their options, and delegates lifecycle calls. The fuzz loop interacts only with `DetectorManager`, not individual detectors.

**Rationale:** Single point of coordination. The fuzz loop doesn't need to know how many detectors exist or how they're configured. Adding a new detector means implementing the `Detector` interface and registering it in the manager - no changes to the loop.

## Risks / Trade-offs

**[Prototype pollution snapshot overhead on hot loops]** The snapshot/diff runs once per iteration (~20 `Object.getOwnPropertyNames()` calls). At millions of iterations per second, this could become measurable. → **Mitigation:** Benchmark during implementation. If overhead exceeds 1%, sample every Nth iteration (still catches pollution deterministically since the input that caused it will be replayed during minimization).

**[Module hook interference with test infrastructure]** Hooks on `child_process` or `fs` could intercept calls made by Vitest, Vite, or the fuzzer itself - not just the target. → **Mitigation:** Hooks only check for detector conditions (goal string presence, path escape) during the window between `beforeIteration()` and the end of target execution. A `detectorActive` flag gates the check; calls outside the iteration window pass through unconditionally.

**[ESM module resolution changes in Vite]** If Vite changes how Node built-in modules are resolved, CJS patching might stop intercepting imports. → **Mitigation:** Integration tests verify hook interception in a Vite-transformed context. If Vite changes break this, fall back to `module.register()` ESM loader hooks.

**[Goal string false positives]** If a target legitimately processes strings containing `"vitiate_cmd_inject"` or `"vitiate_eval_inject"`, the detector fires incorrectly. → **Mitigation:** The goal strings are deliberately unusual (prefixed with `vitiate_`). Users can disable individual detectors if false positives occur. The probability of a real-world input containing these exact strings is negligible.

**[Supervisor crash recovery doesn't distinguish detector findings]** When the child dies from a signal and the parent recovers the input from shared memory, the parent doesn't know whether the input triggered a detector or an ordinary crash. → **Mitigation:** Signal deaths bypass detector logic entirely (detectors only fire in the child's JS execution). The parent writes a generic `crash-{hash}` artifact for signal deaths, which is correct - signal deaths are native crashes, not detector findings.
