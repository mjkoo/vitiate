## MODIFIED Requirements

### Requirement: Regression mode behavior

In regression mode (no `VITIATE_FUZZ`), the `fuzz()` function SHALL load the corpus for the test and run each entry as a sub-test via Vitest. Each corpus entry produces a separate assertion - if the target throws for any entry, the test fails.

The regression corpus SHALL be loaded from three testdata subdirectories plus the cached corpus:

1. `<dataDir>/testdata/<hashdir>/seeds/` - user-provided seed inputs
2. `<dataDir>/testdata/<hashdir>/crashes/` - crash artifact files
3. `<dataDir>/testdata/<hashdir>/timeouts/` - timeout artifact files
4. `<dataDir>/corpus/<hashdir>/` - cached corpus entries

Where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root.

If no corpus entries exist across all four locations, the test SHALL run the target once with an empty `Buffer` as a smoke test.

The regression replay loop SHALL use the same `endIteration(targetCompletedOk)` protocol as the fuzz loop for detector lifecycle management. For each corpus entry:

1. Call `detectorManager.beforeIteration()`.
2. Execute the target.
3. Determine whether the target completed normally (no exception) or crashed (threw).
4. Call `detectorManager.endIteration(targetCompletedOk)`. If the target threw, `endIteration(false)` ensures detector state is reset without checking for new findings. If the target completed normally and `endIteration(true)` returns a `VulnerabilityError`, that is the failure for this entry.
5. The first error (target exception or detector finding) is the failure for this entry.

The regression loop SHALL NOT import or call `setDetectorActive()` directly. All detector active flag management SHALL be handled internally by `DetectorManager`.

#### Scenario: Replay corpus entries

- **WHEN** `fuzz("parse", target)` runs in regression mode
- **AND** `.vitiate/testdata/<hashdir>/seeds/` contains files `seed1` and `seed2`
- **AND** `.vitiate/testdata/<hashdir>/crashes/` contains `crash-abc123`
- **THEN** `target` is called with the contents of `seed1`, `seed2`, and `crash-abc123`

#### Scenario: Corpus entry triggers error

- **WHEN** a corpus entry causes the target to throw
- **THEN** the test fails with the error message and the corpus entry index

#### Scenario: No corpus entries anywhere

- **WHEN** `fuzz("new-target", target)` runs in regression mode
- **AND** no seed, crash, timeout, or cached corpus entries exist
- **THEN** `target` is called once with an empty Buffer
- **AND** the test passes if the target does not throw
