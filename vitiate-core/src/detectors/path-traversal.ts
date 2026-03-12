/**
 * Path traversal detector: hooks fs and fs/promises module functions and checks
 * whether resolved path arguments violate a configured access policy.
 *
 * Policy evaluation: denied > allowed > deny.
 */
import { createRequire } from "node:module";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { type Detector, VulnerabilityError } from "./types.js";
import { installHook, type ModuleHook } from "./module-hook.js";

const require = createRequire(import.meta.url);

const ENCODER = new TextEncoder();

const IS_WINDOWS = process.platform === "win32";

/**
 * Normalize a resolved path for comparison. On Windows, lowercases the
 * path because the filesystem is case-insensitive but path.resolve()
 * preserves the original casing.
 */
function normalizePath(resolved: string): string {
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/** Functions where the first argument is a path. */
const SINGLE_PATH_FUNCTIONS = [
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "open",
  "openSync",
  "access",
  "accessSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readdir",
  "readdirSync",
  "unlink",
  "unlinkSync",
  "rmdir",
  "rmdirSync",
  "mkdir",
  "mkdirSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "rm",
  "rmSync",
  "createReadStream",
  "createWriteStream",
  "opendirSync",
  "opendir",
  "watch",
  "watchFile",
];

/** Functions where the first two arguments are paths. */
const DUAL_PATH_FUNCTIONS = [
  "copyFile",
  "copyFileSync",
  "rename",
  "renameSync",
  "link",
  "linkSync",
  "symlink",
  "symlinkSync",
];

/** Static traversal tokens always included. */
const STATIC_TOKENS = [
  "../",
  "../../",
  "../../../",
  "..\\",
  "\x00",
  "%2e%2e%2f",
  "%2e%2e/",
  "..%2f",
];

export class PathTraversalDetector implements Detector {
  readonly name = "path-traversal";
  readonly tier = 1 as const;

  private readonly resolvedAllowedPaths: string[];
  private readonly resolvedDeniedPaths: string[];
  private hooks: ModuleHook[] = [];

  constructor(
    allowedPaths?: string | string[],
    deniedPaths?: string | string[],
  ) {
    const normalizedAllowed =
      typeof allowedPaths === "string"
        ? [allowedPaths]
        : (allowedPaths ?? ["/"]);
    const defaultDenied =
      process.platform === "win32"
        ? ["C:\\Windows\\System32\\drivers\\etc\\hosts"]
        : ["/etc/passwd"];
    const normalizedDenied =
      typeof deniedPaths === "string"
        ? [deniedPaths]
        : (deniedPaths ?? defaultDenied);
    this.resolvedAllowedPaths = normalizedAllowed.map((p) =>
      normalizePath(nodePath.resolve(p)),
    );
    this.resolvedDeniedPaths = normalizedDenied.map((p) =>
      normalizePath(nodePath.resolve(p)),
    );
  }

  getTokens(): Uint8Array[] {
    const tokens = STATIC_TOKENS.map((t) => ENCODER.encode(t));

    for (const denied of this.resolvedDeniedPaths) {
      tokens.push(ENCODER.encode(denied));
    }

    return tokens;
  }

  setup(): void {
    this.installModuleHooks("fs");
    this.installModuleHooks("fs/promises");
  }

  private installModuleHooks(moduleSpecifier: string): void {
    // Determine which functions exist on the module (fs/promises
    // lacks sync variants; use runtime check rather than hardcoded list).
    const mod = require(moduleSpecifier) as Record<string, unknown>;

    for (const fn of SINGLE_PATH_FUNCTIONS) {
      if (typeof mod[fn] !== "function") continue;
      this.hooks.push(
        installHook(moduleSpecifier, fn, (...args: unknown[]) => {
          this.checkPath(args[0], fn, "path");
        }),
      );
    }

    for (const fn of DUAL_PATH_FUNCTIONS) {
      if (typeof mod[fn] !== "function") continue;
      this.hooks.push(
        installHook(moduleSpecifier, fn, (...args: unknown[]) => {
          this.checkPath(args[0], fn, "source");
          this.checkPath(args[1], fn, "destination");
        }),
      );
    }
  }

  beforeIteration(): void {
    // No-op: module-hook detector.
  }

  afterIteration(): void {
    // No-op: module-hook detector.
  }

  resetIteration(): void {
    // No-op: module-hook detector has no per-iteration state.
  }

  teardown(): void {
    for (const hook of this.hooks) {
      hook.restore();
    }
    this.hooks = [];
  }

  /**
   * Check a path argument against the access policy.
   * Throws VulnerabilityError if the path is denied.
   */
  private checkPath(
    pathArg: unknown,
    functionName: string,
    argumentName: string,
  ): void {
    if (
      typeof pathArg !== "string" &&
      !Buffer.isBuffer(pathArg) &&
      !(pathArg instanceof URL)
    ) {
      return;
    }

    let pathStr: string;
    if (pathArg instanceof URL) {
      // Node.js fs functions accept file: URLs - extract the pathname.
      pathStr = fileURLToPath(pathArg);
    } else if (typeof pathArg === "string") {
      pathStr = pathArg;
    } else {
      pathStr = pathArg.toString();
    }

    // Null byte detection - always deny before policy evaluation.
    if (pathStr.includes("\x00")) {
      throw new VulnerabilityError(this.name, "Path Traversal", {
        function: functionName,
        argument: argumentName,
        path: pathStr,
        nullByte: true,
      });
    }

    const resolved = normalizePath(nodePath.resolve(pathStr));

    // Policy evaluation: denied > allowed > deny.
    for (const denied of this.resolvedDeniedPaths) {
      if (this.matchesEntry(resolved, denied)) {
        throw new VulnerabilityError(this.name, "Path Traversal", {
          function: functionName,
          argument: argumentName,
          path: pathStr,
          resolvedPath: resolved,
          deniedEntry: denied,
        });
      }
    }

    for (const allowed of this.resolvedAllowedPaths) {
      if (this.matchesEntry(resolved, allowed)) {
        return; // Path is allowed.
      }
    }

    // Not in any allowed path - deny.
    throw new VulnerabilityError(this.name, "Path Traversal", {
      function: functionName,
      argument: argumentName,
      path: pathStr,
      resolvedPath: resolved,
    });
  }

  /** Separator-aware prefix match: exact or starts with entry + path.sep. */
  private matchesEntry(resolved: string, entry: string): boolean {
    if (resolved === entry) return true;
    // Root paths (/ on POSIX, C:\ on Windows) are prefixes of all absolute paths.
    if (entry === nodePath.parse(entry).root && entry.length > 0) {
      return resolved.startsWith(entry);
    }
    return resolved.startsWith(entry + nodePath.sep);
  }
}
