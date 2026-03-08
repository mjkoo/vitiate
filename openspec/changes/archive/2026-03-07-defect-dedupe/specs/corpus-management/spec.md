## ADDED Requirements

### Requirement: Replace artifact atomically

The system SHALL provide a `replaceArtifact(oldPath: string, newData: Buffer, kind: "crash" | "timeout"): string` function that atomically replaces an existing artifact file with new data.

The replacement SHALL:

1. Compute the new content hash (SHA-256 hex digest of `newData`).
2. Derive the new artifact path by replacing the hash portion of `oldPath` with the new hash (preserving the prefix and kind).
3. Write `newData` to a temporary file in the same directory as `oldPath`.
4. Rename the temporary file to the new artifact path (atomic on POSIX, near-atomic on Windows).
5. Delete the old artifact file if the new path differs from the old path.
6. Return the new artifact path.

If the new path is identical to the old path (same content hash), the function SHALL overwrite atomically via rename and return the same path.

#### Scenario: Replace crash artifact with smaller input

- **WHEN** `replaceArtifact("./out/crash-aaa", smallerBuffer, "crash")` is called
- **THEN** a new file `./out/crash-bbb` SHALL be created atomically (where `bbb` is the SHA-256 of `smallerBuffer`)
- **AND** the old file `./out/crash-aaa` SHALL be deleted
- **AND** the returned path SHALL be `./out/crash-bbb`

#### Scenario: Atomic write prevents partial reads

- **WHEN** `replaceArtifact` is called
- **THEN** the new data SHALL be written to a temporary file first
- **AND** the temporary file SHALL be renamed to the target path
- **AND** at no point SHALL a reader observe a partially-written artifact file

#### Scenario: Old file deleted only when paths differ

- **WHEN** `replaceArtifact("./out/crash-aaa", newData, "crash")` is called
- **AND** the SHA-256 of `newData` differs from `aaa`
- **THEN** `./out/crash-aaa` SHALL be deleted after the new file is in place

#### Scenario: Same content hash overwrites in place

- **WHEN** `replaceArtifact("./out/crash-aaa", data, "crash")` is called
- **AND** the SHA-256 of `data` equals `aaa`
- **THEN** the file SHALL be overwritten atomically
- **AND** no separate delete is needed
- **AND** the returned path SHALL be `./out/crash-aaa`
