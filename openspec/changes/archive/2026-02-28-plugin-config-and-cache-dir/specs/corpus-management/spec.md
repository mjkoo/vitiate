## MODIFIED Requirements

### Requirement: Cached corpus loading

The system SHALL provide a function to load cached corpus entries from the cache directory. The cache directory SHALL be resolved using the following precedence:

1. The `VITIATE_CACHE_DIR` environment variable, if set. If the value is a relative path, it SHALL be resolved relative to `VITIATE_PROJECT_ROOT` (if set) or `process.cwd()`.
2. `.vitiate-corpus/` resolved relative to `VITIATE_PROJECT_ROOT`, if set.
3. `.vitiate-corpus/` resolved relative to `process.cwd()` (fallback).

Cached entries are stored at `{cacheDir}/{testName}/{hash}`.

#### Scenario: Load cached corpus

- **WHEN** `.vitiate-corpus/parse/` contains files `a1b2c3d4` and `e5f6g7h8`
- **THEN** two `Buffer` values are returned

#### Scenario: Custom cache directory via env var

- **WHEN** `VITIATE_CACHE_DIR=/tmp/fuzz-cache` is set
- **THEN** cached entries are loaded from `/tmp/fuzz-cache/parse/`

#### Scenario: Cache directory does not exist

- **WHEN** the cache directory for a test does not exist
- **THEN** an empty array is returned (no error thrown)

#### Scenario: Cache dir resolves to project root when plugin is active

- **WHEN** `VITIATE_PROJECT_ROOT=/home/user/project` is set (by the vitiate plugin)
- **AND** `VITIATE_CACHE_DIR` is not set
- **THEN** the cache directory is `/home/user/project/.vitiate-corpus`

#### Scenario: Relative VITIATE_CACHE_DIR resolves against project root

- **WHEN** `VITIATE_CACHE_DIR=.my-corpus` is set
- **AND** `VITIATE_PROJECT_ROOT=/home/user/project` is set
- **THEN** the cache directory is `/home/user/project/.my-corpus`

#### Scenario: Fallback to cwd when no project root

- **WHEN** `VITIATE_PROJECT_ROOT` is not set
- **AND** `VITIATE_CACHE_DIR` is not set
- **THEN** the cache directory is `path.resolve(".vitiate-corpus")` (relative to cwd)
