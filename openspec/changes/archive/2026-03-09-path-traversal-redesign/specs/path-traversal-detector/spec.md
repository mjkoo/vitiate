## MODIFIED Requirements

### Requirement: Path traversal detection via filesystem hooks

The path traversal detector SHALL hook `fs` and `fs/promises` module functions and check whether resolved path arguments violate a configured access policy. If a path is denied by the policy, the detector SHALL throw a `VulnerabilityError` immediately (during target execution).

The detector SHALL have `name: "path-traversal"` and `tier: 1`.

The access policy SHALL be defined by two configuration options:

- `allowedPaths` (string[], default: `["/"]`): Paths (and their subtrees) that are permitted. Each entry is resolved to an absolute path at construction time.
- `deniedPaths` (string[], default: `["/etc/passwd"]`): Paths (and their subtrees) that are denied. Each entry is resolved to an absolute path at construction time. Denied takes priority over allowed.

Policy evaluation for a resolved path SHALL proceed in priority order:
1. If the path matches any `deniedPaths` entry → **deny** (throw VulnerabilityError)
2. If the path matches any `allowedPaths` entry → **allow** (pass through)
3. Otherwise → **deny**

#### Scenario: Default policy denies /etc/passwd

- **WHEN** the detector is constructed with default options
- **AND** the fuzz target calls `fs.readFileSync("/etc/passwd")`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL include the function name, the path argument, the resolved path, and the denied entry that matched

#### Scenario: Default policy allows arbitrary paths outside deniedPaths

- **WHEN** the detector is constructed with default options
- **AND** the fuzz target calls `fs.readFileSync("/tmp/data.txt")`
- **THEN** the hook SHALL call through to the original function

#### Scenario: Custom allowedPaths restricts access

- **WHEN** the detector is configured with `{ allowedPaths: ["/var/www"] }`
- **AND** the fuzz target calls `fs.readFileSync("/etc/hosts")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Custom allowedPaths permits subtree

- **WHEN** the detector is configured with `{ allowedPaths: ["/var/www"] }`
- **AND** the fuzz target calls `fs.readFileSync("/var/www/index.html")`
- **THEN** the hook SHALL call through to the original function

#### Scenario: deniedPaths overrides allowedPaths

- **WHEN** the detector is configured with `{ allowedPaths: ["/tmp"], deniedPaths: ["/tmp/secrets"] }`
- **AND** the fuzz target calls `fs.readFileSync("/tmp/secrets/key.pem")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Allowed path under denied parent is still denied

- **WHEN** the detector is configured with `{ allowedPaths: ["/"], deniedPaths: ["/etc"] }`
- **AND** the fuzz target calls `fs.readFileSync("/etc/hosts")`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** there is no way to re-allow `/etc/hosts` without removing `/etc` from deniedPaths

#### Scenario: Null byte in path

- **WHEN** the fuzz target calls `fs.readFile("safe.txt\x00../../etc/passwd", callback)`
- **AND** the path contains a null byte
- **THEN** the detector's path checking logic SHALL throw a `VulnerabilityError` before evaluating the access policy
- **AND** the error's `context` SHALL note the null byte presence (the context SHALL NOT include a `sandboxRoot` field)

### Requirement: Hooked fs functions

The detector SHALL hook the following exports from both the `fs` and `fs/promises` modules (both callback/sync variants from `fs`, and promise-returning variants from `fs/promises`):

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

For `fs/promises`, the sync variants do not exist. The detector SHALL hook only the async function names that are present on the `fs/promises` module object (e.g., `readFile`, `writeFile`, `stat`, `copyFile`, etc.). Presence SHALL be determined by a runtime check (e.g., `functionName in module`) rather than a hardcoded list, so the hooks adapt to the Node.js version's exports.

Note: `require("fs").promises` returns the same object as `require("fs/promises")`. Hooking `fs/promises` via `installHook` patches the module object's properties, so calls through `fs.promises.readFile(...)` are also intercepted. This is a side effect of the shared object identity, not an explicit design goal — the detector does not separately hook the `fs.promises` property chain.

