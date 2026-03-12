---
title: Detectors Reference
description: Complete reference for all built-in vulnerability detectors.
---

## DetectorsConfig

```ts
type DetectorsConfig = {
  prototypePollution?: boolean;
  commandInjection?: boolean;
  pathTraversal?: boolean | PathTraversalOptions;
  redos?: boolean | RedosOptions;
  ssrf?: boolean | SsrfOptions;
  unsafeEval?: boolean;
};
```

Set to `true` to enable with defaults, `false` to disable, or an options object to enable with custom configuration.

## Tier 1 (Enabled by Default)

### prototypePollution

Detects modifications to built-in JavaScript prototypes.

**How it works:** Snapshots all built-in prototypes (Object, Array, String, Number, Boolean, Function, RegExp, Date, Map, Set, WeakMap, WeakSet, Promise, Error, ArrayBuffer, Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, and subtypes) before each fuzzing iteration. After execution, diffs property descriptors to detect additions, modifications, or deletions.

**Tokens contributed:** `__proto__`, `constructor`, `prototype`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__`

**Options:** None

### commandInjection

Detects attacker-controlled strings reaching shell execution functions.

**How it works:** Hooks all `child_process` module functions (`exec`, `execSync`, `spawn`, `spawnSync`, `fork`, `execFile`, `execFileSync`). Checks if the goal string `vitiate_cmd_inject` appears in the command or arguments.

**Tokens contributed:** `vitiate_cmd_inject`, shell metacharacters (`;`, `|`, `` ` ``, `$()`, etc.)

**Options:** None

### pathTraversal

Detects file system access outside allowed directories.

**How it works:** Hooks `fs` and `fs/promises` functions (`readFile`, `readFileSync`, `writeFile`, `writeFileSync`, `mkdir`, `mkdirSync`, `unlink`, `unlinkSync`, `stat`, `statSync`, `access`, `accessSync`, `readdir`, `readdirSync`, `open`, `openSync`, `rename`, `renameSync`). Resolves paths and checks against deny/allow lists.

**Tokens contributed:** `../`, `../../`, `../../../`, `%2e%2e`, `%2f`, null byte, `/etc/passwd`, `/etc/shadow`

**Options:**

```ts
interface PathTraversalOptions {
  allowedPaths?: string[];  // Allowed path prefixes
  deniedPaths?: string[];   // Denied paths (checked before allowed)
}
```

Evaluation order: denied paths are checked first, then allowed paths, then default deny.

**Platform note:** Tier 2 (disabled by default) on Windows. Case-insensitive filesystem matching and cross-drive path resolution (e.g., `D:\` vs `\\?\`) make the default deny policy prone to false positives.

## Tier 2 (Disabled by Default)

### redos

Detects regular expressions with excessive execution time.

**How it works:** Hooks `RegExp.prototype` methods (`exec`, `test`) and `String.prototype` methods (`match`, `split`, `replace`, `replaceAll`, `search`, `matchAll`). Measures wall-clock time per call.

**Tokens contributed:** Repetition patterns (`aaaa...!`, `a]a]a]...!`, tab/space sequences)

**Options:**

```ts
interface RedosOptions {
  thresholdMs?: number;  // Maximum allowed time per regex call (default: 100)
}
```


### ssrf

Detects HTTP requests to internal or private network addresses.

**How it works:** Hooks `http.request`, `https.request`, and `fetch`. Checks request targets against a built-in blocklist of private addresses and configurable host lists.

**Built-in blocklist:** `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `localhost`, `metadata.google.internal`, `169.254.169.254`

**Tokens contributed:** `127.0.0.1`, `localhost`, `169.254.169.254`, `10.0.0.1`, `metadata.google.internal`, `http://`, `https://`

**Options:**

```ts
interface SsrfOptions {
  blockedHosts?: string[];  // Additional hosts/CIDRs to block
  allowedHosts?: string[];  // Hosts to allow (overrides blocklist)
}
```

### unsafeEval

Detects attacker-controlled strings evaluated as code.

**How it works:** Hooks `eval()`, `Function` constructor, `setTimeout` and `setInterval` with string arguments. Checks if the goal string `vitiate_eval_inject` appears in the evaluated code.

**Tokens contributed:** `vitiate_eval_inject`, `require(`, `process.exit(`, `import(`

**Options:** None

## CLI Detector Syntax

```bash
# Enable specific detectors (all defaults off)
-detectors prototypePollution,commandInjection

# With options (dot notation, colon-separated values)
-detectors pathTraversal.deniedPaths=/etc/passwd:/etc/shadow
-detectors ssrf.blockedHosts=10.0.0.0/8:172.16.0.0/12
-detectors redos.thresholdMs=200
```
