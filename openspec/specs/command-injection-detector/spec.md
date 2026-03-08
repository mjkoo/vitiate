## Purpose

Bug detector that hooks `child_process` module functions to detect command injection vulnerabilities during fuzzing.

## Requirements

### Requirement: Command injection detection via module hooks

The command injection detector SHALL hook all `child_process` execution functions and check whether the command argument contains a detector-specific goal string. If the goal string is found, the detector SHALL throw a `VulnerabilityError` immediately (during target execution, not in `afterIteration()`).

The detector SHALL have `name: "command-injection"` and `tier: 1`.

The goal string SHALL be `"vitiate_cmd_inject"`.

#### Scenario: Detect goal string in exec command

- **WHEN** the fuzz target calls `child_process.exec("ls; vitiate_cmd_inject")`
- **THEN** the detector SHALL throw a `VulnerabilityError` before the command executes
- **AND** the error's `context` SHALL include the function name (`"exec"`), the full command string, and the goal string

#### Scenario: Detect goal string in execSync command

- **WHEN** the fuzz target calls `child_process.execSync("echo vitiate_cmd_inject")`
- **THEN** the detector SHALL throw a `VulnerabilityError` before the command executes

#### Scenario: No goal string present

- **WHEN** the fuzz target calls `child_process.exec("ls -la")`
- **AND** the command does not contain the goal string
- **THEN** the hook SHALL call through to the original `exec` function

### Requirement: Hooked child_process functions

The detector SHALL hook the following `child_process` exports:

- `exec`
- `execSync`
- `execFile`
- `execFileSync`
- `spawn`
- `spawnSync`
- `fork`

For `exec` and `execSync`, the goal string SHALL be checked in the first argument (command string). For `execFile`, `execFileSync`, `spawn`, `spawnSync`, and `fork`, the goal string SHALL be checked in both the first argument (file/command) and the `args` array (second argument, if present).

#### Scenario: Goal string in spawn args array

- **WHEN** the fuzz target calls `child_process.spawn("sh", ["-c", "vitiate_cmd_inject"])`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include the function name (`"spawn"`) and the args array

### Requirement: Command injection dictionary tokens

The detector's `getTokens()` SHALL return:

- The goal string (`"vitiate_cmd_inject"`)
- Shell metacharacters: `";"`, `"|"`, `"&&"`, `"||"`, `` "`" ``, `"$("`, `">"`, `"<"`, `"\n"`

#### Scenario: Tokens include goal string and metacharacters

- **WHEN** `getTokens()` is called with default configuration
- **THEN** the returned array SHALL contain `"vitiate_cmd_inject"` and at least the nine shell metacharacter tokens listed above
