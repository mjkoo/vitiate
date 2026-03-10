## Purpose

Bug detector that hooks Node.js HTTP request APIs to detect server-side request forgery (SSRF) vulnerabilities during fuzzing. Validates target hosts against configurable blocklist/allowlist supporting CIDR ranges, IPs, hostnames, and wildcard domains.

## Requirements

### Requirement: SSRF detection via HTTP request hooks

The SSRF detector SHALL hook Node.js built-in HTTP request APIs and check whether the target hostname/IP of the request matches a blocked host specification. If the host is blocked (and not allowed), the detector SHALL throw a `VulnerabilityError` immediately (during target execution).

The detector SHALL have `name: "ssrf"` and `tier: 2`.

The detector SHALL accept two configuration options:

- `blockedHosts` (string[], default: `[]`): Additional host specifications to block, extending the built-in blocklist. Each entry SHALL be parsed as one of: IPv4 address, IPv6 address, IPv4 CIDR, IPv6 CIDR, hostname, or wildcard domain.
- `allowedHosts` (string[], default: `[]`): Host specifications to allow, overriding the blocklist (including built-ins). Same format as `blockedHosts`.

Policy evaluation for a request hostname SHALL proceed in priority order:
1. If the host matches any `allowedHosts` entry -> **allow** (pass through)
2. If the host matches any `blockedHosts` entry or any built-in blocklist entry -> **block** (throw VulnerabilityError)
3. Otherwise -> **allow**

#### Scenario: Detect request to loopback IPv4

- **WHEN** the SSRF detector is enabled with default options
- **AND** the fuzz target calls `http.request("http://127.0.0.1/admin")`
- **THEN** the detector SHALL throw a `VulnerabilityError` before the request is made
- **AND** the error's `vulnerabilityType` SHALL be `"SSRF"`
- **AND** the error's `context` SHALL include the function name, the target hostname, and the matched blocklist entry

#### Scenario: Detect request to RFC 1918 private IP

- **WHEN** the fuzz target calls `fetch("http://10.0.0.1/internal")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Detect request to cloud metadata endpoint

- **WHEN** the fuzz target calls `http.get("http://169.254.169.254/latest/meta-data/")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Detect request to GCP metadata hostname

- **WHEN** the fuzz target calls `fetch("http://metadata.google.internal/computeMetadata/v1/")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Allow request to public host

- **WHEN** the fuzz target calls `fetch("https://api.example.com/data")`
- **AND** `api.example.com` does not match any blocklist entry
- **THEN** the hook SHALL call through to the original function

#### Scenario: User-configured blockedHosts extends built-in list

- **WHEN** the detector is configured with `{ blockedHosts: ["internal.corp.example.com"] }`
- **AND** the fuzz target calls `fetch("http://internal.corp.example.com/api")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: allowedHosts overrides blocklist

- **WHEN** the detector is configured with `{ allowedHosts: ["10.0.0.5"] }`
- **AND** the fuzz target calls `http.request("http://10.0.0.5/api")`
- **THEN** the hook SHALL call through to the original function
- **AND** no `VulnerabilityError` SHALL be thrown

#### Scenario: Hook inactive outside iteration window

- **WHEN** an HTTP request API is called outside the iteration window
- **THEN** the hook SHALL pass through to the original function without checking the host

### Requirement: Built-in blocklist

The SSRF detector SHALL include a built-in blocklist of private and reserved IP ranges that is always active. This list is not configurable away — user `blockedHosts` extend it, user `allowedHosts` can carve exceptions from it.

The built-in blocklist SHALL include:

| Entry | Description |
|---|---|
| `127.0.0.0/8` | IPv4 loopback |
| `10.0.0.0/8` | RFC 1918 private |
| `172.16.0.0/12` | RFC 1918 private |
| `192.168.0.0/16` | RFC 1918 private |
| `169.254.0.0/16` | IPv4 link-local |
| `100.64.0.0/10` | RFC 6598 shared address space (CGN) |
| `0.0.0.0/8` | "This network" |
| `::1/128` | IPv6 loopback |
| `fc00::/7` | IPv6 unique local address |
| `fe80::/10` | IPv6 link-local |
| `localhost` | Loopback hostname (not caught by CIDR rules since matching is on raw hostname strings, not resolved IPs) |
| `169.254.169.254` | Cloud metadata endpoint (AWS, GCP, Azure) |
| `metadata.google.internal` | GCP metadata hostname |