#### Scenario: Dual-path function with traversal in destination

- **WHEN** the detector is configured with `{ deniedPaths: ["/etc/crontab"] }`
- **AND** the fuzz target calls `fs.copyFile("safe.txt", "/etc/crontab", callback)`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the error's `context` SHALL identify which argument (source or destination) triggered the detection

#### Scenario: fs/promises hook intercepts async read

- **WHEN** the fuzz target calls `fsPromises.readFile("/etc/passwd")`
- **AND** `/etc/passwd` is in `deniedPaths`
- **THEN** the detector SHALL throw a `VulnerabilityError`
- **AND** the original `readFile` function SHALL NOT be called

#### Scenario: fs/promises hooks are independent from fs hooks

- **WHEN** the detector is set up
- **THEN** `require("fs").readFile` and `require("fs/promises").readFile` SHALL both be hooked independently
- **AND** restoring one SHALL NOT affect the other

### Requirement: Path resolution logic

The detector SHALL resolve path arguments using `path.resolve()` and then evaluate the resolved absolute path against the access policy. Both `allowedPaths` and `deniedPaths` entries SHALL be resolved to absolute paths at construction time.

Matching SHALL use separator-aware prefix comparison: a path matches an entry if `resolvedPath === entry` or `resolvedPath.startsWith(entry + path.sep)`. This prevents prefix false positives (e.g., `/var/www-evil` SHALL NOT match an entry of `/var/www`).

#### Scenario: Prefix false positive prevention

- **WHEN** `allowedPaths` contains `/var/www`
- **AND** the fuzz target accesses `/var/www-evil/data.txt`
- **THEN** the path SHALL NOT match the `/var/www` entry
- **AND** the detector SHALL throw a `VulnerabilityError` (path is not allowed)

#### Scenario: Exact path match

- **WHEN** `deniedPaths` contains `/etc/passwd`
- **AND** the fuzz target accesses exactly `/etc/passwd`
- **THEN** the path SHALL match the denied entry

#### Scenario: Subtree match via separator

- **WHEN** `allowedPaths` contains `/var/www`
- **AND** the fuzz target accesses `/var/www/uploads/file.txt`
- **THEN** the path SHALL match the `/var/www` entry (allowed)

### Requirement: Path traversal dictionary tokens

The detector's `getTokens()` SHALL return:

Static tokens (always included):
- `"../"`, `"../../"`, `"../../../"`
- `"..\\"`
- `"\x00"` (null byte)
- `"%2e%2e%2f"`, `"%2e%2e/"`, `"..%2f"` (URL-encoded variants)

Policy-dependent tokens:
- All resolved `deniedPaths` entries (e.g., `"/etc/passwd"` with the default configuration)

The detector SHALL NOT include `allowedPaths` entries, the sandbox root path itself, or depth-computed traversal chains in the token set.

#### Scenario: Default tokens include denied paths

- **WHEN** the detector is constructed with default options
- **THEN** `getTokens()` SHALL include `"/etc/passwd"`
- **AND** `getTokens()` SHALL include `"../"`
- **AND** `getTokens()` SHALL NOT include any path derived from the detector's own filesystem depth

#### Scenario: Custom denied paths appear in tokens

- **WHEN** the detector is configured with `{ deniedPaths: ["/etc/passwd", "/proc/self/environ"] }`
- **THEN** `getTokens()` SHALL include `"/etc/passwd"` and `"/proc/self/environ"`

## REMOVED Requirements

### Requirement: Config-dependent tokens match sandbox depth

**Reason**: The sandbox-depth-based token computation (e.g., `"../../../etc/passwd"` for a three-component path) couples the dictionary to the fuzzer's own filesystem layout. Generic traversal tokens (`../`, `../../`, `../../../`) combined with `deniedPaths` entries provide better coverage without environment dependency.

**Migration**: The static tokens `"../"`, `"../../"`, `"../../../"` remain. The mutator discovers the correct chain length through composition. Denied paths are included as tokens directly.
