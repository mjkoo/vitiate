## MODIFIED Requirements

### Requirement: Regression mode behavior

In regression mode (no `VITIATE_FUZZ`), the `fuzz()` function SHALL load the corpus for the test and run each entry as a sub-test via Vitest. Each corpus entry produces a separate assertion - if the target throws for any entry, the test fails.

If no corpus directory exists or the directory is empty, the test SHALL run the target once with an empty `Buffer` as a smoke test.

The regression replay loop SHALL use the same `endIteration(targetCompletedOk)` protocol as the fuzz loop for detector lifecycle management. For each corpus entry:

1. Call `detectorManager.beforeIteration()`.
2. Execute the target.
3. Determine whether the target completed normally (no exception) or crashed (threw).
4. Call `detectorManager.endIteration(targetCompletedOk)`. If the target threw, `endIteration(false)` ensures detector state is reset without checking for new findings. If the target completed normally and `endIteration(true)` returns a `VulnerabilityError`, that is the failure for this entry.
5. The first error (target exception or detector finding) is the failure for this entry.

The regression loop SHALL NOT import or call `setDetectorActive()` directly. All detector active flag management SHALL be handled internally by `DetectorManager`.

#### Scenario: Replay corpus entries

- **WHEN** `fuzz("parse", target)` runs in regression mode
- **AND** `testdata/fuzz/parse/` contains files `seed1` and `seed2`
- **THEN** `target` is called with the contents of `seed1` and `seed2`
- **AND** both executions are reported in Vitest's test output

#### Scenario: Corpus entry triggers error

- **WHEN** a corpus entry causes the target to throw
- **THEN** the test fails with the error message and the corpus entry filename

#### Scenario: No corpus directory

- **WHEN** `fuzz("new-target", target)` runs in regression mode
- **AND** no `testdata/fuzz/new-target/` directory exists
- **THEN** `target` is called once with an empty Buffer
- **AND** the test passes if the target does not throw

#### Scenario: Regression mode detects prototype pollution after target crash

- **WHEN** a corpus entry causes both prototype pollution and a target exception
- **THEN** `detectorManager.endIteration(false)` SHALL be called
- **AND** `resetIteration()` SHALL restore the polluted prototypes
- **AND** the target exception SHALL be the reported failure (detector finding is not checked for crash exits)

#### Scenario: Regression mode detects prototype pollution without target crash

- **WHEN** a corpus entry causes prototype pollution but the target returns normally
- **THEN** `detectorManager.endIteration(true)` SHALL return a `VulnerabilityError`
- **AND** `resetIteration()` SHALL restore the polluted prototypes
- **AND** the test SHALL fail with the `VulnerabilityError`

#### Scenario: Regression mode detector lifecycle matches fuzz mode

- **WHEN** a corpus entry is replayed in regression mode
- **THEN** the detector lifecycle protocol (`beforeIteration()` → execute → `endIteration(targetCompletedOk)`) SHALL be identical to the fuzz loop's protocol
- **AND** detector state reset SHALL occur for both Ok and non-Ok exits
