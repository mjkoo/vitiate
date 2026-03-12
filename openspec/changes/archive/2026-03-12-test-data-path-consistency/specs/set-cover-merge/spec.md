## MODIFIED Requirements

### Requirement: Vitest optimize mode

When the `VITIATE_OPTIMIZE=1` environment variable is set, the system SHALL enter optimize mode instead of fuzzing mode. For each fuzz test discovered by Vitest:

1. Load seed corpus from `<dataDir>/testdata/<hashdir>/seeds/`.
2. Load crash artifacts from `<dataDir>/testdata/<hashdir>/crashes/`.
3. Load timeout artifacts from `<dataDir>/testdata/<hashdir>/timeouts/`.
4. Load cached corpus from `<dataDir>/corpus/<hashdir>/`.
5. Replay all seed, crash, and timeout entries, collect edges, add to a pre-covered set.
6. Replay all cached entries, collect edges.
7. Run set cover over cached entries only, with the seed/crash/timeout edges as pre-covered.
8. Delete cached entries not in the surviving set.
9. Report per-test stats to stderr.

Where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root.

Seed, crash, and timeout entries SHALL never be removed. They are user-curated or machine-discovered regression tests committed to version control. Only cached corpus entries are subject to minimization.

#### Scenario: Optimize reduces cached corpus

- **WHEN** `VITIATE_OPTIMIZE=1 pnpm vitest run` is executed
- **AND** test "parsesJson" has 10 seed entries, 3 crash entries, and 300 cached entries
- **AND** set cover selects 40 cached entries (with seed+crash pre-coverage)
- **THEN** 260 cached entry files are deleted from `.vitiate/corpus/<hashdir>/`
- **AND** seed and crash entries remain untouched in `.vitiate/testdata/<hashdir>/`

#### Scenario: Seeds and crashes cover all edges

- **WHEN** seed and crash corpus entries cover all edges that cached entries also cover
- **THEN** all cached entries are removed (fully redundant)
- **AND** seed and crash entries remain untouched

#### Scenario: Empty cached corpus

- **WHEN** a test has seed entries but no cached entries
- **THEN** optimize is a no-op for that test (nothing to remove)

#### Scenario: Test passes after optimization

- **WHEN** optimization completes for a test
- **THEN** the Vitest test result is "pass" (not "fail")