#### Scenario: All RFC 1918 ranges are blocked by default

- **WHEN** the SSRF detector is enabled with default options
- **THEN** requests to `10.x.x.x`, `172.16.x.x` through `172.31.x.x`, and `192.168.x.x` SHALL be blocked

#### Scenario: IPv6 loopback is blocked

- **WHEN** the fuzz target calls `http.request("http://[::1]:8080/admin")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

#### Scenario: CGN shared address space is blocked

- **WHEN** the fuzz target calls `fetch("http://100.100.100.100/internal")`
- **THEN** the detector SHALL throw a `VulnerabilityError`

### Requirement: Host matching utility

The system SHALL provide a `HostMatcher` class (or equivalent) that compiles a list of host specification strings into an efficient matching structure at construction time. The matcher SHALL support the following specification formats:

| Format | Example | Matches |
|---|---|---|
| IPv4 address | `192.168.1.1` | Exact IP match |
| IPv6 address | `::1` or `[::1]` | Exact IP match (brackets stripped if present) |
| IPv4 CIDR | `10.0.0.0/8` | Any IPv4 address in the CIDR range |
| IPv6 CIDR | `fe80::/10` | Any IPv6 address in the CIDR range |
| Hostname | `metadata.google.internal` | Exact hostname match (case-insensitive) |
| Wildcard domain | `*.corp.example.com` | Any subdomain of `corp.example.com`, but NOT `corp.example.com` itself |

The `matches(hostname: string)` method SHALL return the specification string of the first matching rule (e.g., `"10.0.0.0/8"`, `"*.corp.example.com"`) or `null` if no rule matches. Each compiled rule SHALL retain its original specification string for this purpose. The matching algorithm SHALL:
1. Strip brackets from IPv6 literals (e.g., `[::1]` -> `::1`).
2. Try to parse the hostname as an IP address. If it is a valid IP:
   - Check against all IP-based rules (exact IP match and CIDR containment).
3. If the hostname is not a valid IP:
   - Check against exact hostname rules (case-insensitive string comparison).
   - Check against wildcard domain rules: `*.example.com` matches any hostname ending in `.example.com` with at least one additional label (e.g., `foo.example.com` matches but `example.com` does not).

IPv4 CIDR containment SHALL be computed using 32-bit unsigned integer arithmetic: parse the address and network base to integers, compute the mask from the prefix length, and check `(address & mask) === (network & mask)`.

IPv6 CIDR containment SHALL be computed using `BigInt` 128-bit arithmetic: parse the address and network base to `BigInt` values, compute the mask from the prefix length, and check `(address & mask) === (network & mask)`.

The matcher SHALL throw an error at construction time if a host specification string cannot be parsed as any of the supported formats (invalid CIDR prefix length, malformed IP address, etc.).

#### Scenario: Match IPv4 address against CIDR range

- **WHEN** a `HostMatcher` is constructed with `["10.0.0.0/8"]`
- **AND** `matches("10.255.0.1")` is called
- **THEN** it SHALL return `"10.0.0.0/8"`

#### Scenario: IPv4 address outside CIDR range does not match

- **WHEN** a `HostMatcher` is constructed with `["10.0.0.0/8"]`
- **AND** `matches("11.0.0.1")` is called
- **THEN** it SHALL return `null`

#### Scenario: Match IPv6 address against CIDR range

- **WHEN** a `HostMatcher` is constructed with `["fe80::/10"]`
- **AND** `matches("fe80::1")` is called
- **THEN** it SHALL return `"fe80::/10"`

#### Scenario: Match exact hostname case-insensitively

- **WHEN** a `HostMatcher` is constructed with `["Metadata.Google.Internal"]`
- **AND** `matches("metadata.google.internal")` is called
- **THEN** it SHALL return `"Metadata.Google.Internal"`

#### Scenario: Wildcard domain matches subdomain

- **WHEN** a `HostMatcher` is constructed with `["*.corp.example.com"]`
- **AND** `matches("api.corp.example.com")` is called
- **THEN** it SHALL return `"*.corp.example.com"`

#### Scenario: Wildcard domain does not match base domain

- **WHEN** a `HostMatcher` is constructed with `["*.corp.example.com"]`
- **AND** `matches("corp.example.com")` is called
- **THEN** it SHALL return `null`

#### Scenario: Wildcard domain matches deeply nested subdomain

- **WHEN** a `HostMatcher` is constructed with `["*.corp.example.com"]`
- **AND** `matches("a.b.c.corp.example.com")` is called
- **THEN** it SHALL return `"*.corp.example.com"`

#### Scenario: Bracketed IPv6 address is normalized

- **WHEN** a `HostMatcher` is constructed with `["::1"]`
- **AND** `matches("[::1]")` is called
- **THEN** it SHALL return `"::1"`

#### Scenario: Invalid specification throws at construction

- **WHEN** a `HostMatcher` is constructed with `["10.0.0.0/33"]`
- **THEN** the constructor SHALL throw an error indicating an invalid CIDR prefix length

#### Scenario: Empty matcher matches nothing

- **WHEN** a `HostMatcher` is constructed with `[]`
- **AND** `matches("anything")` is called
- **THEN** it SHALL return `null`

### Requirement: Hooked HTTP request APIs

The detector SHALL hook the following APIs in `setup()`:

- `http.request()` via `installHook("http", "request", ...)`
- `http.get()` via `installHook("http", "get", ...)`
- `https.request()` via `installHook("https", "request", ...)`
- `https.get()` via `installHook("https", "get", ...)`
- `globalThis.fetch` via direct replacement on `globalThis` (since `fetch` is not a module export in all Node versions)

All four `http`/`https` hooks require separate `installHook` calls because Node's `http.get()` calls a closure-captured local `request` function, not `module.exports.request` — patching the `request` export alone would not intercept `http.get()` calls. The separate hooks do not cause double-firing for the same reason: `http.get()` internally calls the original unpatched `request`, not the export.

The `fetch` wrapper SHALL use the module-hook stash helper (`stashAndRethrow`) when throwing a `VulnerabilityError`, so that findings swallowed by target try/catch are recoverable by `DetectorManager.endIteration()`. The `http`/`https` hooks use `installHook`, which handles stashing automatically.

Each hook SHALL extract the target hostname from the first argument, which can be:
- A **string URL**: Parse with `new URL(arg)` and extract `.hostname`.
- A **URL object**: Extract `.hostname` directly.
- An **options object**: Use `hostname` field, falling back to `host` field (stripping port if present). Port stripping SHALL be IPv6-aware: if the `host` value starts with `[`, extract the content between `[` and `]`; otherwise, find the last `:` and if the substring after it is all digits, take the substring before it.

For `http.request()` and `https.request()`, the first argument MAY be a URL (string or URL object) and the second argument MAY be an options object. If both are present, the options object fields override the URL fields (matching Node.js semantics). The hook SHALL resolve the effective hostname from the combined arguments.

If hostname extraction fails (no recognizable URL or options argument), the hook SHALL pass through without checking — malformed arguments will fail at the original function. If URL parsing throws (e.g., `new URL()` on a malformed string), the hook SHALL catch the parsing error and pass through to the original function without checking — the original function will produce its own error for invalid input.

`teardown()` SHALL restore all hooked functions to their originals.

#### Scenario: String URL argument to http.request

- **WHEN** the fuzz target calls `http.request("http://10.0.0.1/path")`
- **THEN** the hook SHALL extract hostname `"10.0.0.1"` and check it against the blocklist

#### Scenario: URL object argument to fetch

- **WHEN** the fuzz target calls `fetch(new URL("http://127.0.0.1/admin"))`
- **THEN** the hook SHALL extract hostname `"127.0.0.1"` and check it

#### Scenario: Options object argument to http.request

- **WHEN** the fuzz target calls `http.request({ hostname: "10.0.0.1", path: "/api" })`
- **THEN** the hook SHALL extract hostname `"10.0.0.1"` and check it

#### Scenario: Options with host field (IPv4 with port)

- **WHEN** the fuzz target calls `http.request({ host: "10.0.0.1:8080", path: "/api" })`
- **THEN** the hook SHALL extract hostname `"10.0.0.1"` (stripping port) and check it

#### Scenario: Options with host field (IPv6 with port)

- **WHEN** the fuzz target calls `http.request({ host: "[::1]:8080", path: "/api" })`
- **THEN** the hook SHALL extract hostname `"::1"` (stripping brackets and port) and check it

#### Scenario: URL + options object (options override)

- **WHEN** the fuzz target calls `http.request("http://example.com/path", { hostname: "10.0.0.1" })`
- **THEN** the hook SHALL use `"10.0.0.1"` from the options (override semantics)
- **AND** the detector SHALL throw a `VulnerabilityError`

#### Scenario: Unrecognizable argument passes through

- **WHEN** the fuzz target calls `http.request(42)` (invalid argument type)
- **THEN** the hook SHALL pass through to the original function without checking

#### Scenario: Malformed URL string passes through

- **WHEN** the fuzz target calls `http.request("not a valid url")`
- **AND** `new URL("not a valid url")` throws a `TypeError`
- **THEN** the hook SHALL catch the parsing error and pass through to the original function without checking the host

#### Scenario: Teardown restores all hooks

- **WHEN** `teardown()` is called on the SSRF detector
- **THEN** `http.request`, `http.get`, `https.request`, `https.get`, and `globalThis.fetch` SHALL be restored to their originals

### Requirement: SSRF dictionary tokens

The detector's `getTokens()` SHALL return:

Static tokens (always included when the SSRF detector is enabled):
- `"127.0.0.1"`
- `"0.0.0.0"`
- `"169.254.169.254"`
- `"10.0.0.1"`
- `"192.168.0.1"`
- `"[::1]"`
- `"[fc00::1]"`
- `"[fe80::1]"`
- `"http://"`
- `"https://"`
- `"localhost"`
- `"metadata.google.internal"`

Config-dependent tokens:
- Each entry in `blockedHosts` SHALL be added as a raw dictionary token.
- For each `blockedHosts` entry that is a bare IP address or exact hostname (not a CIDR range or wildcard domain), the detector SHALL also generate full URL tokens by combining with scheme prefixes: `"http://<host>"` and `"https://<host>"`. An entry is classified as a CIDR range if it contains `/`, and as a wildcard domain if it starts with `*.`. All other entries are treated as bare IPs or exact hostnames. CIDR ranges and wildcard patterns are not valid hostnames and SHALL NOT generate URL-variant tokens.

#### Scenario: Default tokens include private IPs and schemes

- **WHEN** `getTokens()` is called with default configuration
- **THEN** the returned array SHALL contain `"127.0.0.1"`, `"169.254.169.254"`, `"http://"`, `"https://"`, and the other static tokens listed above

#### Scenario: Custom blockedHosts appear in tokens

- **WHEN** the detector is configured with `{ blockedHosts: ["meta.corp.example.com"] }`
- **THEN** `getTokens()` SHALL include `"meta.corp.example.com"`, `"http://meta.corp.example.com"`, and `"https://meta.corp.example.com"` in addition to the static tokens

### Requirement: SSRF VulnerabilityError context

The `VulnerabilityError` thrown by the SSRF detector SHALL include the following in its `context`:

- `function` (string): The API function that was called (e.g., `"http.request"`, `"fetch"`)
- `hostname` (string): The extracted hostname that triggered the detection
- `matchedRule` (string): The blocklist entry that matched (e.g., `"10.0.0.0/8"`, `"metadata.google.internal"`)
- `url` (string, if available): The full URL string if extractable from the arguments

#### Scenario: VulnerabilityError includes matched rule

- **WHEN** the fuzz target calls `fetch("http://10.50.0.1/api")`
- **AND** the host matches the built-in `10.0.0.0/8` rule
- **THEN** the error's `context.matchedRule` SHALL be `"10.0.0.0/8"`
- **AND** `context.hostname` SHALL be `"10.50.0.1"`

### Requirement: SSRF lifecycle hooks are no-ops

The `beforeIteration()`, `afterIteration()`, and `resetIteration()` methods SHALL be no-ops. The detector fires during target execution (inside the hook wrapper), not during post-execution checks.

#### Scenario: No-op lifecycle hooks

- **WHEN** `beforeIteration()` is called on the SSRF detector
- **THEN** no state SHALL be captured or modified
- **WHEN** `afterIteration()` is called on the SSRF detector
- **THEN** no checks SHALL be performed and no errors SHALL be thrown
