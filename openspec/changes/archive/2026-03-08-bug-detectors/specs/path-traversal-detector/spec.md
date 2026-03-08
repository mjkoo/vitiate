## ADDED Requirements

### Requirement: Path traversal detection via filesystem hooks

The path traversal detector SHALL hook `fs` module functions and check whether resolved path arguments escape a configured sandbox root directory. If a path escapes the sandbox, the detector SHALL throw a `VulnerabilityError` immediately (during target execution).

The detector SHALL have `name: "path-traversal"` and `tier: 1`.

The default sandbox root SHALL be `process.cwd()`. It MAY be overridden via the `sandboxRoot` option, which SHALL be resolved relative to the test file's directory.

#### Scenario: Detect traversal escaping cwd

- **WHEN** the fuzz target calls `fs.readFile("../../etc/passwd", callback)`
- **AND** the resolved path escapes `process.cwd()`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include the function name (`"readFile"`), the original path argument, the resolved absolute path, and the sandbox root

#### Scenario: Path within sandbox is allowed

- **WHEN** the fuzz target calls `fs.readFile("./data/file.txt", callback)`
- **AND** the resolved path is within the sandbox root
- **THEN** the hook SHALL call through to the original `readFile` function

#### Scenario: Custom sandbox root

- **WHEN** the detector is configured with `{ sandboxRoot: "./uploads" }`
- **AND** the fuzz target calls `fs.readFile("../secret.txt", callback)`
- **AND** the resolved path escapes the `./uploads` directory
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Null byte in path

- **WHEN** the fuzz target calls `fs.readFile("safe.txt\x00../../etc/passwd", callback)`
- **AND** the path contains a null byte
- **THEN** the detector's path checking logic SHALL throw a `VulnerabilityError` before evaluating sandbox escape
- **AND** the error's `context` SHALL note the null byte presence

### Requirement: Hooked fs functions

The detector SHALL hook the following `fs` module exports (both callback and sync variants):

Single-path functions:
- `readFile` / `readFileSync`
- `writeFile` / `writeFileSync`
- `appendFile` / `appendFileSync`
- `open` / `openSync`
- `access` / `accessSync`
- `stat` / `statSync` / `lstat` / `lstatSync`
- `readdir` / `readdirSync`
- `unlink` / `unlinkSync`
- `rmdir` / `rmdirSync`
- `mkdir` / `mkdirSync`
- `chmod` / `chmodSync`
- `chown` / `chownSync`

Dual-path functions (both path arguments SHALL be checked):
- `copyFile` / `copyFileSync`
- `rename` / `renameSync`
- `link` / `linkSync`
- `symlink` / `symlinkSync`

#### Scenario: Dual-path function with traversal in destination

- **WHEN** the fuzz target calls `fs.copyFile("safe.txt", "../../etc/crontab", callback)`
- **AND** the destination path escapes the sandbox root
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL identify which argument (source or destination) triggered the detection

### Requirement: Path resolution logic

The detector SHALL resolve path arguments using `path.resolve()` and then check whether the resolved absolute path starts with the sandbox root (also resolved to an absolute path). The comparison SHALL use `resolvedPath.startsWith(resolvedRoot + path.sep)` or `resolvedPath === resolvedRoot` to prevent prefix false positives (e.g., `/var/www-evil` matching sandbox root `/var/www`).

#### Scenario: Prefix false positive prevention

- **WHEN** the sandbox root is `/var/www`
- **AND** the fuzz target accesses `/var/www-evil/data.txt`
- **THEN** the detector SHALL NOT throw a `VulnerabilityError` (the path is outside the sandbox but the check must not match on string prefix alone)

### Requirement: Path traversal dictionary tokens

The detector's `getTokens()` SHALL return:

Static tokens (always included):
- `"../"`, `"../../"`, `"../../../"`
- `"..\\"`
- `"\x00"` (null byte)
- `"%2e%2e%2f"`, `"%2e%2e/"`, `"..%2f"` (URL-encoded variants)

Config-dependent tokens (when `sandboxRoot` is set):
- The sandbox root path itself
- A traversal sequence with enough `../` repetitions to escape the sandbox root's depth, followed by `etc/passwd`

#### Scenario: Config-dependent tokens match sandbox depth

- **WHEN** the detector is configured with `{ sandboxRoot: "/var/www/uploads" }`
- **THEN** `getTokens()` SHALL include `"../../../etc/passwd"` (three levels to escape a three-component path)
