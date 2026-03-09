## Context

The path traversal detector currently uses a single `sandboxRoot` (default: `process.cwd()`) to define the boundary. Any resolved path outside this root is flagged. This has two problems: (1) `cwd` as default produces false positives when targets legitimately read files outside the project directory, and (2) there's no way to express "allow `/tmp` but deny `/tmp/secrets`" — you get a single boundary with no overrides.

The token set is also coupled to the sandbox path (includes the root itself and a depth-computed `../` chain), which seeds the dictionary with environment-specific strings rather than generic attack payloads.

Additionally, `fs/promises` is not hooked, so `import { readFile } from "fs/promises"` bypasses detection. The hook plugin's import bail-out check (`code.includes("fs")`) matches any source containing "fs" anywhere, making the optimization a no-op.

## Goals / Non-Goals

**Goals:**
- Policy-based path access control with two lists: denied > allowed priority
- Zero-config default that demonstrates path traversal with no false positives
- Hook `fs/promises` alongside `fs` for complete coverage
- Generic token set that works regardless of the fuzzer's own filesystem layout
- Fix the plugin bail-out check to actually skip files that don't import hooked modules
- Detector example and test coverage for path traversal

**Non-Goals:**
- SSRF detector implementation (will follow a similar pattern later)
- Separately hooking `fs.promises.*` property chain (unnecessary — `fs.promises` is the same object as `require("fs/promises")`, so hooking the latter covers both)
- Detecting accessor-based prototype pollution (documented trade-off, not part of this change)
- Addressing the module-hook try/catch swallowing limitation (fundamental to the approach)

## Decisions

### 1. Two-list policy: denied > allowed, no sandboxRoot

The check resolves the path to an absolute path, then evaluates in priority order:
1. Matches any `deniedPaths` entry (separator-aware prefix) → **deny** (throw VulnerabilityError)
2. Matches any `allowedPaths` entry (separator-aware prefix) → **allow** (pass through)
3. Otherwise → **deny**

`sandboxRoot` is dropped entirely — it is equivalent to a single `allowedPaths` entry and adds a redundant concept. The default `allowedPaths: ["/"]` provides the same "allow everything" semantics that `sandboxRoot: "/"` would have.

Two flat lists with deny > allow priority cover all realistic fuzzer policies: strict sandbox (`allowedPaths: ["/var/www"]`), sandbox with exceptions (`allowedPaths: ["/var/www", "/tmp"]`, `deniedPaths: ["/tmp/secrets"]`), and the default open-with-sentinels policy. The one limitation — you can't re-allow under a denied prefix — is a theoretical concern for firewall-style rule sets, not fuzzer detectors.

### 2. Defaults: allowedPaths: ["/"], deniedPaths: ["/etc/passwd"]

With `allowedPaths: ["/"]`, the default policy allows all paths except those explicitly denied. The default `deniedPaths: ["/etc/passwd"]` catches the canonical path traversal payload with essentially zero false positive risk — no legitimate application reads `/etc/passwd`.

**Why not cwd:** `cwd` as default means any target that reads a config file from `/etc/`, a temp file from `/tmp/`, or a system library produces a false positive. The fuzzer should detect *exploitable* traversals, not every out-of-project read.

**Why `/etc/passwd` specifically:** It's the canonical path traversal target across security tooling. The fuzzer needs to construct a path that resolves there, which requires actual traversal sequences — not just any random path.

### 3. Separator-aware prefix matching on resolved absolute paths

Both `allowedPaths` and `deniedPaths` entries are resolved to absolute paths at construction time. Runtime path checks resolve the argument, then compare using `resolved === entry || resolved.startsWith(entry + path.sep)`. This prevents prefix false positives (e.g., `/etc/passwdx` does not match `/etc/passwd`) and naturally handles both files (effectively exact match, since nothing lives "under" a file) and directories (subtree match).

### 4. Token set: generic traversal + deniedPaths entries

Tokens:
- Static traversal: `../`, `../../`, `../../../`, `..\\`, `\x00`, URL-encoded variants
- All resolved `deniedPaths` entries (e.g., `/etc/passwd`)

Pre-chained traversal tokens (`../../`, `../../../`) are included alongside the single `../` because byte-level mutation is unlikely to splice two `../` tokens at exactly the right byte boundary. Having depth 2-3 as single tokens dramatically improves time-to-first-finding, and the dictionary cost is negligible.

**Why remove sandbox-dependent tokens:** The depth-computed `../` chain (e.g., `../../../../etc/passwd` for a 4-deep sandbox) couples the dictionary to the fuzzer's environment. The mutator should discover the right chain length through composition of `../` tokens — that's what coverage-guided mutation is for.

### 5. Hook `fs/promises` via the same `installHook` mechanism

`require("fs/promises")` returns a separate module object from `require("fs")`. Both must be hooked independently. The same `SINGLE_PATH_FUNCTIONS` and `DUAL_PATH_FUNCTIONS` lists apply (the `fs/promises` module exports the same function names as promise-returning variants).

`installHook` already accepts a module specifier string, so this is just a second pass through the same loop with `"fs/promises"` instead of `"fs"`.

### 6. Plugin bail-out: use import-statement-shaped patterns

Replace `code.includes("fs")` with patterns that match how `fs` appears in import/require statements: check for `"fs"` (with quotes), `'fs'`, `fs/promises`, or `from "fs"`. This still has some false positive potential (e.g., a string literal `"fs"` in non-import context) but dramatically reduces unnecessary parsing compared to matching bare `fs` in any identifier.

**Alternative considered:** Using a regex like `/\bfs\b/`. Rejected because `\b` would still match variable names like `const fs = ...` which is common. The quoted-string check targets import statements more precisely.

**Alternative considered:** Removing the bail-out entirely. Rejected because `es-module-lexer` parsing has measurable cost and most source files don't import `fs` or `child_process`.

### 7. Detector example: `read` command with `/etc/passwd` sentinel

Add a `read` case to `process-input.ts` that calls `fs.readFileSync()` when the argument equals a sentinel path. Gate with strict `===` equality for CmpLog guidance, matching the pattern used by the existing `exec` case.

The sentinel path should be `/etc/passwd` to align with the default `deniedPaths`. The detector hook intercepts and throws before the read occurs.

## Risks / Trade-offs

- **[Breaking config change]** The `sandboxRoot` option is removed. Existing configs using `sandboxRoot` will fail validation. Users must migrate to `allowedPaths: ["/var/www"]` instead of `sandboxRoot: "/var/www"`. → Acceptable since the feature is new and has no established user base yet.

- **[Less restrictive default]** The default changes from cwd-based enforcement to allow-all with only `/etc/passwd` denied. Targets that previously triggered on cwd escape will no longer trigger unless the accessed path is in `deniedPaths`. → Intentional: the old default produced false positives, and users who want strict sandboxing can configure `allowedPaths` explicitly.

- **[Prefix matching granularity]** Prefix matching means `deniedPaths: ["/etc"]` blocks `/etc/hostname`, `/etc/resolv.conf`, etc. Users must be precise with denied entries. → Separator-aware matching mitigates the worst cases (no `/etcx` false positives), and the default uses a specific file path.

- **[fs/promises hook coverage]** The `fs/promises` hooks only work for code loaded via `require("fs/promises")` (CJS) or code that's been rewritten by the plugin's import rewriter. Pure ESM code that hasn't been transformed will bind directly to the module and won't see our hooks. → This is the same limitation as the existing `fs` hooks and is mitigated by the plugin's import rewriting in `plugin.ts`.
