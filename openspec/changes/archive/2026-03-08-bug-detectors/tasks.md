## 1. Framework Infrastructure

- [x] 1.1 Define `VulnerabilityError` class extending `Error` with `detectorName`, `vulnerabilityType`, and `context` properties
- [x] 1.2 Define `Detector` interface with `name`, `tier`, `getTokens()`, `setup()`, `beforeIteration()`, `afterIteration()`, `teardown()` members
- [x] 1.3 Implement module hooking utility: wrap/restore Node built-in module exports with iteration-window gating (`detectorActive` flag)
- [x] 1.4 Implement `DetectorManager` class: constructor resolves active detectors from config (Tier 1 default-on, Tier 2 default-off), delegates lifecycle calls, collects tokens

## 2. Detector Configuration

- [x] 2.1 Add `detectors` key to `FuzzOptionsSchema` in `config.ts` with Tier 1 detector fields (`prototypePollution`, `commandInjection` as boolean; `pathTraversal` as boolean | options) and Valibot validation. Schema silently ignores unknown keys for forward compatibility with future Tier 2 fields.
- [x] 2.2 Add `-detectors` flag parsing to `cli.ts`: comma-separated directives, dotted syntax for options; flag presence disables all defaults
- [x] 2.3 Pass parsed detector config through `VITIATE_FUZZ_OPTIONS` to child process

## 3. Dictionary Seeding (Rust Side)

- [x] 3.1 Add `detector_tokens: Option<Vec<Vec<u8>>>` field to `FuzzerConfig` in `vitiate-napi`
- [x] 3.2 Insert detector tokens into LibAFL `Tokens` state metadata in `Fuzzer::new()`, after user dictionary
- [x] 3.3 Ensure detector tokens are not re-promoted by CmpLog (add to promoted set to prevent duplication)

## 4. Fuzz Loop Integration

- [x] 4.1 Construct `DetectorManager` in `runFuzzLoop()` from resolved `FuzzOptions.detectors`
- [x] 4.2 Call `detectorManager.getTokens()` and pass result as `detectorTokens` in `FuzzerConfig`
- [x] 4.3 Call `detectorManager.setup()` before first iteration and `detectorManager.teardown()` after loop exit
- [x] 4.4 Wrap main iteration cycle: call `beforeIteration()` before `executeTarget()`, call `afterIteration()` after Ok exit, upgrade to Crash on `VulnerabilityError` throw
- [x] 4.5 Skip `afterIteration()` on timeout exits
- [x] 4.6 Wrap calibration re-runs with `beforeIteration()`/`afterIteration()` lifecycle; VulnerabilityError during calibration breaks the loop and writes artifact
- [x] 4.7 Wrap stage executions with `beforeIteration()`/`afterIteration()` lifecycle; VulnerabilityError during stage calls `abortStage()` and writes artifact without minimization

## 5. Artifact Handling

- [x] 5.1 Verify that `VulnerabilityError` throws produce standard `crash-{hash}` artifacts through the existing crash path (no code change expected — confirm behavior)

## 6. Reporter

- [x] 6.1 Display active detector names in the startup banner (e.g., "detectors: prototype-pollution, command-injection, path-traversal")

## 7. Prototype Pollution Detector

- [x] 7.1 Implement snapshot capture: `Object.getOwnPropertyNames()` + non-function value recording for all monitored prototypes
- [x] 7.2 Implement snapshot diff in `afterIteration()`: detect added, modified, or deleted non-function properties
- [x] 7.3 Implement prototype state restoration after detection (clean up pollution before next iteration)
- [x] 7.4 Implement `getTokens()` returning `__proto__`, `constructor`, `prototype`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__`

## 8. Command Injection Detector

- [x] 8.1 Implement `child_process` module hooks for `exec`, `execSync`, `execFile`, `execFileSync`, `spawn`, `spawnSync`, `fork`
- [x] 8.2 Implement goal string check: scan command string (first arg) and args array (second arg) for goal string `"vitiate_cmd_inject"`
- [x] 8.3 Implement `getTokens()` returning goal string and shell metacharacters

## 9. Path Traversal Detector

- [x] 9.1 Implement `fs` module hooks for single-path functions (`readFile`, `writeFile`, `open`, `access`, `stat`, `readdir`, `unlink`, `rmdir`, `mkdir`, `chmod`, `chown` + sync variants)
- [x] 9.2 Implement `fs` module hooks for dual-path functions (`copyFile`, `rename`, `link`, `symlink` + sync variants)
- [x] 9.3 Implement path resolution and sandbox escape check: `path.resolve()` + `startsWith(root + sep)` with prefix false-positive prevention
- [x] 9.4 Implement null byte detection in path arguments
- [x] 9.5 Implement `getTokens()` with static traversal tokens and config-dependent tokens derived from `sandboxRoot` depth

## 10. Tests

- [x] 10.1 Unit tests for `VulnerabilityError` (instanceof checks, property access, stack trace)
- [x] 10.2 Unit tests for `DetectorManager` (tier defaults, explicit enable/disable, options passthrough, lifecycle delegation order, teardown-after-error)
- [x] 10.3 Unit tests for module hooking utility (hook/restore, iteration window gating, multi-hook composition)
- [x] 10.4 Unit tests for prototype pollution detector (property addition, modification, function-value ignore, state restoration, tokens)
- [x] 10.5 Unit tests for command injection detector (goal string in exec, execSync, spawn args, no-match passthrough, tokens)
- [x] 10.6 Unit tests for path traversal detector (sandbox escape, within-sandbox passthrough, null byte, dual-path, prefix false positive prevention, config-dependent tokens)
- [x] 10.7 Unit tests for `-detectors` CLI flag parsing (enable, disable, `none`, dotted options, invalid name error)
- [x] 10.8 Unit tests for `FuzzOptions.detectors` schema validation (boolean, options object, empty object, absent)
- [x] 10.9 Unit tests confirming `VulnerabilityError` crashes produce standard `crash-{hash}` artifacts
- [x] 10.10 Integration test: fuzz loop with prototype pollution detector finds planted bug in a target that does `obj[key] = value` on untrusted input. This is a fuzz-pipeline test — use a large safety margin (obvious bug, short timeout) to ensure deterministic pass.
