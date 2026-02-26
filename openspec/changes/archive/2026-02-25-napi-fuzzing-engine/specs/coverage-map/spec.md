## ADDED Requirements

### Requirement: Allocate coverage map from Rust

The system SHALL provide a `createCoverageMap(size: number)` NAPI function that allocates
a byte buffer of the given size in Rust and returns it as a Node.js `Buffer`. The returned
Buffer and the Rust-side allocation SHALL reference the same memory (zero-copy).

#### Scenario: Create default-sized coverage map

- **WHEN** `createCoverageMap(65536)` is called
- **THEN** a `Buffer` of length 65536 is returned with all bytes initialized to zero

#### Scenario: Buffer is writable from JavaScript

- **WHEN** a coverage map Buffer is created and JavaScript writes `covMap[42] = 1`
- **THEN** the byte at index 42 reads as 1 from both the JavaScript Buffer and the
  underlying Rust memory

#### Scenario: Multiple coverage maps are independent

- **WHEN** two coverage maps are created via separate `createCoverageMap()` calls
- **THEN** writing to one map SHALL NOT affect the contents of the other

### Requirement: Coverage map zeroing

The coverage map SHALL be zeroed by Rust at the end of each `reportResult()` call. The
caller SHALL NOT need to manually zero the map between iterations.

#### Scenario: Map is clean after reportResult

- **WHEN** JavaScript writes nonzero bytes to the coverage map and calls
  `fuzzer.reportResult(ExitKind.Ok)`
- **THEN** all bytes in the coverage map Buffer are zero after `reportResult()` returns

### Requirement: Coverage map size validation

The system SHALL reject coverage map sizes that are zero.

#### Scenario: Zero size rejected

- **WHEN** `createCoverageMap(0)` is called
- **THEN** the function SHALL throw an error
